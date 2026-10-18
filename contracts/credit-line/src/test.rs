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
    // Site example: score 71 → 8% + 7.93% + 3% = 18.93% = 1893 bps, tier A, 100 USDC starter.
    let (tier, apr, max) = s.client.quote(&71, &0);
    assert_eq!(tier, 1);
    assert_eq!(apr, 1893);
    assert_eq!(max, usdc(100));

    // Tier B lower half (score 40): eligible for no unsecured line (needs 55+).
    let (tier_b, _, max_b) = s.client.quote(&40, &0);
    assert_eq!(tier_b, 2);
    assert_eq!(max_b, 0);

    // Tier B upper half (score 60): 75 USDC starter.
    let (_, _, max_b2) = s.client.quote(&60, &0);
    assert_eq!(max_b2, usdc(75));

    // Tier C: never an unsecured line.
    let (tier_c, _, max_c) = s.client.quote(&10, &0);
    assert_eq!(tier_c, 3);
    assert_eq!(max_c, 0);

    // Cycle discount lowers APR and raises the limit; clamped at the ceiling / 200 bps.
    let (_, apr1, max1) = s.client.quote(&71, &1);
    assert_eq!(apr1, 1843); // −50 bps
    assert_eq!(max1, usdc(200)); // starter × (1 + cycles)
    let (_, apr9, _) = s.client.quote(&71, &9);
    assert_eq!(apr9, 1693); // discount capped at 200 bps
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
    s.client.set_line(&s.borrower, &71, &usdc(100), &href(&s.env));

    let line = s.client.get_line(&s.borrower);
    assert_eq!(line.tier, 1);
    assert_eq!(line.apr_bps, 1893);
    assert_eq!(line.limit, usdc(100));
    assert!(!line.secured && line.active);

    s.client.borrow(&s.borrower, &usdc(50));
    assert_eq!(s.client.get_line(&s.borrower).principal, usdc(50));
    assert_eq!(s.client.total_principal_view(), usdc(50));

    advance(&s.env, YEAR_SECS);
    // 18.93% of 50 USDC = 9.465 USDC.
    let (principal, interest) = s.client.owed(&s.borrower);
    assert_eq!(principal, usdc(50));
    assert_eq!(interest, 94_650_000);

    let payoff = principal + interest;
    let paid = s.client.repay(&s.borrower, &s.borrower, &payoff);
    assert_eq!(paid, payoff);
    let (p2, i2) = s.client.owed(&s.borrower);
    assert_eq!((p2, i2), (0, 0));
    // Repaid interest accrues to the pool (share value rises).
    assert_eq!(s.client.total_repaid_interest(), 94_650_000);
    assert_eq!(s.client.total_assets(), usdc(1_000) + 94_650_000);
}

#[test]
fn borrow_over_limit_rejected() {
    let s = setup();
    s.client.deposit(&s.lender, &usdc(1_000));
    s.client.set_line(&s.borrower, &71, &usdc(100), &href(&s.env));
    assert!(s.client.try_borrow(&s.borrower, &usdc(101)).is_err());
}

#[test]
fn set_line_over_tier_max_rejected() {
    let s = setup();
    // Tier A starter max is 100 USDC at 0 cycles.
    assert!(s.client.try_set_line(&s.borrower, &71, &usdc(101), &href(&s.env)).is_err());
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
    s.client.set_line(&s.borrower, &71, &usdc(100), &href(&s.env));
    assert!(s.client.try_borrow(&s.borrower, &usdc(50)).is_err());
}

// ----------------------------------------------------------------- cycles --

#[test]
fn qualifying_cycle_lowers_apr_and_grows_limit() {
    let s = setup();
    s.client.deposit(&s.lender, &usdc(1_000));
    s.client.set_line(&s.borrower, &71, &usdc(100), &href(&s.env));

    s.client.borrow(&s.borrower, &usdc(25)); // ≥ 25% of the 100 limit
    advance(&s.env, 8 * DAY); // ≥ 7 days
    let (p, i) = s.client.owed(&s.borrower);
    s.client.repay(&s.borrower, &s.borrower, &(p + i));

    let h = s.client.get_history(&s.borrower);
    assert_eq!(h.cycles_completed, 1);
    assert_eq!(h.repayments, 1);
    // APR dropped 50 bps automatically.
    assert_eq!(s.client.get_line(&s.borrower).apr_bps, 1843);
    // Next line may now reach a higher limit.
    let (_, _, max) = s.client.quote(&71, &h.cycles_completed);
    assert_eq!(max, usdc(200));
}

#[test]
fn dust_loan_does_not_complete_a_cycle() {
    let s = setup();
    s.client.deposit(&s.lender, &usdc(1_000));
    s.client.set_line(&s.borrower, &71, &usdc(100), &href(&s.env));

    s.client.borrow(&s.borrower, &usdc(10)); // < 25% of the limit
    advance(&s.env, 8 * DAY);
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
    s.client.set_line(&s.borrower, &71, &usdc(100), &href(&s.env));
    s.client.borrow(&s.borrower, &usdc(50));
    let assets_before = s.client.total_assets();

    s.client.write_off(&s.borrower);
    assert_eq!(s.client.total_written_off(), usdc(50));
    assert_eq!(s.client.total_principal_view(), 0);
    // Principal left the pool's assets, so lenders bear the loss.
    assert_eq!(s.client.total_assets(), assets_before - usdc(50));
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
    s.client.set_line(&s.borrower, &71, &usdc(100), &href(&s.env));
    s.client.borrow(&s.borrower, &usdc(50));
    let bal_before = s.usdc_tok.balance(&s.borrower); // seed + 50 borrowed
    // No time advance → interest 0 → payoff = 50 USDC. Overpay 60; 10 should come back.
    let paid = s.client.repay(&s.borrower, &s.borrower, &usdc(60));
    assert_eq!(paid, usdc(50));
    assert_eq!(s.usdc_tok.balance(&s.borrower), bal_before - usdc(50));
    let (p, i) = s.client.owed(&s.borrower);
    assert_eq!((p, i), (0, 0));
}

#[test]
fn repay_nothing_owed_rejected() {
    let s = setup();
    s.client.deposit(&s.lender, &usdc(1_000));
    s.client.set_line(&s.borrower, &71, &usdc(100), &href(&s.env));
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
