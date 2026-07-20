import { loadCollections } from "./config/collections.js";
import { ensureStonkBrokerTracked } from "./config/default-collections.js";
import { loadEnv } from "./config/env.js";
import { AlertBotDb } from "./db.js";
import { runMigrations } from "./db/migrate.js";
import { renderSaleAlert } from "./format/alert.js";
import { OpenSeaEventsProvider } from "./providers/opensea.js";
import { SeaportRobinhoodProvider } from "./providers/seaport-rh.js";
import type { CanonicalSaleEvent, TrackedCollection } from "./types.js";
import { XClient } from "./x/client.js";

/** Transient X failures that should be retried next cycle (release dedupe). */
function isTransientPostFailure(message: string): boolean {
  return (
    message.includes("429") ||
    message.includes("rate-limit") ||
    message.includes("503") ||
    message.includes("502") ||
    message.includes("504") ||
    message.includes("request failed") ||
    message.includes("aborted") ||
    message.includes("Timeout") ||
    message.includes("ECONNRESET") ||
    message.includes("fetch failed")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wrap any async function in a single-retry envelope. We log+swallow the
 * first failure and reraise on the second so a hiccupping OpenSea response
 * doesn't kill the process loop.
 */
async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    console.warn(`[loop] ${label} failed once, retrying — ${(error as Error).message}`);
    await sleep(1500);
    return fn();
  }
}

/**
 * For a sale burst (e.g. a 50-NFT mint sweep), we want chronological X posts
 * even though OpenSea returns events newest-first. This sorts by timestamp,
 * with newer events at the END so the queue posts oldest-first.
 */
function sortChronological(events: CanonicalSaleEvent[]): CanonicalSaleEvent[] {
  return [...events].sort((a, b) => {
    const ta = a.timestamp?.getTime() ?? 0;
    const tb = b.timestamp?.getTime() ?? 0;
    return ta - tb;
  });
}

// Railway injects RAILWAY_GIT_COMMIT_SHA automatically. Logging it at boot
// lets us confirm from the runtime logs alone which commit is actually live,
// instead of guessing from the dashboard's "last deployed" timestamp.
const BUILD_COMMIT = process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? "local";

async function main(): Promise<void> {
  console.log(`[boot] 2026-nft-sales-bot starting — commit=${BUILD_COMMIT} node=${process.version}`);

  const env = loadEnv();

  if (env.runMigrations) {
    await runMigrations(env.databaseUrl);
  }

  const collections: TrackedCollection[] = ensureStonkBrokerTracked(
    loadCollections({
      path: env.collectionsPath,
      json: env.collectionsJson,
    }),
  );
  console.log(
    `[boot] tracking ${collections.length} collection(s): ${collections.map((c) => c.slug).join(", ")}`,
  );
  const stonk = collections.find(
    (c) => c.slug === "stonkbroker" || c.openseaSlug === "stonkbrokers-434284142",
  );
  if (stonk) {
    console.log(
      `[boot] stonkbroker chainId=${stonk.chainId} opensea=${stonk.openseaSlug} contract=${stonk.contract} cta="${stonk.communityCallToAction}"`,
    );
  } else {
    console.error("[boot] FATAL: stonkbroker missing from tracking list after ensureStonkBrokerTracked");
  }

  const db = new AlertBotDb(env.databaseUrl);
  await db.ping();
  console.log("[boot] database OK");
  const unstuck = await db.unstickSeaportRhOnce();
  if (unstuck > 0) {
    console.log(`[boot] unstuck ${unstuck} Seaport-RH sale(s) for retry (mark-before-post bug)`);
  }
  const unstuckV2 = await db.unstickSeaportRhV2();
  if (unstuckV2 > 0) {
    console.log(`[boot] unstuck ${unstuckV2} Seaport-RH sale(s) for retry (403 give-up without tweet)`);
  }
  const reposted = await db.repostLatestSaleOnce();
  if (reposted > 0) {
    console.log(`[boot] released token 2439 for repost in the new tweet format`);
  }
  const reposted3183 = await db.repostSale3183Once();
  if (reposted3183 > 0) {
    console.log(`[boot] released token 3183 for repost with corrected 1.050 ETH price`);
  }

  const opensea = new OpenSeaEventsProvider({
    baseUrl: env.openSeaBaseUrl,
    apiKey: env.openSeaApiKey,
    lookbackSeconds: env.openSeaPollLookbackSec,
  });

  // Blockscout Seaport watcher — OpenSea fills on Robinhood even if the
  // OpenSea events API returns empty / rate-limits the key.
  const seaportRh = new SeaportRobinhoodProvider({
    lookbackSeconds: env.seaportRhLookbackSec,
  });

  const x = new XClient(env.xCredentials);
  console.log("[boot] X client ready (OAuth 1.0a)");
  console.log(
    `[boot] sources: OpenSea API (lookback=${env.openSeaPollLookbackSec}s) + Robinhood Seaport (lookback=${env.seaportRhLookbackSec}s); Anvil AMM off`,
  );

  let lastFloorPruneAt = 0;
  const FLOOR_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

  // Per-event post failure tracking. 403s are retried (could be transient
  // spam heuristics) with a 60s backoff, capped so a hard rejection can't
  // loop forever.
  const postFailures = new Map<string, { count: number; lastAt: number }>();
  const MAX_POST_ATTEMPTS = 5;
  const POST_RETRY_BACKOFF_MS = 60_000;

  console.log(`[loop] polling every ${env.pollMs}ms`);
  // Main loop: poll OpenSea, dedupe, post to X. If anything throws, the
  // process exits and the platform restart policy (Railway/PM2/Docker) brings
  // it back. That's intentional — we'd rather crash and restart cleanly than
  // limp along with corrupted state.
  while (true) {
    try {
      // 1. Snapshot current floors and compute (gated) 24h delta.
      const currentFloors = await withRetry("opensea.fetchCurrentFloors", () =>
        opensea.fetchCurrentFloors(collections),
      );

      const floorChangeByCollection: Record<string, number | null> = {};
      for (const collection of collections) {
        const currentFloor = currentFloors[collection.slug] ?? null;

        if (currentFloor !== null) {
          await db.recordFloorSnapshot(collection.slug, currentFloor);
        }

        const baseline = await db.getFloorBaseline(collection.slug);
        if (currentFloor === null || baseline === null) {
          floorChangeByCollection[collection.slug] = null;
          continue;
        }
        // Strict 24h gate: only show the line once we have a true 24h baseline.
        // Before then, the math would be misleading ("floor changed 4% in the last
        // 7 minutes since this bot booted" is not what readers expect).
        if (baseline.ageHours < 24) {
          floorChangeByCollection[collection.slug] = null;
          continue;
        }
        const deltaPct = ((currentFloor - baseline.floorPriceEth) / baseline.floorPriceEth) * 100;
        // We only ever surface positive deltas in the alert (config: floor goes up
        // is news; floor goes down is not the vibe). Negative + null both render
        // as "no floor line" by way of the formatter's `> 0` check.
        floorChangeByCollection[collection.slug] = deltaPct > 0 ? deltaPct : null;
      }

      if (Date.now() - lastFloorPruneAt > FLOOR_PRUNE_INTERVAL_MS) {
        await db.pruneFloorSnapshotsOlderThan(7);
        lastFloorPruneAt = Date.now();
      }

      // 2. Pull new OpenSea sales (HTTP API + Robinhood Seaport on-chain backup).
      const [openSeaSales, seaportSales] = await Promise.all([
        withRetry("opensea.fetchLatestSales", () => opensea.fetchLatestSales(collections)),
        withRetry("seaportRh.fetchLatestSales", () => seaportRh.fetchLatestSales(collections)),
      ]);
      const ordered = sortChronological([...openSeaSales, ...seaportSales]);
      console.log(
        `[loop] candidates opensea=${openSeaSales.length} seaport-rh=${seaportSales.length} total=${ordered.length}`,
      );

      // 3. Claim → post → mark posted. Never treat a failed tweet as "done".
      let posted = 0;
      let skippedDedupe = 0;
      for (const event of ordered) {
        const collection = collections.find((c) => c.slug === event.collectionSlug);
        if (!collection) continue;

        // Min-price gate (per collection). Skip only when we have a price.
        if (
          collection.minPriceEth !== null &&
          event.priceEth !== null &&
          event.priceEth < collection.minPriceEth
        ) {
          continue;
        }

        // Back off between retry attempts for previously failed posts.
        const prevFailure = postFailures.get(event.eventId);
        if (prevFailure && Date.now() - prevFailure.lastAt < POST_RETRY_BACKOFF_MS) {
          continue;
        }

        const claim = await db.claimSaleEvent(event);
        if (claim === "done") {
          skippedDedupe += 1;
          console.log(
            `[loop] dedupe_skip slug=${event.collectionSlug} token=${event.tokenId} tx=${event.txHash.slice(0, 12)}…`,
          );
          continue;
        }

        const enrichedEvent: CanonicalSaleEvent = {
          ...event,
          floorChangePct: floorChangeByCollection[event.collectionSlug] ?? null,
        };
        const text = renderSaleAlert({
          event: enrichedEvent,
          collection,
          showFloorLine: env.floorDeltaLine,
        });

        try {
          await x.sendPost(text, enrichedEvent.imageUrl);
          await db.markSalePosted(event);
          postFailures.delete(event.eventId);
          posted += 1;
          console.log(
            `[post] ok slug=${event.collectionSlug} token=${event.tokenId} priceEth=${event.priceEth ?? "?"}`,
          );
        } catch (error) {
          const message = (error as Error).message;
          const fails = (postFailures.get(event.eventId)?.count ?? 0) + 1;
          postFailures.set(event.eventId, { count: fails, lastAt: Date.now() });
          console.warn(
            `[post] FAILED (attempt ${fails}/${MAX_POST_ATTEMPTS}) slug=${event.collectionSlug} token=${event.tokenId} — ${message}`,
          );
          // Leave posted=false so the next cycle retries. Only give up after
          // repeated hard failures — a single 403 can be a transient spam
          // heuristic, and marking done on it silently eats the tweet.
          if (fails >= MAX_POST_ATTEMPTS && !isTransientPostFailure(message)) {
            await db.markSalePosted(event);
            console.warn(
              `[post] giving up after ${fails} attempts slug=${event.collectionSlug} token=${event.tokenId}`,
            );
          }
        }
      }
      if (ordered.length > 0) {
        console.log(`[loop] posted=${posted} dedupe_skip=${skippedDedupe}`);
      }
    } catch (error) {
      console.error(`[loop] cycle error — ${(error as Error).message}`);
    }

    await sleep(env.pollMs);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
