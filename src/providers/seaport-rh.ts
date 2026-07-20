import type { CanonicalSaleEvent, TrackedCollection } from "../types.js";

/**
 * OpenSea Seaport fills on Robinhood Chain show up in Blockscout NFT transfers
 * with these method names. Primary detector for StonkBrokers OpenSea buys —
 * the collection's AMM sell/transfer traffic drowns a single-page scan.
 */
const SEAPORT_METHODS = new Set([
  "fulfillAvailableAdvancedOrders",
  "fulfillAdvancedOrder",
  "fulfillBasicOrder",
  "fulfillBasicOrder_efficient_6GL6yc",
  "fulfillOrder",
  "matchAdvancedOrders",
  "matchOrders",
]);

/**
 * Methods that are definitively NOT OpenSea fills (Anvil AMM + vanilla
 * transfers/mints). Anything else — e.g. RelayRouterV3 `multicall`, sweep
 * tools, aggregators — gets a receipt-log check for the Seaport contract,
 * because routers wrap Seaport fills under their own method names.
 */
const KNOWN_NON_SEAPORT_METHODS = new Set([
  "sellNFT",
  "buyNFT",
  "buyRandomNFT",
  "transfer",
  "transferFrom",
  "safeTransferFrom",
  "mint",
  "safeMint",
]);

/** Seaport 1.6 on Robinhood Chain — emits OrderFulfilled on every OpenSea fill. */
const SEAPORT_ADDRESS = "0x0000000000000068f116a894984e2db1123eb395";

const BLOCKSCOUT_BASE = "https://robinhoodchain.blockscout.com";
const FETCH_TIMEOUT_MS = 20_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 15;

type TokenNftTx = {
  hash?: string;
  tokenID?: string;
  from?: string;
  to?: string;
  timeStamp?: string;
  blockNumber?: string;
  functionName?: string;
  contractAddress?: string;
};

async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        "user-agent": "nft-sales-bot/1.0 (+https://stonkbrokers.cash)",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Blockscout ${response.status}: ${await response.text()}`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

function methodName(raw: string | undefined): string {
  if (!raw) return "";
  return raw.split("(")[0]!.trim();
}

type TxLogsResponse = {
  items?: { address?: { hash?: string } }[];
};

/**
 * Poll Robinhood Blockscout for Seaport (OpenSea) NFT purchase transfers.
 *
 * Always re-scans a full lookback window (DB dedupe prevents double posts).
 * Paginates — StonkBrokers has heavy AMM sell/transfer volume, so a single
 * page of 50 often contains zero Seaport fills even when OpenSea sales exist.
 */
export class SeaportRobinhoodProvider {
  /**
   * txHash → "did the receipt touch Seaport?". The lookback window is
   * re-scanned every poll cycle, so without this cache every router tx in the
   * window would trigger a Blockscout logs fetch every few seconds.
   */
  private readonly seaportTouchCache = new Map<string, boolean>();

  public constructor(private readonly config: { lookbackSeconds: number }) {}

  /** True when the tx receipt contains any log emitted by the Seaport contract. */
  private async txTouchesSeaport(txHash: string): Promise<boolean> {
    const cached = this.seaportTouchCache.get(txHash);
    if (cached !== undefined) return cached;

    let touches = false;
    try {
      const logs = await fetchJson<TxLogsResponse>(
        `${BLOCKSCOUT_BASE}/api/v2/transactions/${txHash}/logs`,
      );
      touches = (logs.items ?? []).some(
        (item) => item.address?.hash?.toLowerCase() === SEAPORT_ADDRESS,
      );
    } catch (error) {
      // Don't cache on fetch failure — retry next cycle.
      console.warn(`[seaport-rh] logs fetch failed for ${txHash.slice(0, 12)}… — ${(error as Error).message}`);
      return false;
    }

    // Bounded cache: entries only matter within the lookback window.
    if (this.seaportTouchCache.size > 5_000) this.seaportTouchCache.clear();
    this.seaportTouchCache.set(txHash, touches);
    return touches;
  }

  public async fetchLatestSales(collections: TrackedCollection[]): Promise<CanonicalSaleEvent[]> {
    const targets = collections.filter(
      (c) =>
        c.slug === "stonkbroker" ||
        c.openseaSlug === "stonkbrokers-434284142" ||
        (c.chainId === 4663 && c.openseaSlug.toLowerCase().includes("stonk")),
    );
    if (targets.length === 0) {
      console.warn("[seaport-rh] no Robinhood StonkBrokers collection in tracking list");
      return [];
    }

    const events: CanonicalSaleEvent[] = [];
    const nowSec = Math.floor(Date.now() / 1000);
    const after = nowSec - this.config.lookbackSeconds;

    for (const collection of targets) {
      let matched = 0;
      let scanned = 0;
      let reachedLookback = false;

      try {
        for (let page = 1; page <= MAX_PAGES; page += 1) {
          const url =
            `${BLOCKSCOUT_BASE}/api?module=account&action=tokennfttx` +
            `&contractaddress=${collection.contract}` +
            `&page=${page}&offset=${PAGE_SIZE}&sort=desc`;

          const payload = await fetchJson<{ status?: string; result?: TokenNftTx[] | string }>(url);
          const rows = Array.isArray(payload.result) ? payload.result : [];
          if (rows.length === 0) {
            reachedLookback = true;
            break;
          }

          for (const row of rows) {
            const ts = Number(row.timeStamp ?? 0);
            if (!Number.isFinite(ts)) continue;
            if (ts <= after) {
              reachedLookback = true;
              break;
            }
            scanned += 1;

            const txHash = row.hash?.toLowerCase();
            const tokenId = row.tokenID;
            if (!txHash || !/^0x[a-f0-9]{64}$/.test(txHash) || !tokenId) continue;

            // Direct Seaport call → match. Known AMM/transfer method → skip.
            // Anything else (router multicalls, aggregators) → check the
            // receipt for a Seaport-emitted log before deciding.
            const fn = methodName(row.functionName);
            if (!SEAPORT_METHODS.has(fn)) {
              if (KNOWN_NON_SEAPORT_METHODS.has(fn)) continue;
              if (!(await this.txTouchesSeaport(txHash))) continue;
              console.log(
                `[seaport-rh] router fill detected method=${fn || "?"} token=${tokenId} tx=${txHash.slice(0, 12)}…`,
              );
            }

            const buyer = row.to?.toLowerCase();
            const seller = row.from?.toLowerCase();
            matched += 1;

            events.push({
              chainId: collection.chainId,
              contract: collection.contract,
              collectionSlug: collection.slug,
              tokenId: String(tokenId),
              txHash: txHash as `0x${string}`,
              logIndex: 0,
              blockNumber: BigInt(row.blockNumber ?? 0),
              timestamp: new Date(ts * 1000),
              marketplace: "opensea",
              buyer: buyer && /^0x[a-f0-9]{40}$/.test(buyer) ? (buyer as `0x${string}`) : null,
              seller: seller && /^0x[a-f0-9]{40}$/.test(seller) ? (seller as `0x${string}`) : null,
              priceEth: null,
              priceUsd: null,
              assetUrl: `https://opensea.io/assets/robinhood/${collection.contract}/${tokenId}`,
              imageUrl: null,
              txUrl: `https://robinhoodchain.blockscout.com/tx/${txHash}`,
              floorChangePct: null,
              eventId: `${txHash}:seaport-rh:${tokenId}`,
              payload: row,
            });
          }

          if (reachedLookback) break;
          if (rows.length < PAGE_SIZE) {
            reachedLookback = true;
            break;
          }
        }

        console.log(
          `[seaport-rh] ${collection.slug}: lookback=${this.config.lookbackSeconds}s scanned=${scanned} matched=${matched} complete=${reachedLookback}`,
        );
      } catch (error) {
        console.warn(`[seaport-rh] ${collection.slug} failed — ${(error as Error).message}`);
      }
    }

    return events;
  }
}
