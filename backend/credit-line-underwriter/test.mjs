// Offline tests for the underwriter's signature verification and message parsing.
// No network, no on-chain calls. Run: node test.mjs
import assert from "node:assert";
import crypto from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";

// server.mjs reads these at import time; set them so the module loads without a real deployment.
process.env.PORT = "0"; // do not listen
process.env.POOL = "CC62VXXDIRDAIP4QN6TLNLN77N5KBSHHQJ3TOQUNC7Z7M26VXKW4XJKZ";
process.env.UNDERWRITER_SECRET = Keypair.random().secret();

const { verifyStellarMessage, parseMessage } = await import("./server.mjs");

function sep53Sign(kp, message) {
  const data = crypto.createHash("sha256")
    .update(Buffer.concat([Buffer.from("Stellar Signed Message:\n"), Buffer.from(message, "utf8")]))
    .digest();
  return Buffer.from(kp.sign(data)).toString("hex"); // kp.sign returns a Uint8Array
}

let passed = 0;
const ok = (name) => { console.log("ok -", name); passed++; };

// --- signature verification ---
{
  const kp = Keypair.random();
  const g = kp.publicKey();
  const message = `LCRD credit on Stellar\nStellar wallet: ${g}\nIssued: ${new Date().toISOString()}`;
  assert.strictEqual(verifyStellarMessage(g, message, sep53Sign(kp, message)), true);
  ok("accepts a valid SEP-53 signature");

  // Raw-message variant is also accepted.
  const rawSig = Buffer.from(kp.sign(Buffer.from(message, "utf8"))).toString("hex");
  assert.strictEqual(verifyStellarMessage(g, message, rawSig), true);
  ok("accepts the raw-message variant");

  // Wrong signer is rejected.
  const other = Keypair.random();
  assert.strictEqual(verifyStellarMessage(g, message, sep53Sign(other, message)), false);
  ok("rejects a signature from a different key");

  // Tampered message is rejected.
  assert.strictEqual(verifyStellarMessage(g, message + " ", sep53Sign(kp, message)), false);
  ok("rejects a tampered message");

  // Garbage signature is rejected, not thrown.
  assert.strictEqual(verifyStellarMessage(g, message, "00"), false);
  ok("rejects a malformed signature length");

  assert.throws(() => verifyStellarMessage("not-a-g-address", message, "00"));
  ok("throws on a non-G address");
}

// --- message parsing ---
{
  const g = Keypair.random().publicKey();
  const fresh = `LCRD credit on Stellar\nStellar wallet: ${g}\nIssued: ${new Date().toISOString()}`;
  assert.deepStrictEqual(parseMessage(fresh), { stellar: g });
  ok("parses a fresh message");

  const stale = `LCRD credit on Stellar\nStellar wallet: ${g}\nIssued: ${new Date(Date.now() - 20 * 60 * 1000).toISOString()}`;
  assert.throws(() => parseMessage(stale), /expired/);
  ok("rejects an expired message");

  assert.throws(() => parseMessage("hello"));
  ok("rejects an unrecognised format");
}

console.log(`\n${passed} passed`);
