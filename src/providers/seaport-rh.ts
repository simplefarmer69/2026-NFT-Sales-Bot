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

type DecodedParam = {
  name?: string;
  value?: unknown;
};

type TxLogItem = {
  address?: { hash?: string };
  decoded?: {
    method_call?: string;
    parameters?: DecodedParam[];
  };
};

type TxLogsResponse = {
  items?: TxLogItem[];
};

type TxDetailResponse = {
  value?: string;
};

/** Native ETH wei → ETH number, or null if missing/zero. */
function weiToEth(weiRaw: string | undefined | null): number | null {
  if (!weiRaw) return null;
  try {
    const wei = BigInt(weiRaw);
    if (wei <= 0n) return null;
    return Number(wei) / 1e18;
  } catch {
    return null;
  }
}

/**
 * Sum payment considerations from Seaport OrderFulfilled logs.
 *
 * itemType 0 = native ETH, 1 = ERC20 (WETH). NFT items (2/3) are ignored.
 * Prefer this over summing ERC-20 Transfer events — router hops (buyer→router
 * →Seaport) double-count the same WETH and inflate the tweeted price 2×.
 */
function priceFromOrderFulfilled(logs: TxLogItem[], tokenId: string): number | null {
  let totalWei = 0n;
  let matchedOffer = false;

  for (const item of logs) {
    if (item.address?.hash?.toLowerCase() !== SEAPORT_ADDRESS) continue;
    const method = item.decoded?.method_call ?? "";
    if (!method.startsWith("OrderFulfilled")) continue;

    const params = item.decoded?.parameters ?? [];
    const offer = params.find((p) => p.name === "offer")?.value;
    const consideration = params.find((p) => p.name === "consideration")?.value;
    if (!Array.isArray(consideration)) continue;

    // Only count fills that include this NFT in the offer (or, for some
    // match* flows, in consideration). Prevents multi-NFT txs mixing prices.
    const offersNft =
      Array.isArray(offer) &&
      offer.some(
        (row) =>
          Array.isArray(row) &&
          String(row[0]) === "2" &&
          String(row[2]) === tokenId,
      );
    const considersNft = consideration.some(
      (row) =>
        Array.isArray(row) &&
        String(row[0]) === "2" &&
        String(row[2]) === tokenId,
    );
    if (!offersNft && !considersNft) continue;
    matchedOffer = true;

    for (const row of consideration) {
      if (!Array.isArray(row) || row.length < 4) continue;
      const itemType = String(row[0]);
      // 0 = ETH, 1 = ERC20. Skip NFTs / criteria.
      if (itemType !== "0" && itemType !== "1") continue;
      try {
        const amount = BigInt(String(row[3]));
        if (amount > 0n) totalWei += amount;
      } catch {
        // ignore malformed
      }
    }
  }

  if (!matchedOffer || totalWei <= 0n) return null;
  return Number(totalWei) / 1e18;
}

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

  /** Cache key `${txHash}:${tokenId}` → ETH sale price. */
  private readonly priceEthCache = new Map<string, number | null>();

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
      if (touches) {
        console.log(`[seaport-rh] router fill detected tx=${txHash.slice(0, 12)}…`);
      }
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

  /**
   * Resolve the ETH sale price for a Seaport fill:
   *   1. Sum OrderFulfilled payment considerations (ETH/WETH) for this token
   *   2. Fallback: native tx value (simple ETH buys)
   *
   * Never sum raw WETH Transfer events — router wraps (buyer→router→Seaport)
   * emit the same amount twice and inflate the price 2×.
   */
  private async resolvePriceEth(txHash: string, tokenId: string): Promise<number | null> {
    const cacheKey = `${txHash}:${tokenId}`;
    if (this.priceEthCache.has(cacheKey)) return this.priceEthCache.get(cacheKey) ?? null;

    let price: number | null = null;
    try {
      const logs = await fetchJson<TxLogsResponse>(
        `${BLOCKSCOUT_BASE}/api/v2/transactions/${txHash}/logs`,
      );
      price = priceFromOrderFulfilled(logs.items ?? [], tokenId);

      if (price === null) {
        const tx = await fetchJson<TxDetailResponse>(
          `${BLOCKSCOUT_BASE}/api/v2/transactions/${txHash}`,
        );
        price = weiToEth(tx.value);
      }
    } catch (error) {
      console.warn(
        `[seaport-rh] price fetch failed for ${txHash.slice(0, 12)}… — ${(error as Error).message}`,
      );
      return null;
    }

    if (this.priceEthCache.size > 5_000) this.priceEthCache.clear();
    this.priceEthCache.set(cacheKey, price);
    return price;
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
            }

            const buyer = row.to?.toLowerCase();
            const seller = row.from?.toLowerCase();
            const priceEth = await this.resolvePriceEth(txHash, String(tokenId));
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
              priceEth,
              priceUsd: null,
              paymentSymbol: "ETH",
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
