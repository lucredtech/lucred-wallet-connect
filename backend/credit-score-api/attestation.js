// Engine attestation signing for the collateral-escrow contract (Stage B).
//
// The off-chain engine signs short-lived ed25519 attestations that authorize partial release and
// liquidation on-chain. The contract verifies the signature over this EXACT canonical payload
// (see contracts/collateral-escrow/src/lib.rs `attestation_message`):
//
//   loan_id(32) || kind(1) || seq(8, big-endian u64) || expiry(8, big-endian u64) || amount(16, big-endian i128)
//
// kind: 1 = release, 2 = liquidate, 3 = margin_call. `seq` must strictly increase per loan (replay
// protection); `expiry` is a ledger (unix) timestamp after which the contract rejects it.
//
// The engine private key never leaves the server (Secret Manager on testnet; Cloud KMS for mainnet).
const crypto = require("crypto");

const KIND = { release: 1, liquidate: 2, margin_call: 3 };

function u64be(n) {
  const b = Buffer.alloc(8);
  let x = BigInt.asUintN(64, BigInt(n));
  for (let i = 7; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; }
  return b;
}

function i128be(v) {
  const b = Buffer.alloc(16);
  let x = BigInt.asUintN(128, BigInt(v)); // two's complement, matches Rust i128::to_be_bytes()
  for (let i = 15; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; }
  return b;
}

/** Build the canonical 65-byte attestation message. loanId: 32-byte Buffer or 64-char hex. */
function buildMessage({ loanId, kind, seq, expiry, amount }) {
  const id = Buffer.isBuffer(loanId) ? loanId : Buffer.from(String(loanId).replace(/^0x/, ""), "hex");
  if (id.length !== 32) throw new Error("loanId must be 32 bytes");
  const k = typeof kind === "number" ? kind : KIND[kind];
  if (!k || k < 1 || k > 255) throw new Error("invalid kind");
  return Buffer.concat([id, Buffer.from([k]), u64be(seq), u64be(expiry), i128be(amount)]);
}

/** Load an ed25519 private key from a 32-byte seed (hex). Wraps the seed in the PKCS8 DER prefix. */
function engineKeyFromSeed(seedHex) {
  const seed = Buffer.from(String(seedHex).replace(/^0x/, ""), "hex");
  if (seed.length !== 32) throw new Error("engine seed must be 32 bytes");
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  return crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

/** The 32-byte raw ed25519 public key (what the contract stores as its engine key). */
function publicKeyRaw(privateKey) {
  const jwk = crypto.createPublicKey(privateKey).export({ format: "jwk" });
  return Buffer.from(jwk.x, "base64url");
}

/** Sign an attestation. Returns the 64-byte raw ed25519 signature the contract verifies. */
function sign(params, privateKey) {
  return crypto.sign(null, buildMessage(params), privateKey);
}

/** Verify against a 32-byte raw public key (Buffer) — useful for tests / self-check. */
function verify(params, signature, publicKeyRawBuf) {
  const jwk = { kty: "OKP", crv: "Ed25519", x: Buffer.from(publicKeyRawBuf).toString("base64url") };
  const pub = crypto.createPublicKey({ key: jwk, format: "jwk" });
  return crypto.verify(null, buildMessage(params), pub, signature);
}

module.exports = { KIND, buildMessage, engineKeyFromSeed, publicKeyRaw, sign, verify, u64be, i128be };
