#![no_std]
//! Permissionless testnet faucet for the two mock tokens (dfToken collateral + mock USDC).
//!
//! `drip` sends a fixed amount of each token from the faucet's own balance to the caller, guarded by
//! a per-address cooldown. The faucet is pre-funded by minting the two tokens to its contract address
//! (it holds no mint authority itself), so it can only ever give away what it was funded with. The
//! caller authorizes `drip` for their own address, so nobody can spend the faucet into others' cooldowns.
//! Testnet only — no real value.
use soroban_sdk::{contract, contracterror, contractimpl, contracttype, panic_with_error, token, Address, Env};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Cooldown = 3,
}

#[contracttype]
pub enum Key {
    Admin,
    Df,
    Usdc,
    DfAmount,
    UsdcAmount,
    CooldownSec,
    Last(Address),
}

#[contracttype]
#[derive(Clone)]
pub struct Info {
    pub df: Address,
    pub usdc: Address,
    pub df_amount: i128,
    pub usdc_amount: i128,
    pub cooldown_sec: u64,
}

#[contract]
pub struct Faucet;

#[contractimpl]
impl Faucet {
    pub fn initialize(env: Env, admin: Address, df: Address, usdc: Address, df_amount: i128, usdc_amount: i128, cooldown_sec: u64) {
        let s = env.storage().instance();
        if s.has(&Key::Admin) {
            panic_with_error!(&env, Error::AlreadyInitialized);
        }
        s.set(&Key::Admin, &admin);
        s.set(&Key::Df, &df);
        s.set(&Key::Usdc, &usdc);
        s.set(&Key::DfAmount, &df_amount);
        s.set(&Key::UsdcAmount, &usdc_amount);
        s.set(&Key::CooldownSec, &cooldown_sec);
    }

    /// Admin can retune the dispensed amounts / cooldown (e.g. as test needs change).
    pub fn set_amounts(env: Env, df_amount: i128, usdc_amount: i128, cooldown_sec: u64) {
        Self::admin(&env).require_auth();
        let s = env.storage().instance();
        s.set(&Key::DfAmount, &df_amount);
        s.set(&Key::UsdcAmount, &usdc_amount);
        s.set(&Key::CooldownSec, &cooldown_sec);
    }

    /// Send the configured amount of each token to `to` (who must authorize), once per cooldown window.
    pub fn drip(env: Env, to: Address) {
        to.require_auth();
        let s = env.storage().instance();
        let cooldown: u64 = s.get(&Key::CooldownSec).unwrap_or(0);
        let now = env.ledger().timestamp();
        let last: u64 = env.storage().persistent().get(&Key::Last(to.clone())).unwrap_or(0);
        if last != 0 && now < last + cooldown {
            panic_with_error!(&env, Error::Cooldown);
        }
        let df: Address = s.get(&Key::Df).unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized));
        let usdc: Address = s.get(&Key::Usdc).unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized));
        let df_amount: i128 = s.get(&Key::DfAmount).unwrap_or(0);
        let usdc_amount: i128 = s.get(&Key::UsdcAmount).unwrap_or(0);
        let here = env.current_contract_address();
        if df_amount > 0 {
            token::TokenClient::new(&env, &df).transfer(&here, &to, &df_amount);
        }
        if usdc_amount > 0 {
            token::TokenClient::new(&env, &usdc).transfer(&here, &to, &usdc_amount);
        }
        env.storage().persistent().set(&Key::Last(to.clone()), &now);
        env.events().publish((soroban_sdk::symbol_short!("drip"), to), (df_amount, usdc_amount));
    }

    // ---- views ----
    pub fn info(env: Env) -> Info {
        let s = env.storage().instance();
        Info {
            df: s.get(&Key::Df).unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized)),
            usdc: s.get(&Key::Usdc).unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized)),
            df_amount: s.get(&Key::DfAmount).unwrap_or(0),
            usdc_amount: s.get(&Key::UsdcAmount).unwrap_or(0),
            cooldown_sec: s.get(&Key::CooldownSec).unwrap_or(0),
        }
    }

    /// Seconds until `to` can drip again (0 = ready now).
    pub fn cooldown_remaining(env: Env, to: Address) -> u64 {
        let cooldown: u64 = env.storage().instance().get(&Key::CooldownSec).unwrap_or(0);
        let last: u64 = env.storage().persistent().get(&Key::Last(to)).unwrap_or(0);
        let now = env.ledger().timestamp();
        if last == 0 || now >= last + cooldown { 0 } else { last + cooldown - now }
    }

    fn admin(env: &Env) -> Address {
        env.storage().instance().get(&Key::Admin).unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized))
    }
}

#[cfg(test)]
mod test;
