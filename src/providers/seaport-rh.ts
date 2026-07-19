import type { CanonicalSaleEvent, TrackedCollection } from "../types.js";

/**
 * OpenSea Seaport fills on Robinhood Chain show up in Blockscout NFT transfers
 * with these method names. Used as a backup when the OpenSea events API is
 * slow/empty so StonkBrokers OpenSea purchases still tweet.
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

const BLOCKSCOUT_BASE = "https://robinhoodchain.blockscout.com";
const FETCH_TIMEOUT_MS = 15_000;

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

/**
 * Poll Robinhood Blockscout for Seaport (OpenSea) NFT purchase transfers of
 * StonkBrokers. Complements the OpenSea HTTP events API — same marketplace,
 * independent data path.
 */
export class SeaportRobinhoodProvider {
  private lastTsBySlug = new Map<string, number>();

  public constructor(private readonly config: { lookbackSeconds: number }) {}

  public async fetchLatestSales(collections: TrackedCollection[]): Promise<CanonicalSaleEvent[]> {
    const targets = collections.filter(
      (c) => c.slug === "stonkbroker" || (c.chainId === 4663 && c.openseaSlug.includes("stonk")),
    );
    if (targets.length === 0) return [];

    const events: CanonicalSaleEvent[] = [];
    const nowSec = Math.floor(Date.now() / 1000);

    for (const collection of targets) {
      const after =
        this.lastTsBySlug.get(collection.slug) ?? nowSec - this.config.lookbackSeconds;
      const url =
        `${BLOCKSCOUT_BASE}/api?module=account&action=tokennfttx` +
        `&contractaddress=${collection.contract}` +
        `&page=1&offset=50&sort=desc`;

      try {
        const payload = await fetchJson<{ status?: string; result?: TokenNftTx[] | string }>(url);
        const rows = Array.isArray(payload.result) ? payload.result : [];
        let maxTs = after;
        let matched = 0;

        // API returns newest-first; walk newest→oldest and stop past lookback.
        for (const row of rows) {
          const ts = Number(row.timeStamp ?? 0);
          if (!Number.isFinite(ts) || ts <= after) break;
          if (ts > maxTs) maxTs = ts;

          const fn = methodName(row.functionName);
          if (!SEAPORT_METHODS.has(fn)) continue;

          const txHash = row.hash?.toLowerCase();
          const tokenId = row.tokenID;
          if (!txHash || !/^0x[a-f0-9]{64}$/.test(txHash) || !tokenId) continue;

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

        this.lastTsBySlug.set(collection.slug, Math.max(maxTs, after));
        console.log(
          `[seaport-rh] ${collection.slug}: after=${after}→${this.lastTsBySlug.get(collection.slug)} matched=${matched}`,
        );
      } catch (error) {
        console.warn(`[seaport-rh] ${collection.slug} failed — ${(error as Error).message}`);
      }
    }

    return events;
  }
}
