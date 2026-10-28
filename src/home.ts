// LCRD home — landing + live market stats (read from the pool before any wallet connect).
import "./ui.css";
import "./creditWaitlist"; // shared footer + waitlist on every /credit page
import { connect, restoreSession, readCall } from "./soroban";

const POOL = "CDW4G2YMN5RIXFTS6CW6XVNKPHJI4WZNAMUNHVKQZBD3G7QT45HELX63";
const READ_SOURCE = "GC6PEHH3UNMWN2V7LS6DRBCF7UNPX6EDZUBZ2MVFZIPHIWWWTQIJ6QBT";
const VAULT_APR = 0.10;
const ONE = 10_000_000;

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const usd = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });

async function stats() {
  // Shown when the pool is empty or a read hiccups, so the markets never sit on a dead "—".
  const target = `~${(VAULT_APR * 100).toFixed(0)}% target`;
  try {
    const [assets, cash, vaultVal, idle] = await Promise.all([
      readCall<bigint>(POOL, "total_assets", [], READ_SOURCE),
      readCall<bigint>(POOL, "cash", [], READ_SOURCE),
      readCall<bigint>(POOL, "vault_value", [], READ_SOURCE),
      readCall<bigint>(POOL, "idle_cash", [], READ_SOURCE),
    ]);
    const total = Number(assets);
    const inVault = Number(vaultVal);
    // Vault-yield component: vault rate × share of NAV parked in the vault (of total_assets, never >1).
    const est = total > 0 ? VAULT_APR * (inVault / total) : 0;
    const apy = total > 0 ? `~${(est * 100).toFixed(1)}%` : target;
    $("home-apy").textContent = apy;
    $("m-earn").innerHTML = `${apy} <span class="tiny faint">(interest + vault)</span>`;
    $("m-liq").textContent = "$" + usd(Number(cash) / ONE);
    $("m-vault").textContent = "$" + usd(inVault / ONE) + " / $" + usd(Number(idle) / ONE) + " idle";
  } catch {
    $("home-apy").textContent = target;
    $("m-earn").innerHTML = `${target} <span class="tiny faint">(interest + vault)</span>`;
    $("m-liq").textContent = "$0";
    $("m-vault").textContent = "$0 / $0 idle";
  }
}

$("walletBtn").addEventListener("click", async () => {
  try {
    const address = await connect();
    $("walletLbl").textContent = short(address);
  } catch { /* cancelled */ }
});
restoreSession().then((a) => { if (a) $("walletLbl").textContent = short(a); });

stats();
