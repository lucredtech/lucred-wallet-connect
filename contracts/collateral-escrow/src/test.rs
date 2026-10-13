#![cfg(test)]
extern crate std;

use super::*;
use ed25519_dalek::{Signer, SigningKey};
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{token, Address, BytesN, Env};

// Build the exact attestation byte layout the contract verifies, as a fixed-size array (no std Vec).
fn message(loan_id: &[u8; 32], kind: u8, seq: u64, expiry: u64, amount: i128) -> [u8; 65] {
    let mut m = [0u8; 65];
    m[0..32].copy_from_slice(loan_id);
    m[32] = kind;
    m[33..41].copy_from_slice(&seq.to_be_bytes());
    m[41..49].copy_from_slice(&expiry.to_be_bytes());
    m[49..65].copy_from_slice(&amount.to_be_bytes());
    m
}

struct Setup {
    env: Env,
    client: CollateralEscrowClient<'static>,
    borrower: Address,
    treasury: Address,
    collateral: Address,
    collateral_tok: token::TokenClient<'static>,
    usdc: Address,
    usdc_tok: token::TokenClient<'static>,
    engine_sk: SigningKey,
}

fn setup() -> Setup {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.timestamp = 1_000_000);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let borrower = Address::generate(&env);

    // Two Stellar-asset tokens: the dfToken collateral and USDC.
    let collateral_sac = env.register_stellar_asset_contract_v2(admin.clone());
    let usdc_sac = env.register_stellar_asset_contract_v2(admin.clone());
    let collateral = collateral_sac.address();
    let usdc = usdc_sac.address();
    let collateral_tok = token::TokenClient::new(&env, &collateral);
    let usdc_tok = token::TokenClient::new(&env, &usdc);
    token::StellarAssetClient::new(&env, &collateral).mint(&borrower, &1000);
    token::StellarAssetClient::new(&env, &usdc).mint(&treasury, &10_000);

    // Engine ed25519 keypair (deterministic for the test).
    let engine_sk = SigningKey::from_bytes(&[7u8; 32]);
    let engine_key = BytesN::from_array(&env, &engine_sk.verifying_key().to_bytes());

    let id = env.register(CollateralEscrow, ());
    let client = CollateralEscrowClient::new(&env, &id);
    client.initialize(&admin, &engine_key, &treasury, &usdc);
    client.set_asset(&collateral, &true);

    Setup { env, client, borrower, treasury, collateral, collateral_tok, usdc, usdc_tok, engine_sk }
}

fn lid(env: &Env, b: u8) -> BytesN<32> {
    BytesN::from_array(env, &[b; 32])
}

fn sign(s: &Setup, loan_id: &[u8; 32], kind: u8, seq: u64, expiry: u64, amount: i128) -> BytesN<64> {
    let sig = s.engine_sk.sign(&message(loan_id, kind, seq, expiry, amount));
    BytesN::from_array(&s.env, &sig.to_bytes())
}

#[test]
fn full_lifecycle_deposit_disburse_repay_close() {
    let s = setup();
    let id = lid(&s.env, 1);
    s.client.deposit(&id, &s.borrower, &s.collateral, &1000, &600, &1200, &Structure::OpenEnded, &0);

    assert_eq!(s.collateral_tok.balance(&s.borrower), 0);
    assert_eq!(s.collateral_tok.balance(&s.client.address), 1000);

    s.client.disburse(&id);
    assert_eq!(s.usdc_tok.balance(&s.borrower), 600);
    assert_eq!(s.usdc_tok.balance(&s.treasury), 9400);
    let loan = s.client.get_loan(&id);
    assert_eq!(loan.debt, 600);
    assert_eq!(loan.status, LoanStatus::Active);

    s.client.record_repayment(&id, &600);
    assert_eq!(s.client.get_loan(&id).debt, 0);

    s.client.close(&id);
    assert_eq!(s.collateral_tok.balance(&s.borrower), 1000); // collateral returned
    assert_eq!(s.client.get_loan(&id).status, LoanStatus::Closed);
}

#[test]
fn withdraw_before_funding() {
    let s = setup();
    let id = lid(&s.env, 2);
    s.client.deposit(&id, &s.borrower, &s.collateral, &1000, &600, &1200, &Structure::OpenEnded, &0);
    s.client.withdraw(&id);
    assert_eq!(s.collateral_tok.balance(&s.borrower), 1000);
    // Loan entry removed.
    assert!(s.client.try_get_loan(&id).is_err());
}

#[test]
fn cannot_withdraw_after_disburse() {
    let s = setup();
    let id = lid(&s.env, 3);
    s.client.deposit(&id, &s.borrower, &s.collateral, &1000, &600, &1200, &Structure::OpenEnded, &0);
    s.client.disburse(&id);
    let res = s.client.try_withdraw(&id);
    assert_eq!(res, Err(Ok(Error::BadStatus.into())));
}

#[test]
fn release_with_attestation_and_replay_protection() {
    let s = setup();
    let id = lid(&s.env, 4);
    let raw = [4u8; 32];
    s.client.deposit(&id, &s.borrower, &s.collateral, &1000, &600, &1200, &Structure::OpenEnded, &0);
    s.client.disburse(&id);

    let expiry = 2_000_000u64;
    let sig = sign(&s, &raw, RELEASE, 1, expiry, 200);
    s.client.release(&id, &200, &1, &expiry, &sig);
    assert_eq!(s.collateral_tok.balance(&s.borrower), 200);
    assert_eq!(s.client.get_loan(&id).collateral_amount, 800);

    // Replaying the same seq is rejected.
    let res = s.client.try_release(&id, &200, &1, &expiry, &sig);
    assert_eq!(res, Err(Ok(Error::StaleSeq.into())));
}

#[test]
#[should_panic]
fn release_with_bad_signature_panics() {
    let s = setup();
    let id = lid(&s.env, 5);
    let raw = [5u8; 32];
    s.client.deposit(&id, &s.borrower, &s.collateral, &1000, &600, &1200, &Structure::OpenEnded, &0);
    s.client.disburse(&id);
    // Sign a different amount than we submit -> signature won't match the verified message.
    let expiry = 2_000_000u64;
    let sig = sign(&s, &raw, RELEASE, 1, expiry, 999);
    s.client.release(&id, &200, &1, &expiry, &sig);
}

#[test]
fn release_expired_rejected() {
    let s = setup();
    let id = lid(&s.env, 6);
    let raw = [6u8; 32];
    s.client.deposit(&id, &s.borrower, &s.collateral, &1000, &600, &1200, &Structure::OpenEnded, &0);
    s.client.disburse(&id);
    let expiry = 999_999u64; // already in the past (now = 1_000_000)
    let sig = sign(&s, &raw, RELEASE, 1, expiry, 200);
    let res = s.client.try_release(&id, &200, &1, &expiry, &sig);
    assert_eq!(res, Err(Ok(Error::Expired.into())));
}

#[test]
fn liquidate_returns_surplus() {
    let s = setup();
    let id = lid(&s.env, 7);
    let raw = [7u8; 32];
    s.client.deposit(&id, &s.borrower, &s.collateral, &1000, &600, &1200, &Structure::OpenEnded, &0);
    s.client.disburse(&id);

    let expiry = 2_000_000u64;
    let sig = sign(&s, &raw, LIQUIDATE, 1, expiry, 700);
    s.client.liquidate(&id, &700, &1, &expiry, &sig);

    assert_eq!(s.collateral_tok.balance(&s.treasury), 700); // seized
    assert_eq!(s.collateral_tok.balance(&s.borrower), 300); // surplus returned
    assert_eq!(s.client.get_loan(&id).status, LoanStatus::Liquidated);
}

#[test]
fn pause_blocks_deposit_but_not_close() {
    let s = setup();
    // An existing funded+repaid loan can still close while paused.
    let id = lid(&s.env, 8);
    s.client.deposit(&id, &s.borrower, &s.collateral, &1000, &600, &1200, &Structure::OpenEnded, &0);
    s.client.disburse(&id);
    s.client.record_repayment(&id, &600);

    s.client.pause(&true);

    // New deposit blocked.
    let id2 = lid(&s.env, 9);
    token::StellarAssetClient::new(&s.env, &s.collateral).mint(&s.borrower, &500);
    let res = s.client.try_deposit(&id2, &s.borrower, &s.collateral, &500, &100, &1200, &Structure::OpenEnded, &0);
    assert_eq!(res, Err(Ok(Error::Paused.into())));

    // Close still works.
    s.client.close(&id);
    assert_eq!(s.client.get_loan(&id).status, LoanStatus::Closed);
}

#[test]
fn deposit_rejects_non_whitelisted_asset() {
    let s = setup();
    let other = env_other_token(&s);
    let id = lid(&s.env, 10);
    let res = s.client.try_deposit(&id, &s.borrower, &other, &100, &50, &1200, &Structure::OpenEnded, &0);
    assert_eq!(res, Err(Ok(Error::AssetNotAllowed.into())));
}

fn env_other_token(s: &Setup) -> Address {
    let admin = Address::generate(&s.env);
    let sac = s.env.register_stellar_asset_contract_v2(admin);
    let addr = sac.address();
    token::StellarAssetClient::new(&s.env, &addr).mint(&s.borrower, &100);
    addr
}

// ---- cross-stack interop: a signature produced by backend/attestation.js (node:crypto ed25519)
// must be accepted by the contract, proving the off-chain engine and on-chain verifier agree on the
// exact byte layout. PUB/SIG below were generated by attestation.js for
// (loan_id = 04*32, kind=release, seq=1, expiry=2_000_000, amount=200) with engine seed 07*32.
const NODE_PUB: &str = "ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c";
const NODE_SIG: &str = "5f9a079bda93845901c474e40766cddec9f203c5ee68b5fbea8e3e2f306afa57ebb8c13df6b8dc866b7ff0d2513ac8e655d1f7f7bd87cf74205e75304ec83b09";

fn unhex<const N: usize>(s: &str) -> [u8; N] {
    let mut a = [0u8; N];
    for i in 0..N {
        a[i] = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap();
    }
    a
}

#[test]
fn verifies_node_signed_attestation() {
    let s = setup();
    // Point the contract at the Node engine public key.
    s.client.set_engine_key(&BytesN::from_array(&s.env, &unhex::<32>(NODE_PUB)));
    let id = lid(&s.env, 4); // == [4u8; 32], the loan_id that was signed
    s.client.deposit(&id, &s.borrower, &s.collateral, &1000, &600, &1200, &Structure::OpenEnded, &0);
    s.client.disburse(&id);
    // Submit the node-produced signature for release(amount=200, seq=1, expiry=2_000_000).
    let sig = BytesN::from_array(&s.env, &unhex::<64>(NODE_SIG));
    s.client.release(&id, &200, &1, &2_000_000u64, &sig);
    assert_eq!(s.collateral_tok.balance(&s.borrower), 200);
    assert_eq!(s.client.get_loan(&id).collateral_amount, 800);
}
