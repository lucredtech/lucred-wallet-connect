#!/usr/bin/env python3
"""Load payment-based contributor income into credit_bureau.oss_bounty_events.

Some income on Stellar is NOT a Soroban escrow (no contract events to decode) — it is just outbound
classic USDC *payments* from a fixed account to contributors. This loader indexes those, from a small
registry of known payer accounts (PAYERS below), into the same oss_bounty_events table the escrow
sources use — so the existing income scorer (oss-contribution.js: sum USDC by receiver over 12mo) picks
them up with NO code change. (Filename kept as load-drips-income.* so the cron/wrapper are unaffected.)

Sources in the registry:
  • Drips Wave (GC2SFZ2E…) — custodial OSS grant withdrawals, Circle USDC. Drips often sends a $1 test
    then the grant, but many contributors withdraw their whole balance as repeated $1 payments, so we
    count every payment > $0. incomeType=oss_bounty, counts at full weight in the scorer.
  • HackMeridian (GC4MRJZW…) — Meridian hackathon / travel grants (memo "…Meridian…/grant"). This is a
    MIXED-USE account (it pays non-grant things too), so we memo-scope to the grant payments only, and
    tag them incomeType=event_grant, which the scorer counts at a reduced 0.35 (one-off event/travel
    grants are a weaker creditworthiness signal than sustained bounty/payroll income).

The cheapest, most complete source for "every payment from one account" is Horizon (free), not a
BigQuery scan of the all-operations dataset (~$28 for this window). We page Horizon and append new
payments. Idempotent: we read the rows already in the table per platform and skip loaded payments, so
backfill and the daily incremental run are both safe to re-run.

  Backfill (whole history):   ./load-drips-income.py --full
  Daily incremental (cron):   ./load-drips-income.py          # pages newest-first, stops once caught up
  One source only:            ./load-drips-income.py --only "HackMeridian"

Drips brand CONFIRMED (2026-10-21): a grantee confirmed the treasury's payments to
GAE6BEVEA6IH4HLTGU3AEGZZWSLNCCWLKD4GLN2XHLXFFNFB24COWUJY (tx 8e46c623…, verified on-chain as sent by
GC2SFZ2E) are genuine Drips Wave withdrawals; corroborated by drips-network/app's open-source code.
HackMeridian identified from the on-chain payment memo "HackMeridian travel grant" (2026-11-14).
"""
import json, os, subprocess, sys, tempfile, time, urllib.request

USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"   # Circle USDC
USDC_SAC    = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75"   # Circle USDC SAC
HORIZON     = os.environ.get("HORIZON", "https://horizon.stellar.org")
PROJECT     = os.environ.get("PROJECT", "lucred-715bc")
TABLE       = "credit_bureau.oss_bounty_events"

# Registry of payer accounts whose outbound Circle-USDC payments are contributor income.
#   account      : the paying Stellar account
#   platformName : label stored on each row (also the per-platform dedup scope)
#   incomeType   : 'oss_bounty' (full weight) | 'event_grant' (scorer counts at 0.35)
#   weight       : informational row weight (the scorer discounts by incomeType, not this column)
#   title        : human label on the row
#   minAmount    : skip payments <= this (dust floor); $1s are REAL income for Drips, so 0.0
#   memoFilter   : None = count all payments; else a list of lowercase substrings — keep a payment only
#                  if its transaction memo contains one (for mixed-use accounts like HackMeridian)
PAYERS = [
    {
        "account": "GC2SFZ2EQ4XIPBQIXYJMQSLVG7NQSHAIGB4PVTBIVTOTJDMNS4NJD4EU",
        "platformName": "Drips Wave", "incomeType": "oss_bounty", "weight": 0.7,
        "title": "Drips Wave grant", "minAmount": 0.0, "memoFilter": None,
    },
    {
        "account": "GC4MRJZW2HLQY44DUTUWPRIGSP74CEMFSRJDE4WDV5EFD5C2LYZE4PVE",
        "platformName": "HackMeridian", "incomeType": "event_grant", "weight": 0.35,
        "title": "Meridian grant", "minAmount": 0.0, "memoFilter": ["meridian", "grant"],
    },
]

FULL = "--full" in sys.argv
ONLY = None
if "--only" in sys.argv:
    i = sys.argv.index("--only")
    ONLY = sys.argv[i + 1] if i + 1 < len(sys.argv) else None


def key(txhash, to, amount):            # dedup key for one payment
    return (txhash, to, round(float(amount), 7))


def known_keys(platform_name):
    """Payments already in the table for this platform, so we never double-count on re-run."""
    q = ("SELECT transactionHash, receiver, amount FROM `%s` "
         "WHERE platformName='%s'" % (TABLE, platform_name))
    out = subprocess.run(["bq", "query", "--project_id", PROJECT, "--use_legacy_sql=false",
                          "--format=csv", "--max_rows=1000000", q],
                         capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit("known_keys query failed: " + out.stderr[:300])
    keys = set()
    for line in out.stdout.splitlines()[1:]:  # skip header
        parts = line.split(",")
        if len(parts) == 3:
            keys.add(key(parts[0], parts[1], parts[2]))
    return keys


def page(url, attempts=6):
    """GET one Horizon page/resource, retrying with backoff on 429/5xx (public Horizon rate-limits)."""
    for i in range(attempts):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "lcrd-payment-income/1.0"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code in (429, 502, 503, 504) and i < attempts - 1:
                wait = int(e.headers.get("Retry-After", 0) or 0) or (2 ** i)
                print("  Horizon %d — backing off %ds" % (e.code, wait)); time.sleep(wait); continue
            raise
        except (urllib.error.URLError, TimeoutError):
            if i < attempts - 1:
                time.sleep(2 ** i); continue
            raise


_memo_cache = {}
def tx_memo(record):
    """Fetch the transaction memo for a payment record (cached by tx hash). Returns lowercase text."""
    h = record.get("transaction_hash")
    if h in _memo_cache:
        return _memo_cache[h]
    memo = ""
    try:
        tx = page(record["_links"]["transaction"]["href"])
        if tx.get("memo_type") not in (None, "none"):
            memo = str(tx.get("memo") or "")
        time.sleep(0.15)  # memo fetches add load; stay gentle on Horizon
    except Exception:
        memo = ""
    memo = memo.lower()
    _memo_cache[h] = memo
    return memo


def load_payer(p):
    """Index one payer's outbound USDC income payments; returns the new rows."""
    seen = known_keys(p["platformName"])
    print("payment-income[%s]: %d payments already loaded" % (p["platformName"], len(seen)))
    order = "asc" if FULL else "desc"
    url = ("%s/accounts/%s/payments?order=%s&limit=200&include_failed=false"
           % (HORIZON, p["account"], order))
    new_rows, scanned, empty_pages, kept = [], 0, 0, 0
    while url:
        data = page(url)
        recs = data.get("_embedded", {}).get("records", [])
        if not recs:
            break
        page_new = 0
        for r in recs:
            scanned += 1
            if (r.get("type") != "payment" or r.get("asset_code") != "USDC"
                    or r.get("asset_issuer") != USDC_ISSUER or r.get("from") != p["account"]):
                continue
            to, amt = r.get("to"), float(r.get("amount", 0))
            if not to or to == p["account"] or amt <= p["minAmount"]:
                continue
            if p["memoFilter"] is not None:
                memo = tx_memo(r)
                if not any(term in memo for term in p["memoFilter"]):
                    continue
            k = key(r["transaction_hash"], to, amt)
            if k in seen:
                continue
            seen.add(k); page_new += 1; kept += 1
            new_rows.append({
                "escrowContract": p["account"],      # source account (REQUIRED)
                "milestoneIndex": 0,                   # n/a for payments (REQUIRED)
                "receiver": to,
                "platform": p["account"],
                "platformName": p["platformName"],
                "incomeType": p["incomeType"],
                "weight": p["weight"],
                "amount": amt,
                "platformFeeBps": 0,                   # no on-chain fee on the payment
                "assetCode": "USDC",
                "assetContractId": USDC_SAC,
                "title": p["title"],
                "transactionHash": r["transaction_hash"],
                "blockCloseTime": r.get("created_at"),
            })
        # Incremental (desc): once two straight pages add nothing new, we've caught up.
        empty_pages = empty_pages + 1 if page_new == 0 else 0
        if not FULL and empty_pages >= 2:
            break
        url = data.get("_links", {}).get("next", {}).get("href")
        time.sleep(0.6)  # be gentle to public Horizon's rate limit
    print("payment-income[%s]: scanned %d records, %d new income rows" % (p["platformName"], scanned, len(new_rows)))
    return new_rows


def main():
    payers = [p for p in PAYERS if (ONLY is None or p["platformName"] == ONLY)]
    if ONLY and not payers:
        sys.exit("--only %r matched no payer in the registry" % ONLY)
    new_rows = []
    for p in payers:
        new_rows.extend(load_payer(p))

    if not new_rows:
        print("payment-income: nothing new to load."); return

    with tempfile.NamedTemporaryFile("w", suffix=".ndjson", delete=False) as f:
        for row in new_rows:
            f.write(json.dumps(row) + "\n")
        path = f.name
    load = subprocess.run(["bq", "load", "--project_id", PROJECT,
                           "--source_format=NEWLINE_DELIMITED_JSON", TABLE, path],
                          capture_output=True, text=True)
    os.unlink(path)
    if load.returncode != 0:
        sys.exit("bq load failed: " + load.stderr[:500])
    print("payment-income: loaded %d rows into %s" % (len(new_rows), TABLE))


if __name__ == "__main__":
    main()
