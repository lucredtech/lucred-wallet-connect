#![no_std]
//! Minimal native Soroban (SEP-41) token for testnet testing — a faithful stand-in for a DeFindex
//! dfToken or test USDC. Native contract balances (no trustlines), admin-mintable. Implements the
//! subset of the token interface the escrow uses (transfer, balance) plus mint and the metadata
//! getters, so `soroban_sdk::token::TokenClient` works against it.
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, String};

#[contracttype]
pub enum DataKey {
    Admin,
    Decimals,
    Name,
    Symbol,
    Balance(Address),
}

#[contract]
pub struct MockToken;

#[contractimpl]
impl MockToken {
    pub fn initialize(env: Env, admin: Address, decimals: u32, name: String, symbol: String) {
        let s = env.storage().instance();
        if s.has(&DataKey::Admin) {
            panic!("already initialized");
        }
        s.set(&DataKey::Admin, &admin);
        s.set(&DataKey::Decimals, &decimals);
        s.set(&DataKey::Name, &name);
        s.set(&DataKey::Symbol, &symbol);
    }

    pub fn mint(env: Env, to: Address, amount: i128) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        if amount < 0 {
            panic!("negative amount");
        }
        let b = Self::balance(env.clone(), to.clone());
        env.storage().persistent().set(&DataKey::Balance(to.clone()), &(b + amount));
        env.events().publish((soroban_sdk::symbol_short!("mint"), to), amount);
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        env.storage().persistent().get(&DataKey::Balance(id)).unwrap_or(0)
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        if amount < 0 {
            panic!("negative amount");
        }
        let fb = Self::balance(env.clone(), from.clone());
        if fb < amount {
            panic!("insufficient balance");
        }
        env.storage().persistent().set(&DataKey::Balance(from.clone()), &(fb - amount));
        let tb = Self::balance(env.clone(), to.clone());
        env.storage().persistent().set(&DataKey::Balance(to.clone()), &(tb + amount));
        env.events().publish((soroban_sdk::symbol_short!("transfer"), from, to), amount);
    }

    pub fn decimals(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::Decimals).unwrap_or(7)
    }
    pub fn name(env: Env) -> String {
        env.storage().instance().get(&DataKey::Name).unwrap_or_else(|| String::from_str(&env, "Mock"))
    }
    pub fn symbol(env: Env) -> String {
        env.storage().instance().get(&DataKey::Symbol).unwrap_or_else(|| String::from_str(&env, "MOCK"))
    }
}
