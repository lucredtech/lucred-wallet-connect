// Minimal Soroban (testnet) helpers for the Stage B test page: connect a wallet, read contract state,
// and sign+submit a contract invocation. Separate from src/wallet.ts (which is mainnet, read-only).
import {
  Address, BASE_FEE, Contract, Networks, TransactionBuilder, nativeToScVal, scValToNative, rpc, xdr,
} from "@stellar/stellar-sdk";
import { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import { FreighterModule } from "@creit.tech/stellar-wallets-kit/modules/freighter";
import { xBullModule } from "@creit.tech/stellar-wallets-kit/modules/xbull";
import { AlbedoModule } from "@creit.tech/stellar-wallets-kit/modules/albedo";
import { HanaModule } from "@creit.tech/stellar-wallets-kit/modules/hana";
import { RabetModule } from "@creit.tech/stellar-wallets-kit/modules/rabet";
import { LobstrModule } from "@creit.tech/stellar-wallets-kit/modules/lobstr";
import { WalletConnectModule, WalletConnectTargetChain } from "@creit.tech/stellar-wallets-kit/modules/wallet-connect";

export const TESTNET_RPC = "https://soroban-testnet.stellar.org";
const server = new rpc.Server(TESTNET_RPC);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const modules = [
  new FreighterModule(),
  new xBullModule(),
  new AlbedoModule(),
  new LobstrModule(),
  new RabetModule(),
  new HanaModule(),
];

// Scan-to-connect via WalletConnect (mobile wallets show a QR). Enabled only when a project id is
// configured (get one free at reown.com), so the app still works without it. Set the env var
// VITE_WALLETCONNECT_PROJECT_ID to turn it on.
const wcProjectId = (import.meta.env as Record<string, string | undefined>).VITE_WALLETCONNECT_PROJECT_ID;
if (wcProjectId) {
  modules.push(
    new WalletConnectModule({
      projectId: wcProjectId,
      metadata: {
        name: "LCRD",
        description: "On-chain credit on Stellar",
        url: typeof window !== "undefined" ? window.location.origin : "https://stellar.lcrd.fi",
        icons: [],
      },
      allowedChains: [WalletConnectTargetChain.TESTNET],
    }) as unknown as (typeof modules)[number],
  );
}

StellarWalletsKit.init({ network: Networks.TESTNET, modules });

export async function connect(): Promise<string> {
  const { address } = await StellarWalletsKit.authModal();
  return address;
}

// ---- ScVal builders matching the contract signatures ----
export const sAddr = (a: string) => new Address(a).toScVal();
export const sI128 = (n: bigint | number | string) => nativeToScVal(typeof n === "bigint" ? n : BigInt(n), { type: "i128" });
export const sU32 = (n: number) => nativeToScVal(n, { type: "u32" });
export const sU64 = (n: bigint | number) => nativeToScVal(typeof n === "bigint" ? n : BigInt(n), { type: "u64" });
export const sBytes32 = (hex: string) => {
  const clean = hex.replace(/^0x/, "");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return nativeToScVal(out, { type: "bytes" });
};
// A unit-variant contracttype enum is an ScVal vec of one symbol, e.g. Structure::OpenEnded.
export const sEnum = (variant: string) => xdr.ScVal.scvVec([nativeToScVal(variant, { type: "symbol" })]);

/** Read-only contract call via simulation (no signature, no fee). */
export async function readCall<T = unknown>(contractId: string, method: string, args: xdr.ScVal[], source: string): Promise<T> {
  const account = await server.getAccount(source);
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  if (!sim.result) throw new Error("no result");
  return scValToNative(sim.result.retval) as T;
}

/** Sign (via the connected wallet) + submit a contract invocation; resolves to the tx hash. */
export async function invoke(contractId: string, method: string, args: xdr.ScVal[], source: string): Promise<string> {
  const account = await server.getAccount(source);
  const tx = new TransactionBuilder(account, { fee: "1000000", networkPassphrase: Networks.TESTNET })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(120)
    .build();
  const prepared = await server.prepareTransaction(tx);
  const { signedTxXdr } = await StellarWalletsKit.signTransaction(prepared.toXDR(), {
    networkPassphrase: Networks.TESTNET,
    address: source,
  });
  const sent = await server.sendTransaction(TransactionBuilder.fromXDR(signedTxXdr, Networks.TESTNET));
  if (sent.status === "ERROR") throw new Error("submit failed: " + JSON.stringify(sent.errorResult));
  let got = await server.getTransaction(sent.hash);
  const started = Date.now();
  while (got.status === rpc.Api.GetTransactionStatus.NOT_FOUND && Date.now() - started < 40000) {
    await sleep(1500);
    got = await server.getTransaction(sent.hash);
  }
  if (got.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error("transaction " + got.status);
  return sent.hash;
}

export const explorerTx = (hash: string) => `https://stellar.expert/explorer/testnet/tx/${hash}`;

/** A parsed on-chain contract event (topics + value decoded to native). */
export type ActivityEvent = { ledger: number; txHash: string; topics: unknown[]; value: unknown };

/** Recent events emitted by a contract, newest first (up to `limit`). Reads from Soroban RPC's event
 * retention window (~24h on testnet); backs off the start ledger if it's beyond retention. */
export async function getContractEvents(contractId: string, limit = 20): Promise<ActivityEvent[]> {
  const latest = await server.getLatestLedger();
  const toNative = (v: unknown) => {
    try {
      const sv = typeof v === "string" ? xdr.ScVal.fromXDR(v, "base64") : (v as xdr.ScVal);
      return scValToNative(sv);
    } catch {
      return null;
    }
  };
  for (const back of [17000, 9000, 4000, 1000]) {
    try {
      const resp = await server.getEvents({
        startLedger: Math.max(latest.sequence - back, 1),
        filters: [{ type: "contract", contractIds: [contractId] }],
      });
      const evs = resp.events.map((e: { ledger: number; txHash: string; topic: unknown[]; value: unknown }) => ({
        ledger: e.ledger,
        txHash: e.txHash,
        topics: (e.topic ?? []).map(toNative),
        value: toNative(e.value),
      }));
      return evs.slice(-limit).reverse();
    } catch (err) {
      if (back === 1000) throw err;
    }
  }
  return [];
}
