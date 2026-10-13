const assert = require("assert");
const att = require("../attestation");

// 1. Byte layout must match the contract's attestation_message (contracts/collateral-escrow/src/lib.rs):
//    loan_id(32) || kind(1) || seq(8 BE) || expiry(8 BE) || amount(16 BE i128)
const loanIdHex = "04".repeat(32);
const params = { loanId: loanIdHex, kind: "release", seq: 1, expiry: 2_000_000, amount: 200 };
const msg = att.buildMessage(params);
assert.strictEqual(msg.length, 65, "message must be 65 bytes");
assert.ok(msg.subarray(0, 32).equals(Buffer.from(loanIdHex, "hex")), "loan_id first 32 bytes");
assert.strictEqual(msg[32], 1, "kind byte (release=1)");
assert.ok(msg.subarray(33, 41).equals(Buffer.from([0, 0, 0, 0, 0, 0, 0, 1])), "seq u64 BE");
assert.ok(msg.subarray(41, 49).equals(Buffer.from([0, 0, 0, 0, 0, 0x1e, 0x84, 0x80])), "expiry u64 BE (2_000_000)");
assert.ok(msg.subarray(49, 65).equals(Buffer.from("000000000000000000000000000000c8", "hex")), "amount i128 BE (200)");

// 2. Helpers.
assert.ok(att.u64be(1).equals(Buffer.from([0, 0, 0, 0, 0, 0, 0, 1])));
assert.strictEqual(att.i128be(200).length, 16);
assert.strictEqual(att.i128be(200)[15], 0xc8);
assert.deepStrictEqual(att.KIND, { release: 1, liquidate: 2, margin_call: 3 });

// 3. Key from a 32-byte seed -> 32-byte raw public key (what the contract stores).
const seed = "07".repeat(32);
const priv = att.engineKeyFromSeed(seed);
const pub = att.publicKeyRaw(priv);
assert.strictEqual(pub.length, 32, "raw ed25519 public key is 32 bytes");

// 4. Sign -> 64-byte raw signature that verifies against the raw public key.
const sig = att.sign(params, priv);
assert.strictEqual(sig.length, 64, "signature is 64 bytes");
assert.strictEqual(att.verify(params, sig, pub), true, "valid signature verifies");

// 5. Any tamper (amount, kind, seq, expiry, loan_id) must fail verification.
assert.strictEqual(att.verify({ ...params, amount: 201 }, sig, pub), false, "tampered amount rejected");
assert.strictEqual(att.verify({ ...params, kind: "liquidate" }, sig, pub), false, "tampered kind rejected");
assert.strictEqual(att.verify({ ...params, seq: 2 }, sig, pub), false, "tampered seq rejected");
assert.strictEqual(att.verify({ ...params, expiry: 2_000_001 }, sig, pub), false, "tampered expiry rejected");
assert.strictEqual(att.verify({ ...params, loanId: "05".repeat(32) }, sig, pub), false, "tampered loan_id rejected");

// 6. ed25519 is deterministic: signing the same message twice gives the same signature.
assert.ok(att.sign(params, priv).equals(sig), "deterministic signature");

// 7. Negative / large i128 amounts round-trip through the two's-complement encoding.
const big = { ...params, amount: "170141183460469231731687303715884105727" }; // i128::MAX
const sigBig = att.sign(big, priv);
assert.strictEqual(att.verify(big, sigBig, pub), true, "i128::MAX amount signs/verifies");

console.log("all attestation assertions passed");
