#!/usr/bin/env python3
"""Load Drips Wave grant income into credit_bureau.oss_bounty_events.

Drips Wave pays OSS contributors custodially: a classic Stellar payment of Circle USDC from a fixed
treasury account to each contributor (a $1 test, then the full grant). This is NOT a Soroban escrow, so
there are no contract events to decode — the income is just outbound USDC *payments* from one account.

The cheapest, most complete source for "every payment from one account" is Horizon (free), not a
BigQuery scan of the all-operations dataset (that costs ~$28 for this window). We page Horizon, keep the
real grants (drop the $1 tests), and append the new ones to the same oss_bounty_events table the escrow
sources use — so the existing income scorer (oss-contribution.js: sum USDC by receiver over 12mo) picks
them up with NO code change.

Idempotent: we read the Drips rows already in the table and skip payments we've already loaded, so
backfill and the daily incremental run are both safe to re-run.

  Backfill (whole history):   ./load-drips-income.py --full
  Daily incremental (cron):   ./load-drips-income.py          # pages newest-first, stops once caught up

Brand note: the treasury was identified behaviorally (666 recipients overlap our known OSS contributors;
the documented Drips $1-test->grant flow; Circle USDC; numeric grant-id memos; account created
~2026-01-30). Attribution to "Drips Wave" is inferential pending a ground-truth payout tx.
"""
import json, os, subprocess, sys, tempfile, time, urllib.request

TREASURY   = "GC2SFZ2EQ4XIPBQIXYJMQSLVG7NQSHAIGB4PVTBIVTOTJDMNS4NJD4EU"
USDC_ISSUER= "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"   # Circle USDC
USDC_SAC   = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75"   # Circle USDC SAC
HORIZON    = os.environ.get("HORIZON", "https://horizon.stellar.org")
PROJECT    = os.environ.get("PROJECT", "lucred-715bc")
TABLE      = "credit_bureau.oss_bounty_events"
PLATFORM_NAME = "Drips Wave"
MIN_AMOUNT = 1.0   # drop $1 tests / dust; real grants are > $1
FULL = "--full" in sys.argv

def key(txhash, to, amount):            # dedup key for one grant payment
    return (txhash, to, round(float(amount), 7))

def known_keys():
    """Drips payments already in the table, so we never double-count on re-run."""
    q = ("SELECT transactionHash, receiver, amount FROM `%s` "
         "WHERE platformName='%s'" % (TABLE, PLATFORM_NAME))
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
    """GET one Horizon page, retrying with backoff on 429/5xx (public Horizon rate-limits)."""
    for i in range(attempts):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "lcrd-drips-income/1.0"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code in (429, 502, 503, 504) and i < attempts - 1:
                wait = int(e.headers.get("Retry-After", 0) or 0) or (2 ** i)
                print("  Horizon %d — backing off %ds" % (e.code, wait)); time.sleep(wait); continue
            raise
        except (urllib.error.URLError, TimeoutError) as e:
            if i < attempts - 1:
                time.sleep(2 ** i); continue
            raise

def main():
    seen = known_keys()
    print("drips-income: %d Drips payments already loaded" % len(seen))
    order = "asc" if FULL else "desc"
    url = ("%s/accounts/%s/payments?order=%s&limit=200&include_failed=false"
           % (HORIZON, TREASURY, order))
    new_rows, scanned, empty_pages = [], 0, 0
    while url:
        data = page(url)
        recs = data.get("_embedded", {}).get("records", [])
        if not recs:
            break
        page_new = 0
        for r in recs:
            scanned += 1
            if (r.get("type") != "payment" or r.get("asset_code") != "USDC"
                    or r.get("asset_issuer") != USDC_ISSUER or r.get("from") != TREASURY):
                continue
            to, amt = r.get("to"), float(r.get("amount", 0))
            if not to or to == TREASURY or amt <= MIN_AMOUNT:
                continue
            k = key(r["transaction_hash"], to, amt)
            if k in seen:
                continue
            seen.add(k); page_new += 1
            new_rows.append({
                "escrowContract": TREASURY,          # source account (REQUIRED)
                "milestoneIndex": 0,                   # n/a for payments (REQUIRED)
                "receiver": to,
                "platform": TREASURY,
                "platformName": PLATFORM_NAME,
                "incomeType": "oss_bounty",
                "weight": 0.7,
                "amount": amt,
                "platformFeeBps": 0,                   # no on-chain fee on the payment
                "assetCode": "USDC",
                "assetContractId": USDC_SAC,
                "title": "Drips Wave grant",
                "transactionHash": r["transaction_hash"],
                "blockCloseTime": r.get("created_at"),
            })
        # Incremental (desc): once two straight pages add nothing new, we've caught up.
        empty_pages = empty_pages + 1 if page_new == 0 else 0
        if not FULL and empty_pages >= 2:
            break
        url = data.get("_links", {}).get("next", {}).get("href")
        time.sleep(0.6)  # be gentle to public Horizon's rate limit

    print("drips-income: scanned %d payment records, %d new grant rows" % (scanned, len(new_rows)))
    if not new_rows:
        print("drips-income: nothing new to load."); return

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
    print("drips-income: loaded %d rows into %s" % (len(new_rows), TABLE))

if __name__ == "__main__":
    main()
