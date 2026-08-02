import type { CanonicalSaleEvent, TrackedCollection } from "../types.js";

/**
 * OpenSea (Seaport) fill watcher for StonkBrokers on Robinhood Chain.
 *
 * Reads the chain directly over JSON-RPC. Two `eth_getLogs` calls per cycle —
 * the collection's ERC-721 Transfers and Seaport's OrderFulfilled events over
 * the same block range — are correlated by transaction hash. A collection
 * transfer whose tx also emitted OrderFulfilled is an OpenSea sale; everything
 * else (Anvil AMM trades, plain transfers, mints) is ignored.
 *
 * This replaced a Blockscout REST scan that re-paged up to 1,500 NFT-transfer
 * rows every 4s poll and then fetched per-tx logs for pricing. That volume
 * rate-limited us into a permanent HTTP 429, and because the scan fails closed,
 * StonkBroker sales stopped posting entirely while the OpenSea-API collections
 * (Pixel Pups, Pup Cup) kept working — nine real sales were dropped on
 * 2026-08-01 alone. See also the project rule: never trust Blockscout's logs
 * API for cursor-advancing scans.
 */

const RPC_URL = process.env.ROBINHOOD_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";

/** Seaport 1.6 on Robinhood Chain — emits OrderFulfilled on every OpenSea fill. */
const SEAPORT_ADDRESS = "0x0000000000000068f116a894984e2db1123eb395";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/**
 * OrderFulfilled(bytes32,address,address,address,(uint8,address,uint256,uint256)[],
 * (uint8,address,uint256,uint256,address)[])
 */
const ORDER_FULFILLED_TOPIC = "0x9d9af8e38d66c62e2c12f0225249fd9d721c54b83f48d9352c97c6cacdcb6f31";

const FETCH_TIMEOUT_MS = 20_000;
/** Robinhood Chain runs ~10 blocks/sec (≈0.1s block time), measured 2026-08-01. */
const BLOCKS_PER_SECOND = 10;
/**
 * `eth_getLogs` span per request. The public node happily serves 900k-block
 * ranges, so the default 4h lookback is one or two calls; what it does rate
 * limit is a burst of parallel requests. Keep the chunk large and the calls
 * few rather than fanning out.
 */
const LOG_CHUNK_BLOCKS = 100_000;
const RPC_MAX_ATTEMPTS = 4;
/**
 * Ceiling on a single cycle's scan. A cold start covers the full lookback
 * (4h ≈ 144k blocks) in one pass; after a longer outage the cursor catches up
 * over successive cycles instead of issuing one enormous range query.
 */
const MAX_BLOCKS_PER_CYCLE = 200_000;
/** Re-scan a little history each cycle so a reorg can't drop a sale. */
const CURSOR_OVERLAP_BLOCKS = 50;

type RpcLog = {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rpcOnce<T>(method: string, params: unknown[]): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`rpc ${method} http ${response.status}`);
    const payload = (await response.json()) as { result?: T; error?: { message?: string } };
    if (payload.error) throw new Error(`rpc ${method}: ${payload.error.message ?? "error"}`);
    if (payload.result === undefined) throw new Error(`rpc ${method}: empty result`);
    return payload.result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Retry with exponential backoff. The public node returns 429 under bursts, and
 * a transient blip must never look like "no sales" — every caller here treats a
 * final throw as "leave the cursor alone and try again next cycle".
 */
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= RPC_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await rpcOnce<T>(method, params);
    } catch (error) {
      lastError = error;
      if (attempt < RPC_MAX_ATTEMPTS) await sleep(500 * 2 ** (attempt - 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Sequential on purpose — parallel chunks are what trips the node's rate limit. */
async function getLogsChunked(
  address: string,
  topics: (string | null)[],
  fromBlock: number,
  toBlock: number,
): Promise<RpcLog[]> {
  const logs: RpcLog[] = [];
  for (let start = fromBlock; start <= toBlock; start += LOG_CHUNK_BLOCKS) {
    const end = Math.min(start + LOG_CHUNK_BLOCKS - 1, toBlock);
    const page = await rpc<RpcLog[]>("eth_getLogs", [
      { address, topics, fromBlock: `0x${start.toString(16)}`, toBlock: `0x${end.toString(16)}` },
    ]);
    logs.push(...page);
  }
  return logs;
}

function topicToAddress(topic: string | undefined): `0x${string}` | null {
  if (!topic || topic.length !== 66) return null;
  const address = `0x${topic.slice(26)}`.toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(address) ? (address as `0x${string}`) : null;
}

type SeaportItem = {
  itemType: number;
  token: string;
  identifier: bigint;
  amount: bigint;
};

/**
 * Decode the non-indexed body of an OrderFulfilled log.
 *
 * Layout: [orderHash, recipient, offsetof(offer), offsetof(consideration)],
 * then each array as [length, ...elements]. SpentItem is 4 static words;
 * ReceivedItem is 5 (it carries a trailing recipient). Both element types are
 * static, so the arrays are flat and need no per-element offset chasing.
 */
function decodeOrderFulfilled(data: string): { offer: SeaportItem[]; consideration: SeaportItem[] } | null {
  const body = data.startsWith("0x") ? data.slice(2) : data;
  if (body.length % 64 !== 0) return null;
  const words: string[] = [];
  for (let i = 0; i < body.length; i += 64) words.push(body.slice(i, i + 64));
  if (words.length < 4) return null;

  const readItems = (headerWord: number, wordsPerItem: number): SeaportItem[] | null => {
    const offset = Number(BigInt(`0x${words[headerWord]!}`)) / 32;
    if (!Number.isInteger(offset) || offset < 0 || offset >= words.length) return null;
    const length = Number(BigInt(`0x${words[offset]!}`));
    if (!Number.isFinite(length) || length < 0) return null;
    const base = offset + 1;
    if (base + length * wordsPerItem > words.length) return null;

    const items: SeaportItem[] = [];
    for (let i = 0; i < length; i += 1) {
      const at = base + i * wordsPerItem;
      items.push({
        itemType: Number(BigInt(`0x${words[at]!}`)),
        token: `0x${words[at + 1]!.slice(24)}`.toLowerCase(),
        identifier: BigInt(`0x${words[at + 2]!}`),
        amount: BigInt(`0x${words[at + 3]!}`),
      });
    }
    return items;
  };

  const offer = readItems(2, 4);
  const consideration = readItems(3, 5);
  if (!offer || !consideration) return null;
  return { offer, consideration };
}

/**
 * Total ETH paid for `tokenId`, derived from the OrderFulfilled logs in the
 * transaction that reference it.
 *
 * itemType 0 = native ETH, 1 = ERC-20 (WETH); 2/3 are the NFT legs. Three
 * fill shapes exist on OpenSea's Seaport 1.6, and in every one of them the
 * FULL price appears in at least one matched log — as either that log's
 * payment-item offer sum or its payment-item consideration sum:
 *
 *   1. Direct listing (one log): NFT in offer, consideration = seller
 *      proceeds + fees → consideration sum is the price.
 *   2. Accepted WETH bid, current single-log shape (seen 2026-08-02): the
 *      bidder's order only — offer = full WETH price, consideration = NFT +
 *      marketplace/royalty fees. The seller's proceeds never appear in any
 *      consideration, so the OFFER sum is the price. (Summing considerations
 *      here yields just the ~3.8% fee slice — the "0.35 ETH sale" bug.)
 *   3. Accepted WETH bid, legacy two-log matchOrders shape: bidder's log as
 *      in (2) plus a seller log whose consideration is the post-fee
 *      remainder. The bidder log's offer sum is the price.
 *
 * So: per matched log take max(offer payments, consideration payments), then
 * take the max across logs — summing across logs would double-count shape (3)
 * (full price in one log + remainder in the other). A token sells at most
 * once per tx, so max never mixes two sales. Never sum raw WETH Transfer
 * events either — router hops (buyer→router→Seaport) emit the same amount
 * twice and double the price.
 */
function priceEthFromOrderFulfilled(logs: RpcLog[], tokenId: bigint): number | null {
  let bestWei = 0n;
  let matched = false;

  for (const log of logs) {
    const decoded = decodeOrderFulfilled(log.data);
    if (!decoded) continue;

    const referencesToken = (items: SeaportItem[]): boolean =>
      items.some((item) => (item.itemType === 2 || item.itemType === 3) && item.identifier === tokenId);
    if (!referencesToken(decoded.offer) && !referencesToken(decoded.consideration)) continue;
    matched = true;

    const paymentSum = (items: SeaportItem[]): bigint =>
      items.reduce(
        (sum, item) => (item.itemType === 0 || item.itemType === 1 ? sum + item.amount : sum),
        0n,
      );
    const logWei = (() => {
      const offerWei = paymentSum(decoded.offer);
      const considerationWei = paymentSum(decoded.consideration);
      return offerWei > considerationWei ? offerWei : considerationWei;
    })();
    if (logWei > bestWei) bestWei = logWei;
  }

  if (!matched || bestWei <= 0n) return null;
  return Number(bestWei) / 1e18;
}

export class SeaportRobinhoodProvider {
  /** Highest block already scanned. null until the first successful cycle. */
  private cursorBlock: number | null = null;

  /** blockNumber → unix seconds. Only sale blocks are ever looked up. */
  private readonly blockTimeCache = new Map<number, number>();

  public constructor(private readonly config: { lookbackSeconds: number }) {}

  private async blockTimestamp(blockNumber: number): Promise<Date | null> {
    const cached = this.blockTimeCache.get(blockNumber);
    if (cached !== undefined) return new Date(cached * 1000);
    try {
      const block = await rpc<{ timestamp?: string }>("eth_getBlockByNumber", [
        `0x${blockNumber.toString(16)}`,
        false,
      ]);
      if (!block?.timestamp) return null;
      const seconds = Number(BigInt(block.timestamp));
      if (this.blockTimeCache.size > 5_000) this.blockTimeCache.clear();
      this.blockTimeCache.set(blockNumber, seconds);
      return new Date(seconds * 1000);
    } catch {
      return null;
    }
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

    const lookbackBlocks = Math.ceil(this.config.lookbackSeconds * BLOCKS_PER_SECOND);
    const events: CanonicalSaleEvent[] = [];

    // A throw anywhere below leaves cursorBlock untouched, so the next cycle
    // re-scans the same range rather than skipping over unscanned history.
    const head = Number(BigInt(await rpc<string>("eth_blockNumber", [])));
    const oldestAllowed = Math.max(0, head - lookbackBlocks);
    const fromBlock =
      this.cursorBlock === null
        ? oldestAllowed
        : Math.max(oldestAllowed, this.cursorBlock + 1 - CURSOR_OVERLAP_BLOCKS);
    const toBlock = Math.min(head, fromBlock + MAX_BLOCKS_PER_CYCLE - 1);
    if (toBlock < fromBlock) return [];

    for (const collection of targets) {
      const transferLogs = await getLogsChunked(
        collection.contract,
        [TRANSFER_TOPIC],
        fromBlock,
        toBlock,
      );
      // Nothing moved, so there is nothing to price — skip the Seaport query.
      if (transferLogs.length === 0) {
        console.log(`[seaport-rh] ${collection.slug}: blocks=${fromBlock}..${toBlock} transfers=0 matched=0`);
        continue;
      }
      const seaportLogs = await getLogsChunked(
        SEAPORT_ADDRESS,
        [ORDER_FULFILLED_TOPIC],
        fromBlock,
        toBlock,
      );

      const seaportByTx = new Map<string, RpcLog[]>();
      for (const log of seaportLogs) {
        const tx = log.transactionHash.toLowerCase();
        const bucket = seaportByTx.get(tx);
        if (bucket) bucket.push(log);
        else seaportByTx.set(tx, [log]);
      }

      // Collapse a token's transfers within one tx. Conduit/router hops relay
      // the NFT seller→conduit→buyer, so the true counterparties are the first
      // sender and the final recipient.
      type Leg = { tokenId: bigint; seller: `0x${string}` | null; buyer: `0x${string}` | null; block: number };
      const legsByTx = new Map<string, Map<string, Leg>>();

      for (const log of transferLogs) {
        // ERC-721 Transfer carries an indexed tokenId; ERC-20 Transfer has 3 topics.
        if (log.topics.length !== 4) continue;
        const tx = log.transactionHash.toLowerCase();
        if (!seaportByTx.has(tx)) continue;

        const tokenId = BigInt(log.topics[3]!);
        const key = tokenId.toString();
        const byToken = legsByTx.get(tx) ?? new Map<string, Leg>();
        const existing = byToken.get(key);
        if (existing) {
          existing.buyer = topicToAddress(log.topics[2]);
        } else {
          byToken.set(key, {
            tokenId,
            seller: topicToAddress(log.topics[1]),
            buyer: topicToAddress(log.topics[2]),
            block: Number(BigInt(log.blockNumber)),
          });
        }
        legsByTx.set(tx, byToken);
      }

      let matched = 0;
      for (const [tx, byToken] of legsByTx) {
        const orderLogs = seaportByTx.get(tx) ?? [];
        for (const leg of byToken.values()) {
          const priceEth = priceEthFromOrderFulfilled(orderLogs, leg.tokenId);
          const timestamp = await this.blockTimestamp(leg.block);
          matched += 1;

          events.push({
            chainId: collection.chainId,
            contract: collection.contract,
            collectionSlug: collection.slug,
            tokenId: leg.tokenId.toString(),
            txHash: tx as `0x${string}`,
            logIndex: 0,
            blockNumber: BigInt(leg.block),
            timestamp,
            marketplace: "opensea",
            buyer: leg.buyer,
            seller: leg.seller,
            priceEth,
            priceUsd: null,
            paymentSymbol: "ETH",
            assetUrl: `https://opensea.io/assets/robinhood/${collection.contract}/${leg.tokenId}`,
            imageUrl: null,
            txUrl: `https://robinhoodchain.blockscout.com/tx/${tx}`,
            floorChangePct: null,
            // Unchanged from the Blockscout implementation so previously
            // posted sales stay deduped across this migration.
            eventId: `${tx}:seaport-rh:${leg.tokenId}`,
            payload: { tx, tokenId: leg.tokenId.toString(), block: leg.block },
          });
        }
      }

      console.log(
        `[seaport-rh] ${collection.slug}: blocks=${fromBlock}..${toBlock} transfers=${transferLogs.length} seaportTx=${seaportByTx.size} matched=${matched}`,
      );
    }

    this.cursorBlock = toBlock;
    return events;
  }
}
