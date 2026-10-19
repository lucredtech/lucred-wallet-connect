// LCRD home — landing + live market stats (read from the pool before any wallet connect).
import "./ui.css";
import { connect, restoreSession, readCall } from "./soroban";

const POOL = "CDW4G2YMN5RIXFTS6CW6XVNKPHJI4WZNAMUNHVKQZBD3G7QT45HELX63";
const READ_SOURCE = "GC6PEHH3UNMWN2V7LS6DRBCF7UNPX6EDZUBZ2MVFZIPHIWWWTQIJ6QBT";
const VAULT_APR = 0.10;
const ONE = 10_000_000;

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const usd = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });

async function stats() {
  try {
    const [cash, vaultVal, idle] = await Promise.all([
      readCall<bigint>(POOL, "cash", [], READ_SOURCE),
      readCall<bigint>(POOL, "vault_value", [], READ_SOURCE),
      readCall<bigint>(POOL, "idle_cash", [], READ_SOURCE),
    ]);
    const liquid = Number(cash);
    const est = liquid > 0 ? VAULT_APR * (Number(vaultVal) / liquid) : 0;
    const apy = `~${(est * 100).toFixed(1)}%`;
    $("home-apy").textContent = apy;
    $("m-earn").innerHTML = `${apy} <span class="tiny faint">(interest + vault)</span>`;
    $("m-liq").textContent = "$" + usd(Number(cash) / ONE);
    $("m-vault").textContent = "$" + usd(Number(vaultVal) / ONE) + " / $" + usd(Number(idle) / ONE) + " idle";
  } catch {
    $("home-apy").textContent = "live";
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
