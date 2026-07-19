import { normalizeOpenSeaSale } from "../normalize.js";
import type { CanonicalSaleEvent, TrackedCollection } from "../types.js";

type OpenSeaCollectionEventsResponse = {
  asset_events?: unknown[];
  events?: unknown[];
  next?: string;
};

type OpenSeaCollectionStatsResponse = {
  total?: { floor_price?: number | string | null };
};

// Defensive cap so a runaway cursor (or a quiet collection waking up after a
// long pause) cannot fetch unbounded pages in one cycle. 10 pages × 200 = 2000.
const MAX_PAGES_PER_COLLECTION = 10;
const FETCH_TIMEOUT_MS = 15_000;

function getUnixSeconds(input: Date): number {
  return Math.floor(input.getTime() / 1000);
}

/**
 * OpenSea v2 returns event_timestamp as ISO string OR unix seconds (number /
 * numeric string). Date.parse("1784433551") is NaN — without this helper the
 * poll cursor never advances past lookback start + 1s/cycle and sales get
 * stuck in a re-fetch/dedupe loop.
 */
function parseUnixSecondsFromEvent(event: Record<string, unknown>): number | null {
  const raw =
    event.event_timestamp ??
    (event.transaction as { timestamp?: string | number } | undefined)?.timestamp ??
    undefined;
  if (raw === undefined || raw === null) return null;

  if (typeof raw === "number" && Number.isFinite(raw)) {
    // Heuristic: >= 1e12 is already ms.
    return raw >= 1e12 ? Math.floor(raw / 1000) : Math.floor(raw);
  }

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const n = Number(trimmed);
      if (!Number.isFinite(n)) return null;
      return n >= 1e12 ? Math.floor(n / 1000) : Math.floor(n);
    }
    const tsMs = Date.parse(trimmed);
    if (Number.isNaN(tsMs)) return null;
    return Math.floor(tsMs / 1000);
  }

  return null;
}

async function fetchWithTimeout(url: string | URL, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export class OpenSeaEventsProvider {
  private readonly afterByCollection = new Map<string, number>();

  public constructor(
    private readonly config: {
      baseUrl: string;
      apiKey: string;
      lookbackSeconds: number;
    },
  ) {}

  /**
   * Pull every sale newer than the cursor we last advanced to, paginating up to
   * MAX_PAGES_PER_COLLECTION. Returns the canonical-shape events ordered as
   * OpenSea returned them (newest-first); the caller is responsible for
   * sorting if it wants chronological output.
   */
  public async fetchLatestSales(collections: TrackedCollection[], limitPerCollection = 50): Promise<CanonicalSaleEvent[]> {
    const events: CanonicalSaleEvent[] = [];
    const baseAfter = getUnixSeconds(new Date()) - this.config.lookbackSeconds;

    for (const collection of collections) {
      // Robinhood StonkBrokers OpenSea fills are detected via Blockscout Seaport
      // (seaport-rh). The OpenSea events API is unreliable for this collection
      // and racing it just adds noise / rate-limit pressure.
      if (collection.chainId === 4663 || collection.slug === "stonkbroker") {
        console.log(`[opensea] ${collection.slug}: skipped (handled by seaport-rh)`);
        continue;
      }

      try {
        const after = this.afterByCollection.get(collection.slug) ?? baseAfter;
        const slug = collection.openseaSlug;
        const limit = Math.min(Math.max(limitPerCollection, 1), 200);

        let nextCursor: string | undefined;
        let pageCount = 0;
        let maxEventTs = after;
        let totalForCollection = 0;
        let skippedNormalize = 0;

        do {
          const url = new URL(`/api/v2/events/collection/${slug}`, this.config.baseUrl);
          url.searchParams.set("after", String(after));
          url.searchParams.set("limit", String(limit));
          url.searchParams.append("event_type", "sale");
          if (nextCursor) url.searchParams.set("next", nextCursor);

          const response = await fetchWithTimeout(url, {
            headers: { "x-api-key": this.config.apiKey, accept: "application/json" },
          });
          if (!response.ok) {
            throw new Error(`OpenSea events failed (${response.status}) for ${slug}: ${await response.text()}`);
          }

          const payload = (await response.json()) as OpenSeaCollectionEventsResponse;
          const rawEvents = (payload.asset_events ?? payload.events ?? []) as Array<Record<string, unknown>>;

          for (const rawEvent of rawEvents) {
            const eventTs = parseUnixSecondsFromEvent(rawEvent);
            if (eventTs !== null && eventTs > maxEventTs) maxEventTs = eventTs;

            const normalized = normalizeOpenSeaSale(rawEvent as never, collection);
            if (!normalized) {
              skippedNormalize += 1;
              continue;
            }
            events.push(normalized);
            totalForCollection += 1;
          }

          nextCursor = payload.next && rawEvents.length === limit ? payload.next : undefined;
          pageCount += 1;
        } while (nextCursor && pageCount < MAX_PAGES_PER_COLLECTION);

        if (pageCount >= MAX_PAGES_PER_COLLECTION && nextCursor) {
          console.warn(
            `[opensea] ${slug}: hit page cap (${MAX_PAGES_PER_COLLECTION}); ${totalForCollection} events fetched, more pending — will continue next cycle`,
          );
        }

        // Advance cursor by 1 second past the newest event we saw, so we never re-fetch
        // the same event but also never skip a same-second neighbor (DB dedupe catches dup case).
        this.afterByCollection.set(collection.slug, maxEventTs + 1);
        console.log(
          `[opensea] ${collection.slug}: after=${after}→${maxEventTs + 1} sales=${totalForCollection} skipped=${skippedNormalize}`,
        );
      } catch (error) {
        console.warn(
          `[opensea] ${collection.slug} fetch failed — ${(error as Error).message}`,
        );
      }
    }

    return events;
  }

  /**
   * Fetch the current floor price (in ETH) per collection. Returns null for any
   * collection where OpenSea responded with no floor (newly listed, etc.).
   */
  public async fetchCurrentFloors(collections: TrackedCollection[]): Promise<Record<string, number | null>> {
    const floorByCollection: Record<string, number | null> = {};
    for (const collection of collections) {
      const slug = collection.openseaSlug;
      const url = new URL(`/api/v2/collections/${slug}/stats`, this.config.baseUrl);
      try {
        const response = await fetchWithTimeout(url, {
          headers: { "x-api-key": this.config.apiKey, accept: "application/json" },
        });
        if (!response.ok) {
          floorByCollection[collection.slug] = null;
          continue;
        }
        const payload = (await response.json()) as OpenSeaCollectionStatsResponse;
        const rawFloor = payload.total?.floor_price;
        const floor = rawFloor === null || rawFloor === undefined ? null : Number(rawFloor);
        floorByCollection[collection.slug] =
          floor !== null && Number.isFinite(floor) && floor > 0 ? floor : null;
      } catch {
        floorByCollection[collection.slug] = null;
      }
    }
    return floorByCollection;
  }
}
