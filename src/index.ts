import { loadCollections } from "./config/collections.js";
import { loadEnv } from "./config/env.js";
import { AlertBotDb } from "./db.js";
import { runMigrations } from "./db/migrate.js";
import { renderSaleAlert } from "./format/alert.js";
import { OpenSeaEventsProvider } from "./providers/opensea.js";
import type { CanonicalSaleEvent, TrackedCollection } from "./types.js";
import { XClient } from "./x/client.js";

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

async function main(): Promise<void> {
  const env = loadEnv();

  if (env.runMigrations) {
    await runMigrations(env.databaseUrl);
  }

  const collections: TrackedCollection[] = loadCollections({
    path: env.collectionsPath,
    json: env.collectionsJson,
  });
  console.log(
    `[boot] tracking ${collections.length} collection(s): ${collections.map((c) => c.slug).join(", ")}`,
  );

  const db = new AlertBotDb(env.databaseUrl);
  await db.ping();
  console.log("[boot] database OK");

  const opensea = new OpenSeaEventsProvider({
    baseUrl: env.openSeaBaseUrl,
    apiKey: env.openSeaApiKey,
    lookbackSeconds: env.openSeaPollLookbackSec,
  });

  const x = new XClient(env.xCredentials);
  console.log("[boot] X client ready (OAuth 1.0a)");

  let lastFloorPruneAt = 0;
  const FLOOR_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

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

      // 2. Pull new sales.
      const fetched = await withRetry("opensea.fetchLatestSales", () =>
        opensea.fetchLatestSales(collections),
      );
      const ordered = sortChronological(fetched);

      // 3. For each event: dedupe via the DB unique constraint, then post.
      for (const event of ordered) {
        const collection = collections.find((c) => c.slug === event.collectionSlug);
        if (!collection) continue;

        // Min-price gate (per collection).
        if (
          collection.minPriceEth !== null &&
          (event.priceEth === null || event.priceEth < collection.minPriceEth)
        ) {
          continue;
        }

        const inserted = await db.upsertSaleEvent(event);
        if (!inserted) continue;

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
          console.log(
            `[post] ok slug=${event.collectionSlug} token=${event.tokenId} priceEth=${event.priceEth ?? "?"}`,
          );
        } catch (error) {
          console.warn(
            `[post] FAILED slug=${event.collectionSlug} token=${event.tokenId} — ${(error as Error).message}`,
          );
        }
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
