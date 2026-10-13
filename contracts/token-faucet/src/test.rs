#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{token, Address, Env};

struct Setup {
    env: Env,
    client: FaucetClient<'static>,
    user: Address,
    df: Address,
    usdc: Address,
    df_tok: token::TokenClient<'static>,
    usdc_tok: token::TokenClient<'static>,
}

fn setup(df_amt: i128, usdc_amt: i128, cooldown: u64) -> Setup {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.timestamp = 1_000_000);

    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let df_sac = env.register_stellar_asset_contract_v2(admin.clone());
    let usdc_sac = env.register_stellar_asset_contract_v2(admin.clone());
    let df = df_sac.address();
    let usdc = usdc_sac.address();
    let df_tok = token::TokenClient::new(&env, &df);
    let usdc_tok = token::TokenClient::new(&env, &usdc);

    let id = env.register(Faucet, ());
    let client = FaucetClient::new(&env, &id);
    client.initialize(&admin, &df, &usdc, &df_amt, &usdc_amt, &cooldown);

    // Pre-fund the faucet contract.
    token::StellarAssetClient::new(&env, &df).mint(&client.address, &1_000_000);
    token::StellarAssetClient::new(&env, &usdc).mint(&client.address, &1_000_000);

    Setup { env, client, user, df, usdc, df_tok, usdc_tok }
}

#[test]
fn drip_sends_both_tokens() {
    let s = setup(10_000, 5_000, 3600);
    s.client.drip(&s.user);
    assert_eq!(s.df_tok.balance(&s.user), 10_000);
    assert_eq!(s.usdc_tok.balance(&s.user), 5_000);
}

#[test]
fn drip_respects_cooldown_then_allows_again() {
    let s = setup(10_000, 5_000, 3600);
    s.client.drip(&s.user);
    // Immediate second drip is blocked.
    let res = s.client.try_drip(&s.user);
    assert_eq!(res, Err(Ok(Error::Cooldown.into())));
    assert_eq!(s.client.cooldown_remaining(&s.user), 3600);

    // After the cooldown elapses it works again.
    s.env.ledger().with_mut(|l| l.timestamp = 1_000_000 + 3600);
    assert_eq!(s.client.cooldown_remaining(&s.user), 0);
    s.client.drip(&s.user);
    assert_eq!(s.df_tok.balance(&s.user), 20_000);
    assert_eq!(s.usdc_tok.balance(&s.user), 10_000);
}

#[test]
fn info_reports_config() {
    let s = setup(10_000, 5_000, 3600);
    let i = s.client.info();
    assert_eq!(i.df, s.df);
    assert_eq!(i.usdc, s.usdc);
    assert_eq!(i.df_amount, 10_000);
    assert_eq!(i.usdc_amount, 5_000);
    assert_eq!(i.cooldown_sec, 3600);
}
