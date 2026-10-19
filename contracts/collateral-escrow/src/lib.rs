#![no_std]
//! Collateral escrow for dfToken-backed USDC credit (Stage B).
//!
//! A borrower locks DeFindex vault share tokens (dfTokens) as collateral; the treasury disburses
//! USDC against them. The contract holds collateral + loan state and enforces state transitions.
//! It never prices anything on-chain: partial release and liquidation require a short-lived
//! ed25519 attestation signed by the off-chain engine (loan id, kind, seq, expiry, amount).
//!
//! Safety properties: pause blocks only new deposits (withdraw/close/release always work); there is
//! no admin sweep; full repayment (`close`) needs no engine signature, so a borrower can always exit.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, token, Address, Bytes,
    BytesN, Env,
};

const RELEASE: u8 = 1;
const LIQUIDATE: u8 = 2;
const MARGIN: u8 = 3;
const SECONDS_PER_YEAR: u64 = 31_536_000;

// Persistent loan entries live ~60 days and are bumped on write; anyone may extend via `bump`.
const LOAN_TTL: u32 = 60 * 24 * 60 * 60 / 5; // ledgers (~5s each)
const LOAN_BUMP_THRESHOLD: u32 = 30 * 24 * 60 * 60 / 5;

// Liquidation economics: on top of seizing enough collateral to cover the debt, the treasury keeps a
// substantial liquidation penalty (and an extra late-payment penalty if the loan is past maturity).
// Only the collateral left after debt + penalties is returned to the borrower.
const LIQUIDATION_FEE_BPS: i128 = 1_000; // 10% of the amount liquidated
const LATE_FEE_BPS: i128 = 500; // +5% when liquidated after maturity

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Paused = 3,
    AssetNotAllowed = 4,
    LoanExists = 5,
    LoanMissing = 6,
    BadAmount = 7,
    BadStatus = 8,
    StaleSeq = 9,
    Expired = 10,
    TooMuch = 11,
    StillOwing = 12,
}

#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Structure {
    OpenEnded,
    FixedTerm,
}

#[contracttype]
#[derive(Clone, PartialEq, Debug)]
pub enum LoanStatus {
    Open,            // collateral deposited, not yet funded
    Active,          // USDC disbursed, debt outstanding
    MarginCall(u64), // deadline to cure (ledger timestamp)
    Closed,          // repaid in full, collateral returned
    Liquidated,
}

#[contracttype]
#[derive(Clone)]
pub struct Loan {
    pub borrower: Address,
    pub collateral_token: Address,
    pub collateral_amount: i128,
    pub principal: i128,
    pub apr_bps: u32,
    pub structure: Structure,
    pub term_days: u32,
    pub start: u64,
    pub maturity: u64,
    pub debt: i128,
    pub status: LoanStatus,
    pub last_seq: u64,
}

#[contracttype]
pub enum DataKey {
    Admin,
    Engine,
    Treasury,
    Usdc,
    Paused,
    Asset(Address),
    Loan(BytesN<32>),
}

#[contract]
pub struct CollateralEscrow;

#[contractimpl]
impl CollateralEscrow {
    /// One-time setup. `engine_key` is the ed25519 public key whose attestations the contract trusts.
    /// `usdc` is the token disbursed to borrowers and tracked for repayment.
    pub fn initialize(env: Env, admin: Address, engine_key: BytesN<32>, treasury: Address, usdc: Address) {
        let s = env.storage().instance();
        if s.has(&DataKey::Admin) {
            panic_with_error!(&env, Error::AlreadyInitialized);
        }
        s.set(&DataKey::Admin, &admin);
        s.set(&DataKey::Engine, &engine_key);
        s.set(&DataKey::Treasury, &treasury);
        s.set(&DataKey::Usdc, &usdc);
        s.set(&DataKey::Paused, &false);
    }

    // ---- admin ----
    pub fn set_asset(env: Env, token: Address, allowed: bool) {
        Self::admin(&env).require_auth();
        env.storage().instance().set(&DataKey::Asset(token), &allowed);
    }
    pub fn set_engine_key(env: Env, engine_key: BytesN<32>) {
        Self::admin(&env).require_auth();
        env.storage().instance().set(&DataKey::Engine, &engine_key);
    }
    pub fn set_treasury(env: Env, treasury: Address) {
        Self::admin(&env).require_auth();
        env.storage().instance().set(&DataKey::Treasury, &treasury);
    }
    pub fn pause(env: Env, paused: bool) {
        Self::admin(&env).require_auth();
        env.storage().instance().set(&DataKey::Paused, &paused);
    }
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        Self::admin(&env).require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    // ---- borrower: deposit collateral + record terms (consent) ----
    #[allow(clippy::too_many_arguments)]
    pub fn deposit(
        env: Env,
        loan_id: BytesN<32>,
        borrower: Address,
        collateral_token: Address,
        collateral_amount: i128,
        principal: i128,
        apr_bps: u32,
        structure: Structure,
        term_days: u32,
    ) {
        borrower.require_auth();
        if Self::paused(&env) {
            panic_with_error!(&env, Error::Paused);
        }
        if !Self::asset_allowed(&env, &collateral_token) {
            panic_with_error!(&env, Error::AssetNotAllowed);
        }
        if collateral_amount <= 0 || principal <= 0 {
            panic_with_error!(&env, Error::BadAmount);
        }
        if env.storage().persistent().has(&DataKey::Loan(loan_id.clone())) {
            panic_with_error!(&env, Error::LoanExists);
        }
        // Pull the collateral in (dfToken is a standard transferable SEP-41 token).
        token::TokenClient::new(&env, &collateral_token).transfer(
            &borrower,
            &env.current_contract_address(),
            &collateral_amount,
        );
        let loan = Loan {
            borrower: borrower.clone(),
            collateral_token,
            collateral_amount,
            principal,
            apr_bps,
            structure,
            term_days,
            start: 0,
            maturity: 0,
            debt: 0,
            status: LoanStatus::Open,
            last_seq: 0,
        };
        Self::put_loan(&env, &loan_id, &loan);
        env.events().publish((DEPOSIT, borrower), (loan_id, collateral_amount, principal));
    }

    /// Borrower can pull collateral back only while the loan is unfunded (Open).
    pub fn withdraw(env: Env, loan_id: BytesN<32>) {
        let loan = Self::loan(&env, &loan_id);
        loan.borrower.require_auth();
        if loan.status != LoanStatus::Open {
            panic_with_error!(&env, Error::BadStatus);
        }
        token::TokenClient::new(&env, &loan.collateral_token).transfer(
            &env.current_contract_address(),
            &loan.borrower,
            &loan.collateral_amount,
        );
        env.storage().persistent().remove(&DataKey::Loan(loan_id.clone()));
        env.events().publish((WITHDRAW, loan.borrower), loan_id);
    }

    /// Treasury funds the loan: transfers USDC to the borrower and activates the loan.
    pub fn disburse(env: Env, loan_id: BytesN<32>) {
        let treasury = Self::treasury(&env);
        treasury.require_auth();
        let mut loan = Self::loan(&env, &loan_id);
        if loan.status != LoanStatus::Open {
            panic_with_error!(&env, Error::BadStatus);
        }
        let now = env.ledger().timestamp();
        loan.start = now;
        loan.maturity = if loan.structure == Structure::FixedTerm {
            now + (loan.term_days as u64) * 86400
        } else {
            0
        };
        loan.debt = loan.principal;
        loan.status = LoanStatus::Active;
        token::TokenClient::new(&env, &Self::usdc(&env)).transfer(
            &treasury,
            &loan.borrower,
            &loan.principal,
        );
        Self::put_loan(&env, &loan_id, &loan);
        env.events().publish((DISBURSE, loan.borrower), (loan_id, loan.principal));
    }

    /// Treasury records repayment (debt decreases only). The USDC repayment itself is handled
    /// treasury-side; this is the on-chain debt record.
    pub fn record_repayment(env: Env, loan_id: BytesN<32>, amount: i128) {
        Self::treasury(&env).require_auth();
        if amount <= 0 {
            panic_with_error!(&env, Error::BadAmount);
        }
        let mut loan = Self::loan(&env, &loan_id);
        if !Self::is_live(&loan) {
            panic_with_error!(&env, Error::BadStatus);
        }
        loan.debt = if amount >= loan.debt { 0 } else { loan.debt - amount };
        // Repaying enough cures a margin call.
        if loan.debt < loan.principal {
            if let LoanStatus::MarginCall(_) = loan.status {
                loan.status = LoanStatus::Active;
            }
        }
        Self::put_loan(&env, &loan_id, &loan);
        env.events().publish((REPAY, loan.borrower.clone()), (loan_id, amount, loan.debt));
    }

    /// Borrower repays directly: pulls `amount` (capped at the outstanding debt) from the borrower to
    /// the treasury and reduces the debt in one borrower-authorized call. Self-service counterpart to
    /// `record_repayment`; once this zeroes the debt the borrower can `close` and reclaim collateral.
    pub fn repay(env: Env, loan_id: BytesN<32>, amount: i128) {
        let mut loan = Self::loan(&env, &loan_id);
        loan.borrower.require_auth();
        if amount <= 0 {
            panic_with_error!(&env, Error::BadAmount);
        }
        if !Self::is_live(&loan) {
            panic_with_error!(&env, Error::BadStatus);
        }
        let now = env.ledger().timestamp();
        let interest = Self::accrued(&loan, now);
        let payoff = loan.debt + interest;
        let pay = if amount > payoff { payoff } else { amount };
        if pay > 0 {
            token::TokenClient::new(&env, &Self::usdc(&env)).transfer(
                &loan.borrower,
                &Self::treasury(&env),
                &pay,
            );
            // Interest first, then principal.
            let principal_paid = if pay > interest { pay - interest } else { 0 };
            loan.debt -= principal_paid;
        }
        // Reset the accrual clock: remaining principal accrues (simple interest) from now.
        loan.start = now;
        // Repaying enough cures a margin call.
        if loan.debt < loan.principal {
            if let LoanStatus::MarginCall(_) = loan.status {
                loan.status = LoanStatus::Active;
            }
        }
        Self::put_loan(&env, &loan_id, &loan);
        env.events().publish((REPAY, loan.borrower.clone()), (loan_id, pay, loan.debt));
    }

    /// Current full payoff = outstanding principal debt + simple interest accrued since `start`.
    /// Off-chain callers read this to show / pre-fill the repayment value; `repay` uses the same math.
    pub fn payoff(env: Env, loan_id: BytesN<32>) -> i128 {
        let loan = Self::loan(&env, &loan_id);
        loan.debt + Self::accrued(&loan, env.ledger().timestamp())
    }

    /// Full-repayment exit: returns all collateral to the borrower. Needs no engine signature.
    pub fn close(env: Env, loan_id: BytesN<32>) {
        let mut loan = Self::loan(&env, &loan_id);
        loan.borrower.require_auth();
        if loan.debt > 0 {
            panic_with_error!(&env, Error::StillOwing);
        }
        if loan.collateral_amount > 0 {
            token::TokenClient::new(&env, &loan.collateral_token).transfer(
                &env.current_contract_address(),
                &loan.borrower,
                &loan.collateral_amount,
            );
        }
        loan.collateral_amount = 0;
        loan.status = LoanStatus::Closed;
        Self::put_loan(&env, &loan_id, &loan);
        env.events().publish((CLOSE, loan.borrower.clone()), loan_id);
    }

    /// Partial collateral release, authorized by a fresh engine attestation (debt shrank / value rose).
    pub fn release(env: Env, loan_id: BytesN<32>, amount: i128, seq: u64, expiry: u64, signature: BytesN<64>) {
        let mut loan = Self::loan(&env, &loan_id);
        if !Self::is_live(&loan) {
            panic_with_error!(&env, Error::BadStatus);
        }
        Self::verify(&env, &loan_id, RELEASE, seq, expiry, amount, &signature, &mut loan);
        if amount <= 0 || amount > loan.collateral_amount {
            panic_with_error!(&env, Error::TooMuch);
        }
        token::TokenClient::new(&env, &loan.collateral_token).transfer(
            &env.current_contract_address(),
            &loan.borrower,
            &amount,
        );
        loan.collateral_amount -= amount;
        Self::put_loan(&env, &loan_id, &loan);
        env.events().publish((RELEASE_EV, loan.borrower.clone()), (loan_id, amount));
    }

    /// Flag a loan for margin call (relayable: anyone can submit a valid engine attestation).
    pub fn margin_call(env: Env, loan_id: BytesN<32>, deadline: u64, seq: u64, expiry: u64, signature: BytesN<64>) {
        let mut loan = Self::loan(&env, &loan_id);
        if !Self::is_live(&loan) {
            panic_with_error!(&env, Error::BadStatus);
        }
        Self::verify(&env, &loan_id, MARGIN, seq, expiry, deadline as i128, &signature, &mut loan);
        loan.status = LoanStatus::MarginCall(deadline);
        Self::put_loan(&env, &loan_id, &loan);
        env.events().publish((MARGIN_EV, loan.borrower.clone()), (loan_id, deadline));
    }

    /// Treasury liquidates with a fresh engine attestation: seize `seize_amount` to treasury, return
    /// any surplus collateral to the borrower, in the same call.
    pub fn liquidate(env: Env, loan_id: BytesN<32>, seize_amount: i128, seq: u64, expiry: u64, signature: BytesN<64>) {
        let treasury = Self::treasury(&env);
        treasury.require_auth();
        let mut loan = Self::loan(&env, &loan_id);
        if !Self::is_live(&loan) {
            panic_with_error!(&env, Error::BadStatus);
        }
        Self::verify(&env, &loan_id, LIQUIDATE, seq, expiry, seize_amount, &signature, &mut loan);
        if seize_amount <= 0 || seize_amount > loan.collateral_amount {
            panic_with_error!(&env, Error::TooMuch);
        }
        // `seize_amount` (engine-signed) covers the debt. On top of that the treasury keeps a
        // liquidation penalty, plus a late penalty if the loan is past maturity — both substantial, so
        // being liquidated is never cheaper than repaying. The borrower gets only what's left.
        let is_late = loan.maturity > 0 && env.ledger().timestamp() > loan.maturity;
        let fee_bps = LIQUIDATION_FEE_BPS + if is_late { LATE_FEE_BPS } else { 0 };
        let penalty = seize_amount * fee_bps / 10_000;
        let mut to_treasury = seize_amount + penalty;
        if to_treasury > loan.collateral_amount {
            to_treasury = loan.collateral_amount; // never seize more collateral than exists
        }
        let surplus = loan.collateral_amount - to_treasury;

        let client = token::TokenClient::new(&env, &loan.collateral_token);
        client.transfer(&env.current_contract_address(), &treasury, &to_treasury);
        if surplus > 0 {
            client.transfer(&env.current_contract_address(), &loan.borrower, &surplus);
        }
        loan.collateral_amount = 0;
        loan.debt = 0;
        loan.status = LoanStatus::Liquidated;
        Self::put_loan(&env, &loan_id, &loan);
        env.events().publish((LIQUIDATE_EV, loan.borrower.clone()), (loan_id, to_treasury, penalty, surplus));
    }

    // ---- views ----
    pub fn get_loan(env: Env, loan_id: BytesN<32>) -> Loan {
        Self::loan(&env, &loan_id)
    }
    pub fn bump(env: Env, loan_id: BytesN<32>) {
        let key = DataKey::Loan(loan_id);
        if env.storage().persistent().has(&key) {
            env.storage().persistent().extend_ttl(&key, LOAN_BUMP_THRESHOLD, LOAN_TTL);
        }
    }

    // ---- internals ----
    fn admin(env: &Env) -> Address {
        env.storage().instance().get(&DataKey::Admin).unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized))
    }
    fn treasury(env: &Env) -> Address {
        env.storage().instance().get(&DataKey::Treasury).unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized))
    }
    fn usdc(env: &Env) -> Address {
        env.storage().instance().get(&DataKey::Usdc).unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized))
    }
    fn paused(env: &Env) -> bool {
        env.storage().instance().get(&DataKey::Paused).unwrap_or(false)
    }
    fn asset_allowed(env: &Env, token: &Address) -> bool {
        env.storage().instance().get(&DataKey::Asset(token.clone())).unwrap_or(false)
    }
    fn loan(env: &Env, loan_id: &BytesN<32>) -> Loan {
        env.storage().persistent().get(&DataKey::Loan(loan_id.clone())).unwrap_or_else(|| panic_with_error!(env, Error::LoanMissing))
    }
    fn put_loan(env: &Env, loan_id: &BytesN<32>, loan: &Loan) {
        let key = DataKey::Loan(loan_id.clone());
        env.storage().persistent().set(&key, loan);
        env.storage().persistent().extend_ttl(&key, LOAN_BUMP_THRESHOLD, LOAN_TTL);
    }
    fn is_live(loan: &Loan) -> bool {
        matches!(loan.status, LoanStatus::Active | LoanStatus::MarginCall(_))
    }

    /// Simple interest accrued on the outstanding debt since `start`:
    /// debt * apr_bps * elapsed_seconds / (10_000 * seconds_per_year). Zero before funding.
    fn accrued(loan: &Loan, now: u64) -> i128 {
        if loan.debt <= 0 || loan.start == 0 || now <= loan.start {
            return 0;
        }
        let elapsed = (now - loan.start) as i128;
        loan.debt * (loan.apr_bps as i128) * elapsed / (10_000i128 * SECONDS_PER_YEAR as i128)
    }

    /// Verify a fresh engine attestation and advance the loan's replay sequence.
    fn verify(env: &Env, loan_id: &BytesN<32>, kind: u8, seq: u64, expiry: u64, amount: i128, signature: &BytesN<64>, loan: &mut Loan) {
        if seq <= loan.last_seq {
            panic_with_error!(env, Error::StaleSeq);
        }
        if env.ledger().timestamp() > expiry {
            panic_with_error!(env, Error::Expired);
        }
        let engine: BytesN<32> = env.storage().instance().get(&DataKey::Engine).unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized));
        let msg = attestation_message(env, loan_id, kind, seq, expiry, amount);
        env.crypto().ed25519_verify(&engine, &msg, signature); // panics on mismatch
        loan.last_seq = seq;
    }
}

/// Canonical attestation payload the engine signs and the contract verifies:
/// loan_id(32) ++ kind(1) ++ seq(8 BE) ++ expiry(8 BE) ++ amount(16 BE, i128).
pub fn attestation_message(env: &Env, loan_id: &BytesN<32>, kind: u8, seq: u64, expiry: u64, amount: i128) -> Bytes {
    let mut m = Bytes::new(env);
    m.extend_from_array(&loan_id.to_array());
    m.extend_from_array(&[kind]);
    m.extend_from_array(&seq.to_be_bytes());
    m.extend_from_array(&expiry.to_be_bytes());
    m.extend_from_array(&amount.to_be_bytes());
    m
}

use soroban_sdk::symbol_short;
const DEPOSIT: soroban_sdk::Symbol = symbol_short!("deposit");
const WITHDRAW: soroban_sdk::Symbol = symbol_short!("withdraw");
const DISBURSE: soroban_sdk::Symbol = symbol_short!("disburse");
const REPAY: soroban_sdk::Symbol = symbol_short!("repay");
const CLOSE: soroban_sdk::Symbol = symbol_short!("close");
const RELEASE_EV: soroban_sdk::Symbol = symbol_short!("release");
const MARGIN_EV: soroban_sdk::Symbol = symbol_short!("margin");
const LIQUIDATE_EV: soroban_sdk::Symbol = symbol_short!("liquidate");

#[cfg(test)]
mod test;
