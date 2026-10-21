#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{token, Address, BytesN, Env};

const YEAR_SECS: u64 = 31_536_000;
const DAY: u64 = 86_400;

// USDC base units at 7 decimals.
fn usdc(n: i128) -> i128 {
    n * 10_000_000
}

// Vault round-trips use integer share math, which can shave a stroop of dust. Treat values within a
// handful of base units (< 1e-6 USDC) as equal.
fn close(a: i128, b: i128) -> bool {
    (a - b).abs() <= 20
}

struct Setup {
    env: Env,
    client: CreditLineClient<'static>,
    owner: Address,
    underwriter: Address,
    lender: Address,
    borrower: Address,
    usdc_tok: token::TokenClient<'static>,
    usdc_admin: token::StellarAssetClient<'static>,
}

fn setup() -> Setup {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.timestamp = 1_000_000);

    let owner = Address::generate(&env);
    let underwriter = Address::generate(&env);
    let lender = Address::generate(&env);
    let borrower = Address::generate(&env);

    let issuer = Address::generate(&env);
    let usdc_sac = env.register_stellar_asset_contract_v2(issuer);
    let usdc_addr = usdc_sac.address();
    let usdc_tok = token::TokenClient::new(&env, &usdc_addr);
    let usdc_admin = token::StellarAssetClient::new(&env, &usdc_addr);
    usdc_admin.mint(&lender, &usdc(10_000));
    usdc_admin.mint(&borrower, &usdc(1_000)); // seed so the borrower can repay interest

    let id = env.register(CreditLine, ());
    let client = CreditLineClient::new(&env, &id);
    client.initialize(&owner, &underwriter, &usdc_addr);

    Setup { env, client, owner, underwriter, lender, borrower, usdc_tok, usdc_admin }
}

fn advance(env: &Env, secs: u64) {
    let t = env.ledger().timestamp();
    env.ledger().with_mut(|l| l.timestamp = t + secs);
}

fn href(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[9u8; 32])
}

// ------------------------------------------------------------------ pricing --

#[test]
fn quote_matches_policy() {
    let s = setup();
    // APR = 800 base + score premium (2000@0→300@100) + 300 surcharge + default premium (4100@50→1200@100).
    // Starter line is graded by score: tier B (50-66) $5→$25, tier A (67-100) $26→$50.

    // Top score (100): premium 300, default premium 1200 → 800+300+300+1200 = 2600 bps; starter $50 (tier A max).
    let (tier, apr, max) = s.client.quote(&100, &0);
    assert_eq!(tier, 1);
    assert_eq!(apr, 2600);
    assert_eq!(max, usdc(50));

    // Tier A floor (67): $26 starter (not an instant $50).
    let (tier_a0, _, max_a0) = s.client.quote(&67, &0);
    assert_eq!(tier_a0, 1);
    assert_eq!(max_a0, usdc(26));

    // Tier B top (66): $25 starter.
    let (tier_b_top, _, max_b_top) = s.client.quote(&66, &0);
    assert_eq!(tier_b_top, 2);
    assert_eq!(max_b_top, usdc(25));

    // Minimum eligible score (50): premium 1150, default premium 4100 → 800+1150+300+4100 = 6350 bps; $5 starter.
    let (tier_min, apr_min, max_min) = s.client.quote(&50, &0);
    assert_eq!(tier_min, 2);
    assert_eq!(apr_min, 6350);
    assert_eq!(max_min, usdc(5));

    // Just below the gate (49): tier B but no unsecured line.
    let (tier_b, _, max_b) = s.client.quote(&49, &0);
    assert_eq!(tier_b, 2);
    assert_eq!(max_b, 0);

    // Tier C: never an unsecured line.
    let (tier_c, _, max_c) = s.client.quote(&10, &0);
    assert_eq!(tier_c, 3);
    assert_eq!(max_c, 0);

    // APR strictly decreases as score rises across the eligible band.
    assert!(s.client.quote(&50, &0).1 > s.client.quote(&75, &0).1);
    assert!(s.client.quote(&75, &0).1 > s.client.quote(&100, &0).1);

    // Cycle discount lowers APR (−50 bps/cycle, capped 200) and grows the limit (× (1 + cycles), capped at ceiling).
    let (_, apr1, max1) = s.client.quote(&100, &1);
    assert_eq!(apr1, 2300); // 2600 − 50 bps discount − 250 bps cycle PD relief
    assert_eq!(max1, usdc(100)); // $50 starter × (1 + 1)
    let (_, apr9, max9) = s.client.quote(&100, &9);
    assert_eq!(apr9, 1700); // default premium at its 500-bp floor, discount capped at 200 bps
    assert_eq!(max9, usdc(500)); // $50 × 10, still under the $2,500 ceiling
}

#[test]
fn secured_quote_matches_policy() {
    let s = setup();
    // No score (0): 8% + 35% × 20% = 8% + 7% = 15% = 1500 bps.
    assert_eq!(s.client.secured_quote(&0, &0), 1500);
    // Score 71: premium 793 → 800 + 35% × 793 = 800 + 277 = 1077 bps.
    assert_eq!(s.client.secured_quote(&71, &0), 1077);
}

#[test]
fn quote_rejects_bad_score() {
    let s = setup();
    assert!(s.client.try_quote(&101, &0).is_err());
}

// -------------------------------------------------------------------- pool --

#[test]
fn deposit_then_withdraw_restores_balance() {
    let s = setup();
    let before = s.usdc_tok.balance(&s.lender);
    let shares = s.client.deposit(&s.lender, &usdc(100));
    assert!(shares > 0);
    assert_eq!(s.usdc_tok.balance(&s.client.address), usdc(100));
    assert_eq!(s.client.shares_of(&s.lender), shares);
    assert_eq!(s.client.total_assets(), usdc(100));

    let got = s.client.withdraw(&s.lender, &shares);
    // Virtual shares/assets cost at most a rounding unit.
    assert!(got >= usdc(100) - 2 && got <= usdc(100));
    assert_eq!(s.usdc_tok.balance(&s.lender), before - usdc(100) + got);
    assert_eq!(s.client.shares_of(&s.lender), 0);
}

// -------------------------------------------------------------- unsecured --

#[test]
fn unsecured_borrow_accrues_interest_and_repays() {
    let s = setup();
    s.client.deposit(&s.lender, &usdc(1_000)); // pool liquidity
    // Score 100: APR 26% (2600 bps), $50 starter line.
    s.client.set_line(&s.borrower, &100, &usdc(50), &href(&s.env));

    let line = s.client.get_line(&s.borrower);
    assert_eq!(line.tier, 1);
    assert_eq!(line.apr_bps, 2600);
    assert_eq!(line.limit, usdc(50));
    assert!(!line.secured && line.active);

    s.client.borrow(&s.borrower, &usdc(25));
    assert_eq!(s.client.get_line(&s.borrower).principal, usdc(25));
    assert_eq!(s.client.total_principal_view(), usdc(25));

    advance(&s.env, YEAR_SECS);
    // 26% of 25 USDC = 6.5 USDC.
    let (principal, interest) = s.client.owed(&s.borrower);
    assert_eq!(principal, usdc(25));
    assert_eq!(interest, 65_000_000);

    let payoff = principal + interest;
    let paid = s.client.repay(&s.borrower, &s.borrower, &payoff);
    assert_eq!(paid, payoff);
    let (p2, i2) = s.client.owed(&s.borrower);
    assert_eq!((p2, i2), (0, 0));
    // Repaid interest accrues to the pool (share value rises).
    assert_eq!(s.client.total_repaid_interest(), 65_000_000);
    assert_eq!(s.client.total_assets(), usdc(1_000) + 65_000_000);
}

#[test]
fn borrow_over_limit_rejected() {
    let s = setup();
    s.client.deposit(&s.lender, &usdc(1_000));
    s.client.set_line(&s.borrower, &100, &usdc(50), &href(&s.env));
    assert!(s.client.try_borrow(&s.borrower, &usdc(51)).is_err());
}

#[test]
fn set_line_over_tier_max_rejected() {
    let s = setup();
    // Score 100's starter max is $50 at 0 cycles.
    assert!(s.client.try_set_line(&s.borrower, &100, &usdc(51), &href(&s.env)).is_err());
}

#[test]
fn tier_c_not_eligible() {
    let s = setup();
    assert!(s.client.try_set_line(&s.borrower, &20, &usdc(10), &href(&s.env)).is_err());
}

#[test]
fn borrow_beyond_liquidity_rejected() {
    let s = setup();
    s.client.deposit(&s.lender, &usdc(30)); // only 30 USDC in the pool
    s.client.set_line(&s.borrower, &100, &usdc(50), &href(&s.env));
    assert!(s.client.try_borrow(&s.borrower, &usdc(50)).is_err());
}

// ----------------------------------------------------------------- cycles --

#[test]
fn qualifying_cycle_lowers_apr_and_grows_limit() {
    let s = setup();
    s.client.deposit(&s.lender, &usdc(1_000));
    // Score 100: $50 starter line at 0 cycles.
    s.client.set_line(&s.borrower, &100, &usdc(50), &href(&s.env));

    s.client.borrow(&s.borrower, &usdc(25)); // ≥ 50% of the $50 limit (peak-use requirement)
    advance(&s.env, 22 * DAY); // ≥ the 21-day minimum hold for a cycle to count
    let (p, i) = s.client.owed(&s.borrower);
    s.client.repay(&s.borrower, &s.borrower, &(p + i));

    let h = s.client.get_history(&s.borrower);
    assert_eq!(h.cycles_completed, 1);
    assert_eq!(h.repayments, 1);
    let line = s.client.get_line(&s.borrower);
    // APR dropped automatically after the cycle (−50 bps discount and −250 bps default-premium relief).
    assert_eq!(line.apr_bps, 2300);
    // Ladder: the active limit auto-raised with the cycle ($50 → $100 = starter × (1 + cycles)).
    assert_eq!(line.limit, usdc(100));
    assert_eq!(s.client.quote(&100, &h.cycles_completed).2, usdc(100));
    // And the borrower can immediately draw against the higher limit.
    s.client.borrow(&s.borrower, &usdc(75));
    assert_eq!(s.client.get_line(&s.borrower).principal, usdc(75));
}

#[test]
fn dust_loan_does_not_complete_a_cycle() {
    let s = setup();
    s.client.deposit(&s.lender, &usdc(1_000));
    s.client.set_line(&s.borrower, &100, &usdc(50), &href(&s.env));

    s.client.borrow(&s.borrower, &usdc(10)); // < 50% of the $50 limit (below peak-use requirement)
    advance(&s.env, 22 * DAY); // held long enough; only the small draw stops the cycle counting
    let (p, i) = s.client.owed(&s.borrower);
    s.client.repay(&s.borrower, &s.borrower, &(p + i));
    assert_eq!(s.client.get_history(&s.borrower).cycles_completed, 0);
}

// ---------------------------------------------------------------- secured --

#[test]
fn secured_line_against_own_deposit() {
    let s = setup();
    // Borrower is also a lender here: deposits 100 USDC, borrows against it.
    s.usdc_admin.mint(&s.borrower, &usdc(100));
    s.client.deposit(&s.borrower, &usdc(100));
    // Add outside liquidity so the pool has cash to lend.
    s.client.deposit(&s.lender, &usdc(1_000));

    s.client.open_secured_line(&s.borrower);
    let line = s.client.get_line(&s.borrower);
    assert!(line.secured && line.active);
    assert_eq!(line.apr_bps, 1500); // no score → 15%
    // Capacity = 71.25% of 100 USDC.
    assert_eq!(s.client.secured_capacity(&s.borrower), usdc(100) * 7125 / 10000);

    s.client.borrow(&s.borrower, &usdc(50));
    assert_eq!(s.client.get_line(&s.borrower).principal, usdc(50));
}

#[test]
fn borrow_over_secured_capacity_rejected() {
    let s = setup();
    s.usdc_admin.mint(&s.borrower, &usdc(100));
    s.client.deposit(&s.borrower, &usdc(100));
    s.client.deposit(&s.lender, &usdc(1_000));
    s.client.open_secured_line(&s.borrower);
    // Capacity is ~71.25 USDC; 72 is over.
    assert!(s.client.try_borrow(&s.borrower, &usdc(72)).is_err());
}

#[test]
fn cannot_withdraw_collateral_backing_a_secured_loan() {
    let s = setup();
    s.usdc_admin.mint(&s.borrower, &usdc(100));
    let shares = s.client.deposit(&s.borrower, &usdc(100));
    s.client.deposit(&s.lender, &usdc(1_000));
    s.client.open_secured_line(&s.borrower);
    s.client.borrow(&s.borrower, &usdc(50));
    // Withdrawing all shares would drop capacity below the 50 USDC owed.
    assert!(s.client.try_withdraw(&s.borrower, &shares).is_err());
}

// ------------------------------------------------------------------ risk --

#[test]
fn write_off_lowers_pool_value() {
    let s = setup();
    s.client.deposit(&s.lender, &usdc(1_000));
    s.client.set_line(&s.borrower, &100, &usdc(50), &href(&s.env));
    s.client.borrow(&s.borrower, &usdc(25));
    let assets_before = s.client.total_assets();

    s.client.write_off(&s.borrower);
    assert_eq!(s.client.total_written_off(), usdc(25));
    assert_eq!(s.client.total_principal_view(), 0);
    // Principal left the pool's assets, so lenders bear the loss.
    assert_eq!(s.client.total_assets(), assets_before - usdc(25));
    let h = s.client.get_history(&s.borrower);
    assert_eq!(h.write_offs, 1);
    assert_eq!(h.cycles_completed, 0);
}

#[test]
fn seize_collateral_settles_secured_default() {
    let s = setup();
    s.usdc_admin.mint(&s.borrower, &usdc(100));
    s.client.deposit(&s.borrower, &usdc(100));
    s.client.deposit(&s.lender, &usdc(1_000));
    s.client.open_secured_line(&s.borrower);
    s.client.borrow(&s.borrower, &usdc(50));

    let shares_before = s.client.shares_of(&s.borrower);
    s.client.seize_collateral(&s.borrower);

    // Debt cleared, shares reduced, line settled.
    let (p, i) = s.client.owed(&s.borrower);
    assert_eq!((p, i), (0, 0));
    assert!(s.client.shares_of(&s.borrower) < shares_before);
    assert_eq!(s.client.total_principal_view(), 0);
    assert_eq!(s.client.get_history(&s.borrower).write_offs, 1);
}

#[test]
fn repay_overpayment_is_refunded() {
    let s = setup();
    s.client.deposit(&s.lender, &usdc(1_000));
    s.client.set_line(&s.borrower, &100, &usdc(50), &href(&s.env));
    s.client.borrow(&s.borrower, &usdc(25));
    let bal_before = s.usdc_tok.balance(&s.borrower); // seed + 25 borrowed
    // No time advance → interest 0 → payoff = 25 USDC. Overpay 30; 5 should come back.
    let paid = s.client.repay(&s.borrower, &s.borrower, &usdc(30));
    assert_eq!(paid, usdc(25));
    assert_eq!(s.usdc_tok.balance(&s.borrower), bal_before - usdc(25));
    let (p, i) = s.client.owed(&s.borrower);
    assert_eq!((p, i), (0, 0));
}

#[test]
fn repay_nothing_owed_rejected() {
    let s = setup();
    s.client.deposit(&s.lender, &usdc(1_000));
    s.client.set_line(&s.borrower, &100, &usdc(50), &href(&s.env));
    assert!(s.client.try_repay(&s.borrower, &s.borrower, &usdc(10)).is_err());
}

// ------------------------------------------------------------------ admin --

#[test]
fn ownership_two_step_transfer() {
    let s = setup();
    let new_owner = Address::generate(&s.env);
    s.client.transfer_ownership(&new_owner);
    assert_eq!(s.client.owner_of(), s.owner); // unchanged until accepted
    s.client.accept_ownership();
    assert_eq!(s.client.owner_of(), new_owner);
}

#[test]
fn owner_can_change_underwriter() {
    let s = setup();
    assert_eq!(s.client.underwriter_of(), s.underwriter); // set at initialize
    let new_uw = Address::generate(&s.env);
    s.client.set_underwriter(&new_uw);
    assert_eq!(s.client.underwriter_of(), new_uw);
}

// ===================================================================== vault ==
// A minimal DeFindex-style yield vault: shares track a pro-rata claim on the USDC it holds, so
// adding USDC without minting shares (add_yield) raises every share's value — simulating earned
// yield. It exposes exactly the four methods the pool calls plus a test-only add_yield.
mod mock_vault {
    use soroban_sdk::{contract, contractimpl, contracttype, token, vec, Address, Env, Vec};

    #[contracttype]
    pub enum VK {
        Asset,
        Total,
        Shares(Address),
    }

    #[contract]
    pub struct MockVault;

    #[contractimpl]
    impl MockVault {
        pub fn __constructor(env: Env, asset: Address) {
            env.storage().instance().set(&VK::Asset, &asset);
        }
        fn asset(env: &Env) -> Address {
            env.storage().instance().get(&VK::Asset).unwrap()
        }
        fn total(env: &Env) -> i128 {
            env.storage().instance().get(&VK::Total).unwrap_or(0)
        }
        fn held(env: &Env) -> i128 {
            token::TokenClient::new(env, &Self::asset(env)).balance(&env.current_contract_address())
        }
        pub fn deposit(
            env: Env,
            amounts_desired: Vec<i128>,
            _amounts_min: Vec<i128>,
            from: Address,
            _invest: bool,
        ) -> (Vec<i128>, i128) {
            from.require_auth();
            let amount = amounts_desired.get(0).unwrap();
            let held = Self::held(&env);
            let total = Self::total(&env);
            let shares = if total == 0 || held == 0 { amount } else { amount * total / held };
            token::TokenClient::new(&env, &Self::asset(&env)).transfer(
                &from,
                &env.current_contract_address(),
                &amount,
            );
            env.storage().instance().set(&VK::Total, &(total + shares));
            let s = env.storage().persistent().get(&VK::Shares(from.clone())).unwrap_or(0i128);
            env.storage().persistent().set(&VK::Shares(from.clone()), &(s + shares));
            (amounts_desired, shares)
        }
        pub fn withdraw(
            env: Env,
            withdraw_shares: i128,
            _min_amounts_out: Vec<i128>,
            from: Address,
        ) -> Vec<i128> {
            from.require_auth();
            let held = Self::held(&env);
            let total = Self::total(&env);
            let amount = withdraw_shares * held / total;
            let s = env.storage().persistent().get(&VK::Shares(from.clone())).unwrap_or(0i128);
            env.storage().persistent().set(&VK::Shares(from.clone()), &(s - withdraw_shares));
            env.storage().instance().set(&VK::Total, &(total - withdraw_shares));
            token::TokenClient::new(&env, &Self::asset(&env)).transfer(
                &env.current_contract_address(),
                &from,
                &amount,
            );
            vec![&env, amount]
        }
        pub fn balance(env: Env, id: Address) -> i128 {
            env.storage().persistent().get(&VK::Shares(id)).unwrap_or(0)
        }
        pub fn get_asset_amounts_per_shares(env: Env, vault_shares: i128) -> Vec<i128> {
            let held = Self::held(&env);
            let total = Self::total(&env);
            let amt = if total == 0 { 0 } else { vault_shares * held / total };
            vec![&env, amt]
        }
        /// Test-only: an outsider adds USDC to the vault = yield (value per share rises).
        pub fn add_yield(env: Env, from: Address, amount: i128) {
            from.require_auth();
            token::TokenClient::new(&env, &Self::asset(&env)).transfer(
                &from,
                &env.current_contract_address(),
                &amount,
            );
        }
    }
}

use mock_vault::{MockVault, MockVaultClient};

/// Attach a mock vault (over the same USDC) to the pool with a 20% buffer; return (vault client, yield source).
fn attach_vault(s: &Setup) -> (MockVaultClient<'static>, Address) {
    let usdc_addr = s.usdc_tok.address.clone();
    let vault_id = s.env.register(MockVault, (usdc_addr,));
    let vault = MockVaultClient::new(&s.env, &vault_id);
    s.client.set_vault(&vault_id, &2_000); // 20% buffer, 80% invested
    let yield_src = Address::generate(&s.env);
    s.usdc_admin.mint(&yield_src, &usdc(100_000));
    (vault, yield_src)
}

#[test]
fn vault_parks_idle_above_buffer_and_counts_in_cash() {
    let s = setup();
    let (vault, _) = attach_vault(&s);
    s.client.deposit(&s.lender, &usdc(1_000));
    // 20% buffer stays as raw USDC; 80% is parked in the vault.
    assert_eq!(s.client.idle_cash(), usdc(200));
    assert_eq!(s.client.vault_value(), usdc(800));
    assert_eq!(vault.balance(&s.client.address), usdc(800)); // pool holds the vault shares
    // Total liquidity + pool valuation are unchanged by where the USDC sits.
    assert_eq!(s.client.cash(), usdc(1_000));
    assert_eq!(s.client.total_assets(), usdc(1_000));
}

#[test]
fn vault_yield_lifts_every_lender_share() {
    let s = setup();
    let (vault, ysrc) = attach_vault(&s);
    let shares = s.client.deposit(&s.lender, &usdc(1_000));
    let before = s.client.convert_to_assets(&shares);
    // 100 USDC of yield lands in the vault (on the 800 parked there).
    vault.add_yield(&ysrc, &usdc(100));
    let after = s.client.convert_to_assets(&shares);
    assert_eq!(s.client.vault_value(), usdc(900)); // 800 parked + 100 yield
    assert_eq!(s.client.cash(), usdc(1_100)); // 200 idle + 900 vault
    assert!(after > before, "lender shares must appreciate with vault yield");
    // The lender can withdraw the whole amount, yield included (vault is unwound as needed).
    // (integer share math can shave a stroop of dust — allow a tiny tolerance)
    let got = s.client.withdraw(&s.lender, &shares);
    assert!(close(got, usdc(1_100)), "got {}", got);
    assert!(close(s.usdc_tok.balance(&s.lender), usdc(10_000) + usdc(100)));
}

#[test]
fn borrow_unwinds_from_vault_when_buffer_is_short() {
    let s = setup();
    let (_vault, _) = attach_vault(&s);
    s.client.deposit(&s.lender, &usdc(50)); // idle 10, vault 40
    s.client.set_line(&s.borrower, &100, &usdc(50), &href(&s.env)); // score-100 cap is $50
    // Drawing 50 needs far more than the 10 idle buffer -> the pool unwinds from the vault.
    s.client.borrow(&s.borrower, &usdc(50));
    assert_eq!(s.usdc_tok.balance(&s.borrower), usdc(1_000) + usdc(50));
    assert_eq!(s.client.total_principal_view(), usdc(50));
    assert!(close(s.client.cash(), 0)); // all lent out, nothing left idle or in the vault
}

#[test]
fn withdraw_unwinds_from_vault() {
    let s = setup();
    let (_vault, _) = attach_vault(&s);
    let shares = s.client.deposit(&s.lender, &usdc(1_000)); // idle 200, vault 800
    let got = s.client.withdraw(&s.lender, &shares); // needs to pull ~800 back from the vault
    assert!(close(got, usdc(1_000)), "got {}", got);
    assert!(close(s.usdc_tok.balance(&s.lender), usdc(10_000)));
    assert!(close(s.client.vault_value(), 0));
}

#[test]
fn clear_vault_pulls_everything_back() {
    let s = setup();
    let (_vault, ysrc) = attach_vault(&s);
    s.client.deposit(&s.lender, &usdc(1_000));
    mock_vault::MockVaultClient::new(&s.env, &s.client.vault_address().unwrap())
        .add_yield(&ysrc, &usdc(50));
    s.client.clear_vault();
    assert_eq!(s.client.vault_address(), None);
    assert_eq!(s.client.vault_value(), 0);
    // Everything (principal parked + yield) is back as raw USDC.
    assert!(close(s.client.idle_cash(), usdc(1_050)));
    assert!(close(s.client.total_assets(), usdc(1_050)));
}

#[test]
fn rebalance_idle_sweeps_to_target_buffer() {
    let s = setup();
    let (_vault, _) = attach_vault(&s);
    // Deposit before a vault would normally invest; here simulate idle by depositing then checking sweep.
    s.client.deposit(&s.lender, &usdc(1_000)); // auto-invested to 200/800 already
    // A repayment-like inflow lands as raw USDC; rebalance should re-park the excess.
    s.usdc_admin.mint(&s.client.address, &usdc(300)); // 300 extra idle (now 500 idle, 800 vault)
    s.client.rebalance_idle();
    // target buffer = 20% of 1300 = 260; so idle should drop to ~260, vault ~1040.
    assert_eq!(s.client.idle_cash(), usdc(260));
    assert_eq!(s.client.vault_value(), usdc(1_040));
}
