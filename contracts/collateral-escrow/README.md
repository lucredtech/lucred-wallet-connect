# collateral-escrow (Stage B)

Soroban escrow for dfToken-backed USDC credit. A borrower locks DeFindex vault share tokens
(dfTokens) as collateral; the treasury disburses USDC against them. The contract holds collateral
and loan state and enforces the state machine. It **never prices anything on-chain** — partial
release and liquidation require a short-lived **ed25519 attestation** signed by the off-chain engine.

This is the on-chain half of the dfToken-credit product whose off-chain quote/accept flow shipped in
Stage A (`backend/credit-score-api/collateral-engine.js`, `/df-credit/*`, and the `/borrow` page).

## Lifecycle

```
deposit (borrower locks dfTokens + records terms)
  └─ withdraw        (borrower, only while unfunded)
  └─ disburse        (treasury sends USDC, loan -> Active)
       ├─ record_repayment (treasury, debt decreases only)
       ├─ release          (engine attestation: return excess collateral)
       ├─ margin_call       (engine attestation: flag with a cure deadline)
       ├─ liquidate         (treasury + engine attestation: seize to treasury, surplus to borrower)
       └─ close             (full repayment: return all collateral — needs NO engine signature)
```

Admin: `set_asset` (collateral allowlist), `set_engine_key`, `set_treasury`, `pause` (blocks new
deposits only — withdraw/close/release always work), `upgrade`. There is **no admin sweep**.

## Attestation format

The engine signs, and the contract verifies, this canonical payload:

```
loan_id (32 bytes) || kind (1 byte) || seq (8 bytes BE) || expiry (8 bytes BE) || amount (16 bytes BE, i128)
```

`kind`: 1 = release, 2 = liquidate, 3 = margin_call. `seq` must strictly increase per loan (replay
protection); `expiry` is a ledger timestamp. See `attestation_message` in `src/lib.rs` — the
off-chain engine must reproduce these exact bytes before signing with its ed25519 key.

## Test (no toolchain beyond Rust)

```bash
cargo test
```

Runs the full suite natively (lifecycle, withdraw, attestation + replay/expiry/bad-signature,
liquidation surplus, pause, asset allowlist). `ed25519-dalek` is pinned to 2.x (3.0 breaks
`soroban-env-host`'s test utils).

## Build + deploy (needs the Soroban toolchain — run by the operator)

```bash
rustup target add wasm32v1-none
stellar contract build
stellar contract deploy --wasm target/wasm32v1-none/release/collateral_escrow.wasm --network testnet
# then: initialize(admin, engine_key, treasury, usdc); set_asset(<testnet dfToken vault>, true)
```

Testnet first. The engine key is the ed25519 public key whose attestations the contract trusts
(Secret Manager on testnet; Cloud KMS for mainnet). Mainnet is gated on an external audit + legal
review (real custody/seizure).
