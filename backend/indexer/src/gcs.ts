import https from 'https';
import { Storage, File } from '@google-cloud/storage';
import { decompress as zstdDecompress } from 'fzstd';

// Node's default global HTTPS agent caps concurrent connections *per host*
// well below what indexer.ts's PROCESSING_CONCURRENCY asks for - every GCS
// call here goes to the same host (storage.googleapis.com), so without
// this, raising application-level concurrency alone doesn't actually
// raise real parallelism once requests start queueing behind the agent's
// own socket limit. Matches PROCESSING_CONCURRENCY with headroom for the
// listing/checkpoint calls running alongside the main download/write/
// delete traffic.
https.globalAgent.maxSockets = 200;

const storage = new Storage();

export interface Checkpoint {
  /** Names of raw-export objects already processed, most recent first. */
  processedObjects: string[];
}

const CHECKPOINT_KEEP = 500; // bound the checkpoint file's size

// Bounds each poll cycle's listing call so it stays cheap even when the raw
// prefix has a large backlog (e.g. mid-backfill) - see the comment below.
// Raised from the original 1000 once a real 6-instance parallel backfill
// showed aggregate production (~24 ledgers/sec across all of them) outrunning
// what 1000-per-cycle could keep up with alongside PROCESSING_CONCURRENCY in
// indexer.ts - a bigger per-cycle batch gives that concurrency more to chew
// through per list+sleep round trip instead of idling on an empty candidate
// set between cycles.
const LIST_BATCH_SIZE = 3000;

/**
 * Retries a GCS call a few times on TRANSIENT errors only (429 rate-limit,
 * 5xx server-side) - confirmed necessary once several Galexie instances
 * were writing to the same bucket concurrently (a 6-way parallel backfill):
 * real `503 backendError` / "We encountered an internal error. Please try
 * again." responses started showing up under that combined load. Without
 * this, a single transient failure sent that file all the way back to the
 * NEXT full poll cycle (indexer.ts's own retry-by-leaving-it-in-place),
 * costing a full ~15s+ round trip for what a few hundred milliseconds of
 * backoff would have recovered from immediately. Non-transient errors
 * (e.g. a malformed object, a real permissions problem) are rethrown
 * immediately - retrying those would just waste time before failing the
 * same way anyway.
 */
async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 4): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientGcsError(err) || attempt === maxAttempts) throw err;
      await sleep(250 * attempt); // small linear backoff
    }
  }
  throw lastErr;
}

function isTransientGcsError(err: unknown): boolean {
  if (err instanceof TimeoutError) return true;
  const code = (err as { code?: number } | undefined)?.code;
  return code === 429 || (typeof code === 'number' && code >= 500);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Found 2026-09-25: one shard (FC1, always the same one) stalled three
 * times in a row at container startup, stuck right after pool discovery
 * with essentially zero CPU used ever since - `docker top` showed only a
 * few seconds of total CPU time an hour into "running". The only GCS call
 * in this file NOT already wrapped in `withRetry` is the listing call
 * below, and `withRetry` itself only helps once a promise actually
 * *rejects* - a genuinely hung connection that never resolves or rejects
 * (no client-side timeout configured anywhere on the Storage client)
 * slips past retry logic entirely and blocks the container forever. This
 * wraps any call in an explicit timeout that turns "hung forever" into a
 * real, retryable error.
 */
class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Timed out after ${ms}ms`);
  }
}

function withTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
    fn().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export interface RawObjectPage {
  files: File[];
  /** Pass this back into the next call to continue where this one left
   * off. Undefined means the listing reached the end of the prefix. */
  nextPageToken?: string;
}

/**
 * Galexie's GCS/S3 datastore is the only export target it supports today
 * (there is no local-filesystem datastore type) — see
 * https://developers.stellar.org/docs/data/galexie/admin_guide/configuring
 * So the worker polls the raw-export bucket/prefix directly instead of
 * watching a shared local directory.
 *
 * This paginates with an explicit cursor (`pageToken`) that the caller
 * persists across poll cycles, rather than re-listing from the start of
 * the prefix every time. Two real bugs on a real backfill run motivated
 * this, in order:
 *
 * 1. An unbounded `getFiles({ prefix })` re-lists the ENTIRE prefix from
 *    scratch every single poll cycle. GCS paginates at ~1000 objects per
 *    page server-side, so once the raw prefix backs up into the tens of
 *    thousands of objects (exactly what happens during a large historical
 *    backfill, where Galexie produces files faster than a slow first pass
 *    can process them), each cycle pays for dozens of sequential list
 *    round-trips before doing any real work - the backlog grows faster
 *    than it drains, a self-reinforcing stall.
 * 2. The first fix for that - just bounding `maxResults` and always
 *    listing from the start of the prefix - traded that stall for a worse,
 *    silent one: GCS object listing without an explicit cursor always
 *    returns the same lexicographically-first N keys. Galexie's object
 *    names embed a reversed/hashed ledger id for even GCS shard
 *    distribution (`FD085A03--49784316.xdr.zst`), not a chronological one,
 *    and confirmed on real data that newly-arriving objects can keep
 *    landing on hash prefixes that sort BEFORE a much older backlog's
 *    prefixes (`FD085A` < `FD08AB`, sorting a file from seconds ago ahead
 *    of one over an hour old). With no cursor, every cycle's "first 1000"
 *    was quietly re-selecting recent arrivals over and over while a large
 *    historical backlog sat untouched indefinitely - the raw bucket kept
 *    growing even though the worker was actively processing files the
 *    whole time, just never the old ones.
 *
 * A persisted page cursor fixes both: each cycle advances through the
 * prefix's full keyspace instead of restarting from the top, so every
 * object is eventually reached regardless of its name. The cursor lives
 * only in memory (see indexer.ts) - it doesn't need to survive a restart,
 * since a fresh pass just starts back at the top of the (by then smaller,
 * or empty) prefix and finds nothing but genuinely new objects, because
 * everything already processed has already been deleted.
 */
export async function listNewRawObjects(
  rawBucketName: string,
  rawPrefix: string,
  alreadyProcessed: Set<string>,
  pageToken: string | undefined
): Promise<RawObjectPage> {
  const [files, nextQuery] = await withRetry(() =>
    withTimeout(
      () =>
        storage.bucket(rawBucketName).getFiles({
          prefix: rawPrefix,
          maxResults: LIST_BATCH_SIZE,
          autoPaginate: false,
          ...(pageToken && { pageToken })
        }),
      20_000
    )
  );
  return {
    files: files.filter((f) => f.name.endsWith('.xdr.zst') && !alreadyProcessed.has(f.name)),
    nextPageToken: nextQuery && typeof nextQuery === 'object' ? nextQuery.pageToken : undefined
  };
}

/** Downloads straight into a Buffer — no temp file, nothing hits local disk. */
export async function downloadObjectToMemory(file: File): Promise<Buffer> {
  const [contents] = await withRetry(() => withTimeout(() => file.download(), 20_000));
  return contents;
}

/** Objects are zstd-compressed per SEP-54; decompress fully in memory. */
export function decompressZstd(compressed: Buffer): Buffer {
  return Buffer.from(zstdDecompress(new Uint8Array(compressed)));
}

export async function writeJsonlToGCS(
  outputBucketName: string,
  outputPrefix: string,
  objectBaseName: string,
  jsonlPayload: string
): Promise<void> {
  const bucket = storage.bucket(outputBucketName);
  const blob = bucket.file(`${outputPrefix}${objectBaseName}.jsonl`);
  await withRetry(() => withTimeout(() => blob.save(jsonlPayload, { contentType: 'application/json', resumable: false }), 20_000));
}

/** Deletes the raw zstd object once it has been fully processed, mirroring
 * the "auto-purge" step from the local-disk design — here the purge target
 * is the raw GCS object instead of a tmpfs file. */
export async function deleteRawObject(file: File): Promise<void> {
  await withRetry(() => withTimeout(() => file.delete({ ignoreNotFound: true }), 20_000));
}

/**
 * Finds the raw/ folder currently receiving live-tip exports, instead of a
 * human picking a static RAW_PREFIX that goes stale the moment the tip
 * drifts past it. Added 2026-10-01 after confirming, across the whole
 * fleet, that 14 of 16 statically-assigned shard containers were polling
 * permanently-exhausted ranges (pure wasted ListObjects cost, ~$189/month
 * fleet-wide) while the one assignment that still mattered (FC6) was about
 * to run out of range too, with nothing positioned to take over - a
 * correctness gap, not just a cost one. See project_live_tip_dynamic_prefix
 * memory for the full writeup.
 *
 * Galexie's top-level raw/ folder names embed their own ledger range
 * directly (`FC24B1FF--64704000-64767999` = hash prefix, then
 * startLedger-endLedger) - confirmed on real data this range always grows
 * monotonically as new folders are created (each covers ~64,000 ledgers,
 * batched by Galexie's own config). A GCS listing with `delimiter: '/'` and
 * no deeper prefix returns just these top-level folder names (as
 * `.prefixes`, not real objects) WITHOUT enumerating any file inside them -
 * cheap regardless of how many millions of files exist under the bucket,
 * since it never descends past the first path segment.
 */
export async function findLatestRawFolder(bucketName: string, topLevelPrefix: string): Promise<string | null> {
  const [, , apiResponse] = await withRetry(() =>
    withTimeout(
      () =>
        storage.bucket(bucketName).getFiles({
          prefix: topLevelPrefix,
          delimiter: '/',
          autoPaginate: false,
          maxResults: 1000
        }),
      20_000
    )
  );
  const prefixes: string[] = (apiResponse as { prefixes?: string[] })?.prefixes ?? [];

  let best: { folder: string; endLedger: number } | null = null;
  for (const p of prefixes) {
    // p looks like "raw/FC24B1FF--64704000-64767999/" - pull the folder's
    // own name (the path segment right after topLevelPrefix) and its
    // trailing "-<endLedger>" number.
    const folder = p.slice(topLevelPrefix.length).replace(/\/$/, '');
    const match = folder.match(/-(\d+)$/);
    if (!match) continue;
    const endLedger = Number(match[1]);
    if (!best || endLedger > best.endLedger) {
      best = { folder, endLedger };
    }
  }
  return best ? best.folder : null;
}

export async function readCheckpoint(bucketName: string, checkpointPath: string): Promise<Checkpoint> {
  try {
    // Runs right at startup, immediately after pool discovery - the exact
    // point a real FC1 stall was traced to (see withTimeout's comment). No
    // withRetry here on purpose: a missing/corrupt checkpoint is expected
    // and already handled by falling back to an empty one below, so only
    // a hang (not a normal 404) needs guarding against.
    const [contents] = await withTimeout(() => storage.bucket(bucketName).file(checkpointPath).download(), 20_000);
    return JSON.parse(contents.toString('utf-8'));
  } catch {
    return { processedObjects: [] };
  }
}

export async function writeCheckpoint(
  bucketName: string,
  checkpointPath: string,
  checkpoint: Checkpoint
): Promise<void> {
  const trimmed: Checkpoint = {
    // keep the most-recently-processed tail, not the oldest entries
    processedObjects: checkpoint.processedObjects.slice(-CHECKPOINT_KEEP)
  };
  await withRetry(() =>
    withTimeout(
      () =>
        storage
          .bucket(bucketName)
          .file(checkpointPath)
          .save(JSON.stringify(trimmed), { contentType: 'application/json', resumable: false }),
      20_000
    )
  );
}
