// LCRD automated underwriter for the Stellar credit-line pool.
//
// A borrower proves they control a Stellar wallet (one signed message), LCRD scores that wallet's
// on-chain history, and if the tier qualifies this service opens the line on the Soroban pool with its
// own underwriter key. The contract prices the line from the score and caps it by tier, so this key can
// never grant a cheaper or larger line than policy allows.
//
// Simpler than the Arc/EVM original: on Stellar the borrower's wallet IS the scored identity and the
// on-chain borrower, so there is no second chain and no cross-wallet link.
//
// Env: UNDERWRITER_SECRET (S… seed), POOL (C… contract id), SOROBAN_RPC, NETWORK_PASSPHRASE,
//      SCORE_API, AUTO_MAX_LIMIT_USDC, ALLOWED_ORIGINS (comma-separated), PORT, DATA_DIR
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  Address, BASE_FEE, Contract, Keypair, Networks, TransactionBuilder, nativeToScVal, scValToNative, rpc,
} from "@stellar/stellar-sdk";

const env = (k, d) => process.env[k] ?? d;
const POOL = env("POOL");
const SOROBAN_RPC = env("SOROBAN_RPC", "https://soroban-testnet.stellar.org");
const NET = env("NETWORK_PASSPHRASE", Networks.TESTNET);
const SCORE_API = env("SCORE_API", "https://credit-score-api-d4jskyskga-uc.a.run.app");
const USDC_ONE = 10_000_000n; // 7 decimals
const AUTO_MAX_LIMIT = BigInt(Math.round(Number(env("AUTO_MAX_LIMIT_USDC", "1")) * 1e7)); // base units
const ORIGINS = env("ALLOWED_ORIGINS", "https://lucredtech.github.io").split(",").map((s) => s.trim());
const DATA_DIR = env("DATA_DIR", "./data");
const MESSAGE_MAX_AGE_MS = 10 * 60 * 1000;

if (!POOL || !/^C[A-Z2-7]{55}$/.test(POOL)) throw new Error("POOL is not set to a C… contract id");
// The underwriter seed comes from UNDERWRITER_SECRET, or a file named by UNDERWRITER_SECRET_FILE (so a
// deployment can generate the key on the host and mount it, with the secret never passing through env/args).
function loadUnderwriterSecret() {
  const direct = env("UNDERWRITER_SECRET");
  if (direct) return direct.trim();
  const file = env("UNDERWRITER_SECRET_FILE");
  if (file) return fs.readFileSync(file, "utf8").trim();
  throw new Error("Set UNDERWRITER_SECRET or UNDERWRITER_SECRET_FILE");
}
const underwriter = Keypair.fromSecret(loadUnderwriterSecret());
const server = new rpc.Server(SOROBAN_RPC, { allowHttp: SOROBAN_RPC.startsWith("http://") });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(path.join(DATA_DIR, "reports"), { recursive: true });

// ---- ScVal builders (match the contract signatures; 7-decimal USDC) ----
const sAddr = (a) => new Address(a).toScVal();
const sU32 = (n) => nativeToScVal(n, { type: "u32" });
const sI128 = (n) => nativeToScVal(BigInt(n), { type: "i128" });
const sBytes32 = (hex) => {
  const clean = hex.replace(/^0x/, "");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return nativeToScVal(out, { type: "bytes" });
};

/** Read-only contract call via simulation (no signature, no fee). */
async function readCall(method, args) {
  const src = await server.getAccount(underwriter.publicKey());
  const tx = new TransactionBuilder(src, { fee: BASE_FEE, networkPassphrase: NET })
    .addOperation(new Contract(POOL).call(method, ...args))
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  return scValToNative(sim.result.retval);
}

/** Underwriter-signed contract invocation; resolves to the tx hash. */
async function invokeSigned(method, args) {
  const src = await server.getAccount(underwriter.publicKey());
  const tx = new TransactionBuilder(src, { fee: "1000000", networkPassphrase: NET })
    .addOperation(new Contract(POOL).call(method, ...args))
    .setTimeout(120)
    .build();
  const prepared = await server.prepareTransaction(tx);
  prepared.sign(underwriter);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") throw new Error("submit failed: " + JSON.stringify(sent.errorResult));
  let got = await server.getTransaction(sent.hash);
  const started = Date.now();
  while (got.status === rpc.Api.GetTransactionStatus.NOT_FOUND && Date.now() - started < 40_000) {
    await sleep(1500);
    got = await server.getTransaction(sent.hash);
  }
  if (got.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error("transaction " + got.status);
  return sent.hash;
}

// ---- Stellar signed-message verification (SEP-53, with wallet variants) ----
/**
 * Verifies a Stellar wallet's signature over `message`. Current wallets follow SEP-53 (ed25519 over
 * sha256("Stellar Signed Message:\n" + message)); some versions sign sha256(message) or the raw
 * message. Each variant still needs this key's signature over this exact message, so accepting all
 * three does not weaken the check.
 */
export function verifyStellarMessage(g, message, signature) {
  if (!/^G[A-Z2-7]{55}$/.test(g)) throw new Error("Stellar wallet must be a G… account address.");
  const kp = Keypair.fromPublicKey(g);
  const isHex = /^[0-9a-f]+$/i.test(signature) && signature.length === 128;
  const sig = Buffer.from(signature, isHex ? "hex" : "base64");
  if (sig.length !== 64) return false;
  const msg = Buffer.from(message, "utf8");
  const candidates = [
    crypto.createHash("sha256").update(Buffer.concat([Buffer.from("Stellar Signed Message:\n"), msg])).digest(),
    crypto.createHash("sha256").update(Buffer.concat([Buffer.from("Stellar Signed Message\n"), msg])).digest(),
    crypto.createHash("sha256").update(msg).digest(),
    msg,
  ];
  return candidates.some((data) => {
    try { return kp.verify(data, sig); } catch { return false; }
  });
}

export function parseMessage(message) {
  const m = /^LCRD credit on Stellar\nStellar wallet: (G[A-Z2-7]{55})\nIssued: (\S+)$/.exec(message ?? "");
  if (!m) throw new Error("Unrecognised message format.");
  const issued = Date.parse(m[2]);
  if (!Number.isFinite(issued) || Math.abs(Date.now() - issued) > MESSAGE_MAX_AGE_MS) {
    throw new Error("This request has expired. Please sign again.");
  }
  return { stellar: m[1] };
}

const TIER_NAME = ["", "A", "B", "C"];

let queue = Promise.resolve(); // one on-chain write at a time (nonce order)

async function requestLine(body) {
  const { message, signature } = body;
  const { stellar } = parseMessage(message);
  if (!verifyStellarMessage(stellar, message, signature ?? "")) throw new Error("The Stellar wallet signature does not match.");

  const res = await fetch(`${SCORE_API}/score?wallet=${stellar}`, { signal: AbortSignal.timeout(90_000) });
  const scored = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(scored.error ?? `Scoring failed (HTTP ${res.status}).`);
  const score = Math.max(0, Math.min(100, Math.round(Number(scored.score))));
  if (!Number.isFinite(score)) throw new Error("LCRD has no score for this wallet yet.");

  const history = await readCall("get_history", [sAddr(stellar)]);
  const cycles = Number(history.cycles_completed ?? 0);
  const [tier, aprBps, maxLimit] = await readCall("quote", [sU32(score), sU32(cycles)]);
  const result = { stellar, score, tier: TIER_NAME[Number(tier)], path: scored.path, aprBps: Number(aprBps) };

  if (BigInt(maxLimit) === 0n) {
    const reason = scored.path === "no-history"
      ? "LCRD found no DeFi history for this Stellar wallet, so there is nothing to score yet. You can still qualify through the pool: deposit USDC and borrow against it (a secured line), which builds your on-chain record."
      : `Score ${score} (tier ${result.tier}). Unsecured credit needs tier A or a score of 55 or more in tier B. You can still qualify through the pool: deposit USDC and borrow against it (a secured line), which builds your on-chain record.`;
    return { ...result, eligible: false, reason };
  }

  const limit = BigInt(maxLimit) < AUTO_MAX_LIMIT ? BigInt(maxLimit) : AUTO_MAX_LIMIT;
  const report = {
    schema: "lcrd-score-report/1",
    subject: { stellar },
    linkProof: { message, signature },
    computedAt: new Date().toISOString(),
    source: `${SCORE_API}/score`,
    model: "LCRD Stellar score",
    path: scored.path,
    score,
    tier: result.tier,
    components: scored.components ?? [],
    reasons: scored.reasons ?? [],
    policy: { version: "lcrd-unsecured-2026-10", autoMaxLimitUsdc: Number(AUTO_MAX_LIMIT) / 1e7 },
  };
  const reportJson = JSON.stringify(report, null, 2) + "\n";
  const scoreRef = crypto.createHash("sha256").update(reportJson).digest("hex");

  const write = () => invokeSigned("set_line", [sAddr(stellar), sU32(score), sI128(limit), sBytes32(scoreRef)]);
  const pending = queue.catch(() => {}).then(write);
  queue = pending;
  const txHash = await pending;

  fs.writeFileSync(path.join(DATA_DIR, "reports", `${scoreRef}.json`), reportJson);
  return { ...result, eligible: true, limit: Number(limit) / 1e7, scoreRef, txHash, report: reportJson };
}

// ---- http ----

const recent = new Map(); // ip -> [timestamps]
function rateLimited(ip) {
  const now = Date.now();
  const hits = (recent.get(ip) ?? []).filter((t) => now - t < 60 * 60 * 1000);
  hits.push(now);
  recent.set(ip, hits);
  return hits.length > 6;
}

function send(res, status, body, origin) {
  const headers = { "content-type": "application/json", "cache-control": "no-store" };
  if (origin && ORIGINS.includes(origin)) {
    Object.assign(headers, {
      "access-control-allow-origin": origin,
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      vary: "origin",
    });
  }
  res.writeHead(status, headers);
  res.end(body === null ? "" : JSON.stringify(body));
}

const httpServer = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const ip = (req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "").split(",")[0].trim();
  try {
    if (req.method === "OPTIONS") return send(res, 204, null, origin);
    if (req.method === "GET" && req.url === "/health") {
      const uw = await readCall("underwriter_of", []);
      return send(res, 200, {
        ok: true, pool: POOL, underwriter: underwriter.publicKey(),
        active: uw === underwriter.publicKey(), autoMaxLimitUsdc: Number(AUTO_MAX_LIMIT) / 1e7,
      }, origin);
    }
    if (req.method === "POST" && req.url === "/request-line") {
      if (rateLimited(ip)) return send(res, 429, { error: "Too many requests. Try again later." }, origin);
      let raw = "";
      for await (const chunk of req) { raw += chunk; if (raw.length > 8_000) return send(res, 413, { error: "Request too large." }, origin); }
      const out = await requestLine(JSON.parse(raw || "{}"));
      console.log(new Date().toISOString(), "request-line", out.stellar, "score", out.score, out.eligible ? `line ${out.limit} tx ${out.txHash}` : "not eligible");
      return send(res, 200, out, origin);
    }
    send(res, 404, { error: "Not found" }, origin);
  } catch (err) {
    console.error(new Date().toISOString(), err.message);
    send(res, 400, { error: err.message }, origin);
  }
});

if (env("PORT") !== "0") {
  httpServer.listen(Number(env("PORT", 8080)), () =>
    console.log(`credit-line underwriter ${underwriter.publicKey()} for pool ${POOL} on :${env("PORT", 8080)}`));
}
