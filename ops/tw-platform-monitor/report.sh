#!/usr/bin/env bash
# Scheduled unregistered-platform report. Finds Trustless Work platforms (roles.platform) transacting on
# Stellar mainnet that are NOT in the LCRD registry (TRUSTLESS_WORK_PLATFORMS in
# backend/indexer/src/escrowBounty.ts), so new income/trade platforms get surfaced for a human to
# classify (include/exclude + incomeType) instead of being silently skipped by the extractor.
#
# Durable complement to the in-stream indexer logging: writes findings to credit_bureau.oss_unknown_platforms.
# Scans the public crypto-stellar dataset (tw_init over the window) — ~$1.8 per run at 35 days, so run it
# MONTHLY, not daily. Usage:  DAYS=35 ./report.sh     (needs bq + python3; run on the VM or anywhere with gcloud auth)
set -euo pipefail
DAYS="${DAYS:-35}"
PROJECT="${PROJECT:-lucred-715bc}"
MAX_BYTES="${MAX_BYTES:-900000000000}"

echo "$(date -u +%FT%TZ) tw-platform-report: scanning tw_init over ${DAYS}d (project ${PROJECT})"
read -r -d '' Q <<SQL || true
SELECT contract_id, TO_JSON_STRING(data_decoded) AS d, UNIX_SECONDS(closed_at) AS ts
FROM \`crypto-stellar.crypto_stellar.history_contract_events\`
WHERE closed_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${DAYS} DAY)
  AND TO_JSON_STRING(topics_decoded) LIKE '%"tw_init"%'
SQL
bq query --project_id="$PROJECT" --use_legacy_sql=false --max_rows=200000 --maximum_bytes_billed="$MAX_BYTES" --format=csv "$Q" > /tmp/tw_init_report.csv 2>/dev/null

PROJECT="$PROJECT" python3 - <<'PY'
import csv, json, os, subprocess
from collections import defaultdict
csv.field_size_limit(10**7)
PROJECT=os.environ["PROJECT"]
# Known platform accounts — KEEP IN SYNC with TRUSTLESS_WORK_PLATFORMS (escrowBounty.ts).
KNOWN={
  "GC6T6GEPPAWOZXIOK6EMXLZ3DJDU4JBY4BV3ZWAWVSO57Q2Z2KN34RCZ":"GrantFox (oss_bounty, include)",
  "GCRYH6M5YLTGZTCAALJPIJGQZY4Z6XFFUVTINCELQG4OGLADUBTAE3OU":"Payroll op (payroll, include)",
  "GDH3NLTXHTMAPZUX7MME2SESHRRASWHQWK7BS2MTXQ3PSAXLTXUYJFSH":"KutanaPay (trade, exclude)",
  "GCHHIS6YEEGLRBEN3JTRJLLON2BQWFZWFZC5PZYCCEGDSZ5XU4VFQRNX":"Business-sale (sale, exclude)",
}
def toNative(n):
    if n is None or not isinstance(n,dict): return n
    if 'vec' in n: return [toNative(x) for x in n['vec']]
    if 'map' in n:
        o={}
        for kv in n['map']: o[kv['key'].get('symbol') or kv['key'].get('string')]=toNative(kv['val'])
        return o
    for t in ('string','symbol','address','bool'):
        if t in n: return n[t]
    for t in ('i128','i64','u64'):
        if t in n: return str(n[t])
    for t in ('u32','i32'):
        if t in n: return int(n[t])
    return n
rows=list(csv.DictReader(open('/tmp/tw_init_report.csv')))
plats=defaultdict(lambda:{'n':0,'eng':set(),'titles':set(),'first':10**12,'last':0})
for r in rows:
    try: esc=toNative(json.loads(r['d'])); esc=esc[0] if isinstance(esc,list) else esc
    except: continue
    if not isinstance(esc,dict): continue
    p=(esc.get('roles') or {}).get('platform')
    if not p: continue
    rec=plats[p]; rec['n']+=1
    if esc.get('engagement_id'): rec['eng'].add(str(esc['engagement_id'])[:40])
    if esc.get('title'): rec['titles'].add(str(esc['title'])[:40])
    ts=int(r['ts']); rec['first']=min(rec['first'],ts); rec['last']=max(rec['last'],ts)
unknown={p:v for p,v in plats.items() if p not in KNOWN}
print(f"=== {len(plats)} TW platforms active, {len(unknown)} UNREGISTERED ===")
for p,v in sorted(unknown.items(), key=lambda kv:-kv[1]['n']):
    print(f"  NEW {p}  escrows={v['n']}  engagements={list(v['eng'])[:3]}  titles={list(v['titles'])[:3]}")
if not unknown:
    print("  (none — all active platforms are in the registry)"); raise SystemExit
# Durability: MERGE unknowns into credit_bureau.oss_unknown_platforms for review.
subprocess.run(["bq","query","--project_id",PROJECT,"--use_legacy_sql=false",
  "CREATE TABLE IF NOT EXISTS `credit_bureau.oss_unknown_platforms` (platform STRING NOT NULL, escrows INT64, "
  "sampleEngagements STRING, sampleTitles STRING, firstSeen TIMESTAMP, lastSeen TIMESTAMP, reportedAt TIMESTAMP)"],
  check=False, capture_output=True)
def esc(s): return s.replace("'", "")[:200]
rows_sql=[]
for p,v in unknown.items():
    rows_sql.append("STRUCT('%s' AS platform, %d AS escrows, '%s' AS sampleEngagements, '%s' AS sampleTitles, "
        "TIMESTAMP_SECONDS(%d) AS firstSeen, TIMESTAMP_SECONDS(%d) AS lastSeen)" % (
        p, v['n'], esc(" | ".join(list(v['eng'])[:3])), esc(" | ".join(list(v['titles'])[:3])), v['first'], v['last']))
merge=("MERGE `credit_bureau.oss_unknown_platforms` T USING (SELECT * FROM UNNEST([%s])) S "
    "ON T.platform=S.platform WHEN MATCHED THEN UPDATE SET escrows=S.escrows, sampleEngagements=S.sampleEngagements, "
    "sampleTitles=S.sampleTitles, lastSeen=S.lastSeen, reportedAt=CURRENT_TIMESTAMP() "
    "WHEN NOT MATCHED THEN INSERT (platform,escrows,sampleEngagements,sampleTitles,firstSeen,lastSeen,reportedAt) "
    "VALUES (S.platform,S.escrows,S.sampleEngagements,S.sampleTitles,S.firstSeen,S.lastSeen,CURRENT_TIMESTAMP())") % ", ".join(rows_sql)
r=subprocess.run(["bq","query","--project_id",PROJECT,"--use_legacy_sql=false",merge], capture_output=True, text=True)
print("  -> recorded to credit_bureau.oss_unknown_platforms" if r.returncode==0 else "  -> MERGE failed: "+r.stderr[:200])
PY
