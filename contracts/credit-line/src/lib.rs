#![no_std]
//! LCRD Credit Line — Stellar/Soroban port of lcrd-arc-credit's `CreditLine.sol`.
//!
//! A USDC lending pool with credit lines priced on-chain from an LCRD credit score. Lenders deposit
//! USDC and receive pool shares (ERC-4626-style, with virtual shares/assets to blunt the first-depositor
//! inflation attack). LCRD scores a borrower off-chain (0-100); the underwriter submits that score and
//! the hash of the report, and the contract itself derives the risk tier, the APR and the maximum line
//! from LCRD's published policy, so every price can be checked by anyone with `quote`. Only the report
//! hash is stored, never personal data. Borrowers draw and repay in USDC; interest accrues by the second
//! and, once repaid, raises the value of every share; a written-off line lowers it.
//!
//! Secured lines need no score: any lender can borrow against their own pool shares, up to 71.25% of
//! their value, at LCRD's secured price. The shares backing a loan cannot be withdrawn until it is
//! repaid, and on default the underwriter settles the debt from them.
//!
//! Pricing (LCRD policy 2026-10), in basis points:
//!   unsecured APR = 800 cost of funds + score premium (2000 at score 0 → 300 at 100) + 300 surcharge
//!   + default/expected-loss premium (4100 at score 50 → 1200 at 100), − 50 bps per completed cycle
//!   (max 200), clamped to [600, 7000]; secured APR = 800 + 35% of the score premium − cycle discount.
//!   Tiers: A = 67-100, B = 34-66, C = 0-33. Unsecured needs score ≥ 50; the starter line is graded by
//!   score within the eligible band — tier B (50-66) $5→$25, tier A (67-100) $26→$50.
//!
//! Amounts are in USDC base units at **7 decimals** (Stellar USDC), as `i128`. Identity is the
//! borrower's own Stellar address — there is no cross-chain proof step (unlike the Arc/EVM original).

use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, token, vec,
    Address, BytesN, Env, IntoVal, Symbol, Val, Vec,
};

// ---- time / TTL ----
const YEAR: i128 = 31_536_000; // 365 days in seconds
const ENTRY_TTL: u32 = 60 * 24 * 60 * 60 / 5; // ~60 days in ledgers (~5s each)
const ENTRY_BUMP: u32 = 30 * 24 * 60 * 60 / 5;

// ---- LCRD pricing policy (fixed in code, so it can be verified off-chain) ----
pub const POLICY_VERSION: &str = "lcrd-unsecured-2026-10";
const BASE_BPS: i128 = 800; // cost of funds
const PREMIUM_AT_0_BPS: i128 = 2_000; // score-risk premium at score 0
const PREMIUM_AT_100_BPS: i128 = 300; // ... and at score 100
const UNSECURED_SURCHARGE_BPS: i128 = 300;
const MIN_APR_BPS: i128 = 600;
const MAX_APR_BPS: i128 = 7_000; // raised to let the default premium be priced in for risky cohorts
// Default/expected-loss premium (PD × LGD, LGD≈100% unsecured). Grounded in ~40% first-loan default
// rates seen on comparable unsecured crypto credit (e.g. Divine Research); priced highest for new,
// low-score borrowers and decaying as they prove repayment. This is what makes the pool solvent and
// the yield substantial: interest from the performing book covers the cohort that defaults.
// 41% PD at the minimum eligible score (50). Keeps the same ~57.5 bps/score-point risk slope as the
// old 35%@60 anchor, just extended down to the new floor: a score-50 borrower is riskier than the old
// score-60 floor and is priced for it, while the 60-100 cohort stays ~unchanged (PD@60 ≈ 35% still).
const DEFAULT_PD_AT_MIN_BPS: i128 = 4_100;
const DEFAULT_PD_AT_MAX_BPS: i128 = 1_200; // 12% PD at score 100
const DEFAULT_PD_CYCLE_RELIEF_BPS: i128 = 250; // each proven cycle cuts PD 2.5%
const DEFAULT_PD_FLOOR_BPS: i128 = 500; // 5% residual PD even for long-proven borrowers
const LATE_PENALTY_BPS: i128 = 1_200; // extra APR charged while a fixed-term line is past its due date
const DAY_SECONDS: u64 = 24 * 60 * 60;
const TIER_A_MIN_SCORE: u32 = 67;
const TIER_B_MIN_SCORE: u32 = 34;
const UNSECURED_MIN_SCORE: u32 = 50; // minimum score for any unsecured line

// 7-decimal USDC base units.
const USDC_ONE: i128 = 10_000_000;
// Starter line, graded by score (not a flat per-tier amount): the eligible band is split at the tier
// boundary so a higher score always earns a larger first line. Tier B (score 50-66) runs $5 -> $25;
// tier A (score 67-100) runs $26 -> $50. See `starter_limit`.
const STARTER_B_MIN_LIMIT: i128 = 5 * USDC_ONE; // tier B, at UNSECURED_MIN_SCORE (50)
const STARTER_B_MAX_LIMIT: i128 = 25 * USDC_ONE; // tier B, at the top of tier B (66)
const STARTER_A_MIN_LIMIT: i128 = 26 * USDC_ONE; // tier A, at TIER_A_MIN_SCORE (67)
const STARTER_A_MAX_LIMIT: i128 = 50 * USDC_ONE; // tier A, at score 100
const TIER_A_CEILING: i128 = 2_500 * USDC_ONE; // reachable through repayments
const TIER_B_CEILING: i128 = 250 * USDC_ONE;

const CYCLE_DISCOUNT_BPS: i128 = 50; // APR reduction per completed cycle
const MAX_CYCLE_DISCOUNT_BPS: i128 = 200;
const CYCLE_MIN_DURATION: u64 = 21 * 24 * 60 * 60; // 21 days held before a cycle counts
const CYCLE_MIN_USE_DIVISOR: i128 = 2; // must draw at least limit / 2 (50% utilization) at peak
const LADDER_MIN_INTERVAL: u64 = 30 * 24 * 60 * 60; // velocity cap: at most one ladder step per 30 days
const WRITEOFF_LADDER_PAUSE: u64 = 90 * 24 * 60 * 60; // ladder is frozen for 90 days after a write-off
const SECURED_ADVANCE_BPS: i128 = 7_125; // 95% after haircut × 75% advance
const SECURED_PREMIUM_SHARE_BPS: i128 = 3_500; // share of the score premium on secured credit

// Virtual shares and assets blunt the first-depositor share inflation attack.
const VIRTUAL_SHARES: i128 = 1_000_000;
const VIRTUAL_ASSETS: i128 = 1;

// ---- idle-capital yield (optional DeFindex vault) ----
// When a vault is configured, USDC the pool is not currently lending out is parked in a DeFindex
// vault so it earns yield for lenders. A buffer of raw USDC is kept on hand for instant draws and
// withdrawals; only the excess is invested, and the pool pulls back from the vault when the buffer
// runs short. The vault's share value carries the yield, so counting the pool's vault position in
// `cash` makes every lender share appreciate with it — no extra bookkeeping.
const DEFAULT_BUFFER_BPS: u32 = 1_000; // keep 10% of liquidity liquid; invest the other 90%
const BPS_DENOM: i128 = 10_000;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    NotOwner = 3,
    NotUnderwriter = 4,
    NotPendingOwner = 5,
    ZeroAmount = 6,
    ZeroAddress = 7,
    BadScore = 8,
    TierNotEligible = 9,
    LineInactive = 10,
    OverLimit = 11,
    InsufficientLiquidity = 12,
    InsufficientShares = 13,
    NothingOwed = 14,
    HasOpenLoan = 15,
    NoCollateral = 16,
    NotSecured = 17,
    CollateralLocked = 18,
    BadBuffer = 19,
    LinePastDue = 20,
}

/// A borrower's credit line.
#[contracttype]
#[derive(Clone)]
pub struct Line {
    pub limit: i128,           // max principal outstanding, USDC base units
    pub principal: i128,       // principal outstanding
    pub interest: i128,        // interest accrued and not yet repaid
    pub apr_bps: u32,          // simple annual rate, bps, derived from the score
    pub tier: u32,             // LCRD risk tier: 1 = A, 2 = B, 3 = C
    pub score: u32,            // LCRD credit score 0-100 (0 on a secured line with no score)
    pub secured: bool,         // backed by the borrower's own pool shares
    pub active: bool,          // can draw; repayments are always accepted
    pub last_accrued: u64,     // timestamp of the last accrual (0 = never touched)
    pub score_ref: BytesN<32>, // hash of the off-chain score report backing this line
    pub term_days: u32,        // fixed term in days (0 = open-ended / revolving)
    pub due_at: u64,           // repayment due timestamp (0 = no due date)
}

/// Repayment record, per borrower. Survives line updates; reset only by a write-off.
#[contracttype]
#[derive(Clone)]
pub struct History {
    pub repayments: u32,       // number of repayments made
    pub cycles_completed: u32, // qualifying loans repaid in full
    pub write_offs: u32,       // lines written off
    pub first_borrow_at: u64,  // first ever draw
    pub last_repaid_at: u64,   // most recent repayment
    pub cycle_start: u64,      // when the current loan started (0 = no open loan)
    pub cycle_peak: i128,      // largest principal during the current loan
    pub total_borrowed: i128,  // lifetime principal drawn
    pub total_repaid: i128,    // lifetime principal + interest repaid
    pub last_laddered_at: u64, // last time a cycle raised the limit (velocity cap)
    pub last_writeoff_at: u64, // last write-off/seizure (ladder pauses after one)
}

#[contracttype]
pub enum DataKey {
    Owner,
    PendingOwner,
    Underwriter,
    Usdc,
    TotalShares,
    TotalPrincipal,
    TotalRepaidInterest,
    TotalWrittenOff,
    Borrowers,
    Shares(Address),
    Line(Address),
    History(Address),
    Vault,     // Option<Address> of the DeFindex vault idle USDC is parked in
    BufferBps, // u32 target share of liquidity kept as raw USDC (rest is invested)
}

// Event topics (≤ 9 chars for symbol_short).
const DEPOSITED: Symbol = symbol_short!("deposited");
const WITHDRAWN: Symbol = symbol_short!("withdrawn");
const LINE_SET: Symbol = symbol_short!("line_set");
const FROZEN: Symbol = symbol_short!("frozen");
const BORROWED: Symbol = symbol_short!("borrowed");
const REPAID: Symbol = symbol_short!("repaid");
const WRITEOFF: Symbol = symbol_short!("writeoff");
const CYCLE: Symbol = symbol_short!("cycle");
const SECURED: Symbol = symbol_short!("secured");
const SEIZED: Symbol = symbol_short!("seized");
const INVESTED: Symbol = symbol_short!("invested");
const DIVESTED: Symbol = symbol_short!("divested");

#[contract]
pub struct CreditLine;

#[contractimpl]
impl CreditLine {
    /// One-time setup. `owner` administers roles; `underwriter` may open/update unsecured lines;
    /// `usdc` is the 7-decimal token lent, borrowed and repaid.
    pub fn initialize(env: Env, owner: Address, underwriter: Address, usdc: Address) {
        let s = env.storage().instance();
        if s.has(&DataKey::Owner) {
            panic_with_error!(&env, Error::AlreadyInitialized);
        }
        s.set(&DataKey::Owner, &owner);
        s.set(&DataKey::Underwriter, &underwriter);
        s.set(&DataKey::Usdc, &usdc);
    }

    /// Owner-gated in-place upgrade — so future pricing/policy changes don't require a fresh pool
    /// address + re-pointing the whole app (state, shares, lines and the vault link are preserved).
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        Self::owner(&env).require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    // ------------------------------------------------------ idle-yield config --

    /// Owner points the pool's idle USDC at a DeFindex vault and sets the liquidity buffer (bps of
    /// total liquidity kept as raw USDC; the rest is invested). Setting it does not move funds — call
    /// `rebalance_idle` (or any deposit/repay) to invest, and any withdraw/borrow pulls back as needed.
    /// The vault's asset MUST be this pool's USDC.
    pub fn set_vault(env: Env, vault: Address, buffer_bps: u32) {
        Self::owner(&env).require_auth();
        if buffer_bps > 10_000 {
            panic_with_error!(&env, Error::BadBuffer);
        }
        env.storage().instance().set(&DataKey::Vault, &vault);
        env.storage().instance().set(&DataKey::BufferBps, &buffer_bps);
        env.events().publish((symbol_short!("vaultset"),), (vault, buffer_bps));
    }

    /// Owner detaches the vault. Pulls everything back to raw USDC first so the pool stays whole.
    pub fn clear_vault(env: Env) {
        Self::owner(&env).require_auth();
        if let Some(vault) = Self::vault_opt(&env) {
            let shares = Self::vault_shares(&env, &vault);
            if shares > 0 {
                Self::vault_withdraw(&env, &vault, shares);
            }
        }
        env.storage().instance().remove(&DataKey::Vault);
        env.storage().instance().remove(&DataKey::BufferBps);
        env.events().publish((symbol_short!("vaultclr"),), ());
    }

    pub fn vault_address(env: Env) -> Option<Address> {
        Self::vault_opt(&env)
    }
    pub fn buffer_bps(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::BufferBps).unwrap_or(DEFAULT_BUFFER_BPS)
    }
    /// USDC value of the pool's position in the vault (principal parked + yield earned), 0 if no vault.
    pub fn vault_value(env: Env) -> i128 {
        match Self::vault_opt(&env) {
            Some(vault) => Self::vault_value_of(&env, &vault),
            None => 0,
        }
    }
    /// Raw USDC sitting in the pool contract (not invested).
    pub fn idle_cash(env: Env) -> i128 {
        token::TokenClient::new(&env, &Self::usdc(&env)).balance(&env.current_contract_address())
    }

    /// Anyone may sweep the pool to its target buffer: invest raw USDC above the buffer, or top the
    /// buffer back up from the vault. Keeps idle capital earning without waiting for the next deposit.
    pub fn rebalance_idle(env: Env) {
        let vault = match Self::vault_opt(&env) {
            Some(v) => v,
            None => return,
        };
        let raw = Self::idle_cash(env.clone());
        let invested = Self::vault_value_of(&env, &vault);
        let target = (raw + invested) * (Self::buffer_bps(env.clone()) as i128) / BPS_DENOM;
        if raw > target {
            Self::vault_deposit(&env, &vault, raw - target);
        } else if raw < target {
            Self::ensure_idle(&env, target - raw);
        }
    }

    // ----------------------------------------------------------- pool views --

    /// USDC the pool can lend or pay out: raw USDC on hand plus whatever is parked in the vault
    /// (principal + yield). Counting the vault position here is what lets lender shares appreciate
    /// with the earned yield, and keeps every liquidity/limit check honest about total firepower.
    pub fn cash(env: Env) -> i128 {
        let raw =
            token::TokenClient::new(&env, &Self::usdc(&env)).balance(&env.current_contract_address());
        raw + Self::vault_value(env)
    }

    /// What the pool is worth to lenders: cash plus principal still out. Accrued-but-unpaid interest
    /// is not counted until it is actually repaid.
    pub fn total_assets(env: Env) -> i128 {
        Self::cash(env.clone()) + Self::total_principal(&env)
    }

    pub fn convert_to_shares(env: Env, assets: i128) -> i128 {
        let ts = Self::total_shares(&env);
        let ta = Self::total_assets(env.clone());
        assets * (ts + VIRTUAL_SHARES) / (ta + VIRTUAL_ASSETS)
    }

    pub fn convert_to_assets(env: Env, shares: i128) -> i128 {
        let ts = Self::total_shares(&env);
        let ta = Self::total_assets(env.clone());
        shares * (ta + VIRTUAL_ASSETS) / (ts + VIRTUAL_SHARES)
    }

    pub fn shares_of(env: Env, account: Address) -> i128 {
        env.storage().persistent().get(&DataKey::Shares(account)).unwrap_or(0)
    }

    pub fn total_shares_view(env: Env) -> i128 {
        Self::total_shares(&env)
    }
    pub fn total_principal_view(env: Env) -> i128 {
        Self::total_principal(&env)
    }
    pub fn total_repaid_interest(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::TotalRepaidInterest).unwrap_or(0)
    }
    pub fn total_written_off(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::TotalWrittenOff).unwrap_or(0)
    }

    pub fn borrowers(env: Env) -> Vec<Address> {
        env.storage().persistent().get(&DataKey::Borrowers).unwrap_or(Vec::new(&env))
    }
    pub fn borrower_count(env: Env) -> u32 {
        Self::borrowers(env).len()
    }

    /// Principal plus interest owed right now, including interest not yet accrued in storage.
    pub fn owed(env: Env, borrower: Address) -> (i128, i128) {
        let l = Self::get_line(env.clone(), borrower);
        (l.principal, l.interest + Self::pending(&env, &l))
    }

    /// What a lender's shares are worth now.
    pub fn collateral_value(env: Env, account: Address) -> i128 {
        Self::convert_to_assets(env.clone(), Self::shares_of(env, account))
    }

    /// The most a lender can owe on a secured line: 71.25% of their shares' value.
    pub fn secured_capacity(env: Env, account: Address) -> i128 {
        Self::collateral_value(env, account) * SECURED_ADVANCE_BPS / 10_000
    }

    /// How much the borrower can draw right now.
    pub fn available(env: Env, borrower: Address) -> i128 {
        let l = Self::get_line(env.clone(), borrower.clone());
        if !l.active {
            return 0;
        }
        let cap = if l.secured { Self::secured_capacity(env.clone(), borrower) } else { l.limit };
        let debt = l.principal + if l.secured { l.interest + Self::pending(&env, &l) } else { 0 };
        if debt >= cap {
            return 0;
        }
        let room = cap - debt;
        let c = Self::cash(env);
        if room < c { room } else { c }
    }

    // -------------------------------------------------------------- lenders --

    pub fn deposit(env: Env, lender: Address, assets: i128) -> i128 {
        lender.require_auth();
        if assets <= 0 {
            panic_with_error!(&env, Error::ZeroAmount);
        }
        // Compute shares against pre-deposit assets, then pull the USDC in.
        let shares = Self::convert_to_shares(env.clone(), assets);
        if shares <= 0 {
            panic_with_error!(&env, Error::ZeroAmount);
        }
        token::TokenClient::new(&env, &Self::usdc(&env)).transfer(
            &lender,
            &env.current_contract_address(),
            &assets,
        );
        Self::set_total_shares(&env, Self::total_shares(&env) + shares);
        Self::set_shares(&env, &lender, Self::shares_of(env.clone(), lender.clone()) + shares);
        env.events().publish((DEPOSITED, lender), (assets, shares));
        Self::invest_excess(&env); // park the fresh USDC (above the buffer) in the vault
        shares
    }

    pub fn withdraw(env: Env, lender: Address, shares: i128) -> i128 {
        lender.require_auth();
        if shares <= 0 {
            panic_with_error!(&env, Error::ZeroAmount);
        }
        let held = Self::shares_of(env.clone(), lender.clone());
        if held < shares {
            panic_with_error!(&env, Error::InsufficientShares);
        }
        let assets = Self::convert_to_assets(env.clone(), shares);
        if assets > Self::cash(env.clone()) {
            panic_with_error!(&env, Error::InsufficientLiquidity);
        }
        // A secured borrower cannot withdraw collateral their open loan still needs.
        if let Some(mut l) = Self::line_opt(&env, &lender) {
            if l.secured && (l.principal > 0 || l.interest > 0 || Self::pending(&env, &l) > 0) {
                Self::accrue(&env, &mut l);
                let remaining =
                    Self::convert_to_assets(env.clone(), held - shares) * SECURED_ADVANCE_BPS / 10_000;
                if remaining < l.principal + l.interest {
                    panic_with_error!(&env, Error::CollateralLocked);
                }
                Self::put_line(&env, &lender, &l);
            }
        }
        Self::set_shares(&env, &lender, held - shares);
        Self::set_total_shares(&env, Self::total_shares(&env) - shares);
        Self::ensure_idle(&env, assets); // unwind from the vault if raw USDC is short
        token::TokenClient::new(&env, &Self::usdc(&env)).transfer(
            &env.current_contract_address(),
            &lender,
            &assets,
        );
        env.events().publish((WITHDRAWN, lender), (assets, shares));
        assets
    }

    // --------------------------------------------------------- underwriting --

    /// LCRD's price for a score and a repayment record: the risk tier, the APR and the largest
    /// unsecured line. Any score below UNSECURED_MIN_SCORE (50) gets no unsecured line (max_limit 0).
    /// The starter line is graded by score within the eligible band ($5 at 50 up to $50 at 100), not a
    /// flat per-tier amount. Pure.
    pub fn quote(env: Env, score: u32, cycles_completed: u32) -> (u32, u32, i128) {
        if score > 100 {
            panic_with_error!(&env, Error::BadScore);
        }
        let (tier, ceiling): (u32, i128) = if score >= TIER_A_MIN_SCORE {
            (1, TIER_A_CEILING)
        } else if score >= TIER_B_MIN_SCORE {
            (2, TIER_B_CEILING)
        } else {
            (3, 0)
        };
        let mut max_limit = if score >= UNSECURED_MIN_SCORE {
            Self::starter_limit(score) * (1 + cycles_completed as i128)
        } else {
            0
        };
        if max_limit > ceiling {
            max_limit = ceiling;
        }
        let apr = Self::unsecured_apr(score, cycles_completed);
        (tier, apr, max_limit)
    }

    /// Starter (0-cycle) unsecured line in USDC base units, graded by score. Only meaningful for an
    /// eligible score (>= UNSECURED_MIN_SCORE); `quote` guards the gate. Piecewise so the amount steps
    /// up across the tier boundary: tier B (50-66) runs $5 -> $25, tier A (67-100) runs $26 -> $50.
    fn starter_limit(score: u32) -> i128 {
        let s = if score > 100 { 100 } else { score } as i128;
        if s >= TIER_A_MIN_SCORE as i128 {
            let span = 100 - TIER_A_MIN_SCORE as i128; // 33
            STARTER_A_MIN_LIMIT
                + (STARTER_A_MAX_LIMIT - STARTER_A_MIN_LIMIT) * (s - TIER_A_MIN_SCORE as i128) / span
        } else {
            let span = TIER_A_MIN_SCORE as i128 - 1 - UNSECURED_MIN_SCORE as i128; // 16 (50..=66)
            STARTER_B_MIN_LIMIT
                + (STARTER_B_MAX_LIMIT - STARTER_B_MIN_LIMIT) * (s - UNSECURED_MIN_SCORE as i128) / span
        }
    }

    /// LCRD's secured price: 8% + 35% of the score premium, less the cycle discount. Pure.
    pub fn secured_quote(env: Env, score: u32, cycles_completed: u32) -> u32 {
        if score > 100 {
            panic_with_error!(&env, Error::BadScore);
        }
        let premium = Self::premium(score);
        let mut apr = BASE_BPS + premium * SECURED_PREMIUM_SHARE_BPS / 10_000;
        apr = Self::apply_discount_and_clamp(apr, cycles_completed);
        apr as u32
    }

    /// Open (or reprice) a secured line against your own pool shares. No score needed; a score already
    /// on file lowers the price.
    pub fn open_secured_line(env: Env, borrower: Address) {
        borrower.require_auth();
        if Self::shares_of(env.clone(), borrower.clone()) == 0 {
            panic_with_error!(&env, Error::NoCollateral);
        }
        let mut l = Self::load_or_new(&env, &borrower);
        if !l.secured && (l.principal > 0 || l.interest > 0) {
            panic_with_error!(&env, Error::HasOpenLoan);
        }
        Self::touch(&env, &borrower, &mut l);
        let h = Self::get_history(env.clone(), borrower.clone());
        let apr = Self::secured_quote(env.clone(), l.score, h.cycles_completed);
        let cap = Self::secured_capacity(env.clone(), borrower.clone());
        l.secured = true;
        l.active = true;
        l.apr_bps = apr;
        l.limit = cap;
        Self::put_line(&env, &borrower, &l);
        env.events().publish((SECURED, borrower), (cap, apr));
    }

    /// Open or update a borrower's unsecured line from their LCRD score. The contract derives the tier
    /// and APR and caps the limit by tier. Accrues interest at the old rate first. `score_ref` is the
    /// hash of the off-chain LCRD score report (no personal data on-chain).
    /// Open or update an OPEN-ENDED (revolving) unsecured line — no due date.
    pub fn set_line(env: Env, borrower: Address, score: u32, limit: i128, score_ref: BytesN<32>) {
        Self::set_line_inner(env, borrower, score, limit, score_ref, 0);
    }

    /// Open or update a FIXED-TERM unsecured line with a repayment due date `term_days` out. Same
    /// pricing; past the due date interest accrues at a penalty rate and no new draws are allowed.
    pub fn set_fixed_term_line(env: Env, borrower: Address, score: u32, limit: i128, score_ref: BytesN<32>, term_days: u32) {
        Self::set_line_inner(env, borrower, score, limit, score_ref, term_days);
    }

    fn set_line_inner(env: Env, borrower: Address, score: u32, limit: i128, score_ref: BytesN<32>, term_days: u32) {
        Self::underwriter(&env).require_auth();
        let (tier, apr, max_limit) = Self::quote(env.clone(), score, Self::get_history(env.clone(), borrower.clone()).cycles_completed);
        if max_limit == 0 {
            panic_with_error!(&env, Error::TierNotEligible);
        }
        if limit > max_limit {
            panic_with_error!(&env, Error::OverLimit);
        }
        let mut l = Self::load_or_new(&env, &borrower);
        if l.secured && (l.principal > 0 || l.interest > 0 || Self::pending(&env, &l) > 0) {
            panic_with_error!(&env, Error::HasOpenLoan);
        }
        Self::touch(&env, &borrower, &mut l);
        l.secured = false;
        l.limit = limit;
        l.apr_bps = apr;
        l.tier = tier;
        l.score = score;
        l.score_ref = score_ref.clone();
        l.term_days = term_days;
        l.due_at = if term_days > 0 { env.ledger().timestamp() + (term_days as u64) * DAY_SECONDS } else { 0 };
        l.active = true;
        Self::put_line(&env, &borrower, &l);
        env.events().publish((LINE_SET, borrower), (limit, score, tier, apr, score_ref));
    }

    /// Stop new draws. Repayments stay open.
    pub fn freeze(env: Env, borrower: Address) {
        Self::underwriter(&env).require_auth();
        let mut l = Self::get_line(env.clone(), borrower.clone());
        Self::accrue(&env, &mut l);
        l.active = false;
        Self::put_line(&env, &borrower, &l);
        env.events().publish((FROZEN, borrower), ());
    }

    /// Recognise a line as lost. Its principal leaves the pool's assets, so lenders bear the loss.
    pub fn write_off(env: Env, borrower: Address) {
        Self::underwriter(&env).require_auth();
        let mut l = Self::get_line(env.clone(), borrower.clone());
        Self::accrue(&env, &mut l);
        let principal = l.principal;
        let interest = l.interest;
        if principal == 0 && interest == 0 {
            panic_with_error!(&env, Error::NothingOwed);
        }
        Self::set_total_principal(&env, Self::total_principal(&env) - principal);
        Self::set_total_written_off(&env, Self::total_written_off(env.clone()) + principal);
        l.principal = 0;
        l.interest = 0;
        l.active = false;
        Self::put_line(&env, &borrower, &l);
        let mut h = Self::get_history(env.clone(), borrower.clone());
        h.write_offs += 1;
        h.cycles_completed = 0;
        h.cycle_start = 0;
        h.cycle_peak = 0;
        h.last_writeoff_at = env.ledger().timestamp();
        Self::put_history(&env, &borrower, &h);
        env.events().publish((WRITEOFF, borrower), (principal, interest));
    }

    /// Settle a defaulted secured line from the borrower's own shares. Anything the shares cannot cover
    /// is written off. Recorded as a write-off in the borrower's history.
    pub fn seize_collateral(env: Env, borrower: Address) {
        Self::underwriter(&env).require_auth();
        let mut l = Self::get_line(env.clone(), borrower.clone());
        if !l.secured {
            panic_with_error!(&env, Error::NotSecured);
        }
        Self::accrue(&env, &mut l);
        let interest_due = l.interest;
        let principal_due = l.principal;
        let debt = interest_due + principal_due;
        if debt == 0 {
            panic_with_error!(&env, Error::NothingOwed);
        }
        let ts = Self::total_shares(&env);
        let ta = Self::total_assets(env.clone());
        // Shares worth the debt, rounded up, but no more than the borrower holds.
        let needed = (debt * (ts + VIRTUAL_SHARES) + (ta + VIRTUAL_ASSETS) - 1) / (ta + VIRTUAL_ASSETS);
        let held = Self::shares_of(env.clone(), borrower.clone());
        let take = if needed < held { needed } else { held };
        let mut value = Self::convert_to_assets(env.clone(), take);
        if value > debt {
            value = debt;
        }
        Self::set_shares(&env, &borrower, held - take);
        Self::set_total_shares(&env, ts - take);

        let to_interest = if value < interest_due { value } else { interest_due };
        let to_principal = value - to_interest;
        let leftover = principal_due - to_principal; // uncovered principal: a loss to the pool
        Self::set_total_principal(&env, Self::total_principal(&env) - principal_due);
        Self::set_total_repaid_interest(&env, Self::total_repaid_interest(env.clone()) + to_interest);
        Self::set_total_written_off(&env, Self::total_written_off(env.clone()) + leftover);

        l.principal = 0;
        l.interest = 0;
        l.active = false;
        Self::put_line(&env, &borrower, &l);
        let mut h = Self::get_history(env.clone(), borrower.clone());
        h.write_offs += 1;
        h.cycles_completed = 0;
        h.cycle_start = 0;
        h.cycle_peak = 0;
        h.last_writeoff_at = env.ledger().timestamp();
        Self::put_history(&env, &borrower, &h);
        env.events().publish((SEIZED, borrower), (take, value, leftover));
    }

    // ------------------------------------------------------------ borrowers --

    pub fn borrow(env: Env, borrower: Address, amount: i128) {
        borrower.require_auth();
        if amount <= 0 {
            panic_with_error!(&env, Error::ZeroAmount);
        }
        let mut l = Self::get_line(env.clone(), borrower.clone());
        if !l.active {
            panic_with_error!(&env, Error::LineInactive);
        }
        if l.due_at > 0 && env.ledger().timestamp() > l.due_at {
            panic_with_error!(&env, Error::LinePastDue); // a matured fixed-term line can't be drawn on
        }
        Self::accrue(&env, &mut l);
        if l.secured {
            let cap = Self::secured_capacity(env.clone(), borrower.clone());
            if l.principal + l.interest + amount > cap {
                panic_with_error!(&env, Error::OverLimit);
            }
            l.limit = cap; // snapshot, used by the cycle rule and shown in the app
        } else if l.principal + amount > l.limit {
            panic_with_error!(&env, Error::OverLimit);
        }
        if amount > Self::cash(env.clone()) {
            panic_with_error!(&env, Error::InsufficientLiquidity);
        }
        let now = env.ledger().timestamp();
        let mut h = Self::get_history(env.clone(), borrower.clone());
        if h.first_borrow_at == 0 {
            h.first_borrow_at = now;
        }
        if h.cycle_start == 0 {
            h.cycle_start = now;
        }
        l.principal += amount;
        if l.principal > h.cycle_peak {
            h.cycle_peak = l.principal;
        }
        h.total_borrowed += amount;
        Self::set_total_principal(&env, Self::total_principal(&env) + amount);
        Self::put_line(&env, &borrower, &l);
        Self::put_history(&env, &borrower, &h);
        Self::ensure_idle(&env, amount); // unwind from the vault if raw USDC is short
        token::TokenClient::new(&env, &Self::usdc(&env)).transfer(
            &env.current_contract_address(),
            &borrower,
            &amount,
        );
        env.events().publish((BORROWED, borrower), amount);
    }

    /// Repay a line. `payer` funds the repayment (self, or an employer/guarantor/app paying for the
    /// `borrower`). Interest is paid first, then principal; overpayment is not taken.
    pub fn repay(env: Env, payer: Address, borrower: Address, amount: i128) -> i128 {
        payer.require_auth();
        if amount <= 0 {
            panic_with_error!(&env, Error::ZeroAmount);
        }
        let mut l = Self::get_line(env.clone(), borrower.clone());
        Self::accrue(&env, &mut l);
        let interest_due = l.interest;
        let principal_due = l.principal;
        if interest_due + principal_due == 0 {
            panic_with_error!(&env, Error::NothingOwed);
        }
        // Pull exactly `amount` from the payer. This is the only payer-authorized transfer, and its
        // value is fixed by the caller — so the auth entry built at simulation still matches at
        // execution even though interest keeps accruing in between (a Soroban-specific hazard the
        // EVM original does not have). Any overpayment is refunded below.
        let usdc = token::TokenClient::new(&env, &Self::usdc(&env));
        usdc.transfer(&payer, &env.current_contract_address(), &amount);

        let payoff = interest_due + principal_due;
        let paid = if amount < payoff { amount } else { payoff };
        let to_interest = if paid < interest_due { paid } else { interest_due };
        let to_principal = paid - to_interest;

        l.interest = interest_due - to_interest;
        l.principal = principal_due - to_principal;
        Self::set_total_principal(&env, Self::total_principal(&env) - to_principal);
        Self::set_total_repaid_interest(&env, Self::total_repaid_interest(env.clone()) + to_interest);

        let mut h = Self::get_history(env.clone(), borrower.clone());
        h.repayments += 1;
        h.last_repaid_at = env.ledger().timestamp();
        h.total_repaid += paid;
        if l.principal == 0 && l.interest == 0 && h.cycle_start != 0 {
            let now = env.ledger().timestamp();
            // A cycle only ladders the line if ALL anti-gaming guards pass:
            let held_long_enough = now - h.cycle_start >= CYCLE_MIN_DURATION;      // real duration
            let used_enough = h.cycle_peak * CYCLE_MIN_USE_DIVISOR >= l.limit;      // real utilization (≥50%)
            let velocity_ok = h.last_laddered_at == 0 || now - h.last_laddered_at >= LADDER_MIN_INTERVAL; // ≤1 step / 30d
            let clean_history = h.last_writeoff_at == 0 || now - h.last_writeoff_at >= WRITEOFF_LADDER_PAUSE; // no recent default
            let qualifies = held_long_enough && used_enough && velocity_ok && clean_history;
            h.cycle_start = 0;
            h.cycle_peak = 0;
            if qualifies {
                h.cycles_completed += 1;
                h.last_laddered_at = now;
                if l.secured {
                    // Secured lines are sized by collateral, so only the rate improves.
                    l.apr_bps = Self::secured_quote(env.clone(), l.score, h.cycles_completed);
                } else {
                    // Unsecured ladder: a completed cycle lowers the APR AND raises the active limit to
                    // the new tier maximum (starter × (1 + cycles), capped at the ceiling) — so the line
                    // grows automatically with every on-time cycle, no re-issue needed.
                    let (_, apr, max_limit) = Self::quote(env.clone(), l.score, h.cycles_completed);
                    l.apr_bps = apr;
                    l.limit = max_limit;
                }
                env.events().publish((CYCLE, borrower.clone()), (h.cycles_completed, l.apr_bps, l.limit));
            }
        }
        // Refund overpayment (contract-authorized; a value that varies from simulation is fine here).
        let surplus = amount - paid;
        if surplus > 0 {
            usdc.transfer(&env.current_contract_address(), &payer, &surplus);
        }
        Self::put_line(&env, &borrower, &l);
        Self::put_history(&env, &borrower, &h);
        env.events().publish((REPAID, borrower), (payer, to_interest, to_principal));
        Self::invest_excess(&env); // park the repaid USDC (above the buffer) back in the vault
        paid
    }

    // --------------------------------------------------------------- admin --

    pub fn set_underwriter(env: Env, underwriter: Address) {
        Self::owner(&env).require_auth();
        env.storage().instance().set(&DataKey::Underwriter, &underwriter);
    }

    pub fn transfer_ownership(env: Env, new_owner: Address) {
        Self::owner(&env).require_auth();
        env.storage().instance().set(&DataKey::PendingOwner, &new_owner);
    }

    pub fn accept_ownership(env: Env) {
        let pending: Address = env
            .storage()
            .instance()
            .get(&DataKey::PendingOwner)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotPendingOwner));
        pending.require_auth();
        env.storage().instance().set(&DataKey::Owner, &pending);
        env.storage().instance().remove(&DataKey::PendingOwner);
    }

    // ---------------------------------------------------------------- views --

    pub fn get_line(env: Env, borrower: Address) -> Line {
        Self::line_opt(&env, &borrower).unwrap_or(Line {
            limit: 0,
            principal: 0,
            interest: 0,
            apr_bps: 0,
            tier: 0,
            score: 0,
            secured: false,
            active: false,
            last_accrued: 0,
            score_ref: BytesN::from_array(&env, &[0u8; 32]),
            term_days: 0,
            due_at: 0,
        })
    }

    pub fn get_history(env: Env, borrower: Address) -> History {
        env.storage().persistent().get(&DataKey::History(borrower)).unwrap_or(History {
            repayments: 0,
            cycles_completed: 0,
            write_offs: 0,
            first_borrow_at: 0,
            last_repaid_at: 0,
            cycle_start: 0,
            cycle_peak: 0,
            total_borrowed: 0,
            total_repaid: 0,
            last_laddered_at: 0,
            last_writeoff_at: 0,
        })
    }

    pub fn owner_of(env: Env) -> Address {
        Self::owner(&env)
    }
    pub fn underwriter_of(env: Env) -> Address {
        Self::underwriter(&env)
    }

    // ------------------------------------------------------------- internal --

    fn owner(env: &Env) -> Address {
        env.storage().instance().get(&DataKey::Owner).unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized))
    }
    fn underwriter(env: &Env) -> Address {
        env.storage().instance().get(&DataKey::Underwriter).unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized))
    }
    fn usdc(env: &Env) -> Address {
        env.storage().instance().get(&DataKey::Usdc).unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized))
    }

    // ------------------------------------------------------- DeFindex vault --
    // The pool is just a depositor in the vault: it holds vault shares, and the vault's share value
    // carries the yield. All calls are made by the pool itself, so the token transfers they trigger
    // are authorized with `authorize_as_current_contract`. When no vault is set, everything no-ops.

    fn vault_opt(env: &Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Vault)
    }

    /// Vault shares the pool holds (the vault is itself a SEP-41 share token).
    fn vault_shares(env: &Env, vault: &Address) -> i128 {
        env.invoke_contract::<i128>(
            vault,
            &Symbol::new(env, "balance"),
            vec![env, env.current_contract_address().into_val(env)],
        )
    }

    /// USDC value of the pool's vault shares right now (principal parked + yield).
    fn vault_value_of(env: &Env, vault: &Address) -> i128 {
        let shares = Self::vault_shares(env, vault);
        if shares <= 0 {
            return 0;
        }
        let amounts: Vec<i128> = env.invoke_contract(
            vault,
            &Symbol::new(env, "get_asset_amounts_per_shares"),
            vec![env, shares.into_val(env)],
        );
        amounts.get(0).unwrap_or(0)
    }

    /// Invest raw USDC above the buffer into the vault (no-op without a vault, or below the buffer).
    fn invest_excess(env: &Env) {
        let vault = match Self::vault_opt(env) {
            Some(v) => v,
            None => return,
        };
        let raw =
            token::TokenClient::new(env, &Self::usdc(env)).balance(&env.current_contract_address());
        let invested = Self::vault_value_of(env, &vault);
        let buffer_bps = Self::buffer_bps(env.clone()) as i128;
        let target = (raw + invested) * buffer_bps / BPS_DENOM;
        if raw > target {
            Self::vault_deposit(env, &vault, raw - target);
        }
    }

    /// Make sure at least `needed` raw USDC is on hand, unwinding from the vault if short.
    fn ensure_idle(env: &Env, needed: i128) {
        let vault = match Self::vault_opt(env) {
            Some(v) => v,
            None => return,
        };
        let usdc = Self::usdc(env);
        let raw = token::TokenClient::new(env, &usdc).balance(&env.current_contract_address());
        if raw >= needed {
            return;
        }
        let shortfall = needed - raw;
        let invested = Self::vault_value_of(env, &vault);
        if invested <= 0 {
            return; // nothing parked; the caller's own liquidity check will reject if truly short
        }
        let shares_held = Self::vault_shares(env, &vault);
        // Shares worth `shortfall`, rounded up, capped at what the pool holds. Pulling the whole
        // position when the shortfall meets or exceeds it avoids leaving dust unredeemable.
        let mut shares = if shortfall >= invested {
            shares_held
        } else {
            (shortfall * shares_held + invested - 1) / invested
        };
        if shares > shares_held {
            shares = shares_held;
        }
        if shares > 0 {
            Self::vault_withdraw(env, &vault, shares);
        }
    }

    fn vault_deposit(env: &Env, vault: &Address, amount: i128) {
        if amount <= 0 {
            return;
        }
        let usdc = Self::usdc(env);
        let me = env.current_contract_address();
        let amounts: Vec<i128> = vec![env, amount];
        let mins: Vec<i128> = vec![env, 0i128];
        // The vault pulls `amount` USDC from us; pre-authorize that transfer on our own behalf.
        let transfer_args: Vec<Val> = (me.clone(), vault.clone(), amount).into_val(env);
        env.authorize_as_current_contract(vec![
            env,
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: usdc.clone(),
                    fn_name: Symbol::new(env, "transfer"),
                    args: transfer_args,
                },
                sub_invocations: vec![env],
            }),
        ]);
        let args: Vec<Val> = (amounts, mins, me, false).into_val(env);
        env.invoke_contract::<Val>(vault, &Symbol::new(env, "deposit"), args);
        env.events().publish((INVESTED, vault.clone()), amount);
    }

    fn vault_withdraw(env: &Env, vault: &Address, shares: i128) -> i128 {
        if shares <= 0 {
            return 0;
        }
        let me = env.current_contract_address();
        let mins: Vec<i128> = vec![env, 0i128];
        let args: Vec<Val> = (shares, mins, me.clone()).into_val(env);
        // The vault burns our shares (from == this pool); authorize that withdraw on our own behalf.
        env.authorize_as_current_contract(vec![
            env,
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: vault.clone(),
                    fn_name: Symbol::new(env, "withdraw"),
                    args: args.clone(),
                },
                sub_invocations: vec![env],
            }),
        ]);
        let out: Vec<i128> = env.invoke_contract(vault, &Symbol::new(env, "withdraw"), args);
        let got = out.get(0).unwrap_or(0);
        env.events().publish((DIVESTED, vault.clone()), got);
        got
    }
    fn total_shares(env: &Env) -> i128 {
        env.storage().instance().get(&DataKey::TotalShares).unwrap_or(0)
    }
    fn total_principal(env: &Env) -> i128 {
        env.storage().instance().get(&DataKey::TotalPrincipal).unwrap_or(0)
    }

    fn set_total_shares(env: &Env, v: i128) {
        env.storage().instance().set(&DataKey::TotalShares, &v);
    }
    fn set_total_principal(env: &Env, v: i128) {
        env.storage().instance().set(&DataKey::TotalPrincipal, &v);
    }
    fn set_total_repaid_interest(env: &Env, v: i128) {
        env.storage().instance().set(&DataKey::TotalRepaidInterest, &v);
    }
    fn set_total_written_off(env: &Env, v: i128) {
        env.storage().instance().set(&DataKey::TotalWrittenOff, &v);
    }

    fn set_shares(env: &Env, account: &Address, v: i128) {
        let key = DataKey::Shares(account.clone());
        env.storage().persistent().set(&key, &v);
        env.storage().persistent().extend_ttl(&key, ENTRY_BUMP, ENTRY_TTL);
    }

    fn line_opt(env: &Env, borrower: &Address) -> Option<Line> {
        env.storage().persistent().get(&DataKey::Line(borrower.clone()))
    }
    fn put_line(env: &Env, borrower: &Address, l: &Line) {
        let key = DataKey::Line(borrower.clone());
        env.storage().persistent().set(&key, l);
        env.storage().persistent().extend_ttl(&key, ENTRY_BUMP, ENTRY_TTL);
    }
    fn put_history(env: &Env, borrower: &Address, h: &History) {
        let key = DataKey::History(borrower.clone());
        env.storage().persistent().set(&key, h);
        env.storage().persistent().extend_ttl(&key, ENTRY_BUMP, ENTRY_TTL);
    }

    /// Load the stored line or a fresh zeroed one (does not persist).
    fn load_or_new(env: &Env, borrower: &Address) -> Line {
        Self::line_opt(env, borrower).unwrap_or(Line {
            limit: 0,
            principal: 0,
            interest: 0,
            apr_bps: 0,
            tier: 0,
            score: 0,
            secured: false,
            active: false,
            last_accrued: 0,
            score_ref: BytesN::from_array(env, &[0u8; 32]),
            term_days: 0,
            due_at: 0,
        })
    }

    /// First touch registers the borrower and starts the accrual clock; later touches accrue interest.
    fn touch(env: &Env, borrower: &Address, l: &mut Line) {
        if l.last_accrued == 0 {
            let mut bs: Vec<Address> = env.storage().persistent().get(&DataKey::Borrowers).unwrap_or(Vec::new(env));
            bs.push_back(borrower.clone());
            env.storage().persistent().set(&DataKey::Borrowers, &bs);
            env.storage().persistent().extend_ttl(&DataKey::Borrowers, ENTRY_BUMP, ENTRY_TTL);
            l.last_accrued = env.ledger().timestamp();
        } else {
            Self::accrue(env, l);
        }
    }

    /// Simple interest accrued on the outstanding principal since `last_accrued`.
    fn pending(env: &Env, l: &Line) -> i128 {
        if l.principal == 0 || l.last_accrued == 0 {
            return 0;
        }
        let now = env.ledger().timestamp();
        let elapsed = (now - l.last_accrued) as i128;
        // A fixed-term line past its due date accrues at a penalty rate (the late-payment fee).
        let rate = if l.due_at > 0 && now > l.due_at {
            l.apr_bps as i128 + LATE_PENALTY_BPS
        } else {
            l.apr_bps as i128
        };
        l.principal * rate * elapsed / (YEAR * 10_000)
    }

    fn accrue(env: &Env, l: &mut Line) {
        if l.last_accrued == 0 {
            return;
        }
        let add = Self::pending(env, l);
        if add > 0 {
            l.interest += add;
        }
        l.last_accrued = env.ledger().timestamp();
    }

    // ---- pricing helpers (pure) ----
    fn premium(score: u32) -> i128 {
        PREMIUM_AT_0_BPS - (PREMIUM_AT_0_BPS - PREMIUM_AT_100_BPS) * (score as i128) / 100
    }
    fn apply_discount_and_clamp(mut apr: i128, cycles_completed: u32) -> i128 {
        let mut discount = (cycles_completed as i128) * CYCLE_DISCOUNT_BPS;
        if discount > MAX_CYCLE_DISCOUNT_BPS {
            discount = MAX_CYCLE_DISCOUNT_BPS;
        }
        apr = if apr > discount { apr - discount } else { 0 };
        if apr < MIN_APR_BPS {
            apr = MIN_APR_BPS;
        }
        if apr > MAX_APR_BPS {
            apr = MAX_APR_BPS;
        }
        apr
    }
    fn unsecured_apr(score: u32, cycles_completed: u32) -> u32 {
        let apr = BASE_BPS + Self::premium(score) + UNSECURED_SURCHARGE_BPS
            + Self::default_premium(score, cycles_completed);
        Self::apply_discount_and_clamp(apr, cycles_completed) as u32
    }

    /// Expected-loss premium (bps). PD falls linearly with score across the eligible band and by a
    /// fixed relief per completed cycle (proven repayment), with a floor. LGD is ~100% (unsecured), so
    /// the premium ≈ PD. This is the component that prices real-world default risk into the APR.
    fn default_premium(score: u32, cycles_completed: u32) -> i128 {
        let s = if score > 100 { 100 } else if score < UNSECURED_MIN_SCORE { UNSECURED_MIN_SCORE } else { score } as i128;
        let span = 100 - UNSECURED_MIN_SCORE as i128; // eligible score band width
        let mut pd = DEFAULT_PD_AT_MIN_BPS
            - (DEFAULT_PD_AT_MIN_BPS - DEFAULT_PD_AT_MAX_BPS) * (s - UNSECURED_MIN_SCORE as i128) / span;
        let relief = (cycles_completed as i128) * DEFAULT_PD_CYCLE_RELIEF_BPS;
        pd = if pd > relief { pd - relief } else { 0 };
        if pd < DEFAULT_PD_FLOOR_BPS { DEFAULT_PD_FLOOR_BPS } else { pd }
    }
}

#[cfg(test)]
mod test;
