import type { CanonicalSaleEvent, TrackedCollection } from "../types.js";

/** Anvil NFTFi AMM vault on Robinhood mainnet (live 2026-07-17 deploy). */
export const STONKBROKER_AMM_VAULT =
  "0xe302733accf4800146e55fc45b46b4e4ffc032d2" as const;

/** NFTBought(buyer, tokenId, cost, ethFee, boosterShare, protocolShare, specific) */
const NFT_BOUGHT_TOPIC =
  "0xb5efbeab556b17cacd1e111b6dee840d9d3bfeabc055edb46ce2b991b8c58673";

const BLOCKSCOUT_BASE = "https://robinhoodchain.blockscout.com";

/** Hosted PNG — token metadata is data: SVG which X media upload rejects. */
export const STONKBROKER_POST_IMAGE =
  "https://i2c.seadn.io/collection/stonkbrokers-434284142/image_type_logo/d2dfd6700b856a0efa032fe803488f/96d2dfd6700b856a0efa032fe803488f.png";

type ExplorerLog = {
  address?: string;
  topics?: string[];
  data?: string;
  transactionHash?: string;
  blockNumber?: string;
  timeStamp?: string;
  logIndex?: string;
};

function word(hex: string, i: number): bigint {
  const slice = hex.slice(64 * i, 64 * (i + 1));
  if (!slice || slice.length < 64) return 0n;
  return BigInt(`0x${slice}`);
}

function parseHexInt(value: string | undefined): number {
  if (!value) return 0;
  if (value.startsWith("0x") || value.startsWith("0X")) return Number.parseInt(value, 16);
  return Number.parseInt(value, 10);
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "nft-sales-bot/1.0 (+https://stonkbrokers.cash)",
    },
  });
  if (!response.ok) {
    throw new Error(`Blockscout ${response.status} for ${url}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

/**
 * Poll Robinhood Blockscout for Anvil AMM NFTBought events.
 * Complements OpenSea — Anvil vault swaps/snipes never appear as OpenSea sales.
 */
export class AnvilAmmBuysProvider {
  private lastBlockBySlug = new Map<string, number>();

  public constructor(
    private readonly config: {
      lookbackSeconds: number;
      vaultAddress?: `0x${string}`;
      explorerBaseUrl?: string;
    },
  ) {}

  public async fetchLatestBuys(collections: TrackedCollection[]): Promise<CanonicalSaleEvent[]> {
    const stonk = collections.filter((c) => c.slug === "stonkbroker" || c.chainId === 4663);
    if (stonk.length === 0) return [];

    const explorer = this.config.explorerBaseUrl ?? BLOCKSCOUT_BASE;
    const vault = (this.config.vaultAddress ?? STONKBROKER_AMM_VAULT).toLowerCase();
    const stats = await fetchJson<{ total_blocks?: number | string }>(`${explorer}/api/v2/stats`);
    const latestBlock = Number(stats.total_blocks ?? 0);
    if (!Number.isFinite(latestBlock) || latestBlock <= 0) {
      throw new Error(`Blockscout stats missing total_blocks: ${JSON.stringify(stats)}`);
    }

    // RH block time ~100ms; pad lookback so we never miss a burst after restart.
    const blocksForLookback = Math.max(2_000, Math.ceil(this.config.lookbackSeconds / 0.1));
    const events: CanonicalSaleEvent[] = [];

    for (const collection of stonk) {
      const afterBlock =
        this.lastBlockBySlug.get(collection.slug) ?? Math.max(0, latestBlock - blocksForLookback);
      const fromBlock = afterBlock + 1;
      if (fromBlock > latestBlock) continue;

      const url =
        `${explorer}/api?module=logs&action=getLogs` +
        `&address=${vault}` +
        `&topic0=${NFT_BOUGHT_TOPIC}` +
        `&fromBlock=${fromBlock}` +
        `&toBlock=${latestBlock}`;

      const payload = await fetchJson<{ status?: string; message?: string; result?: ExplorerLog[] | string }>(
        url,
      );
      const rows = Array.isArray(payload.result) ? payload.result : [];
      let maxBlock = afterBlock;

      for (const row of rows) {
        const normalized = this.normalizeBought(row, collection, vault);
        if (!normalized) continue;
        events.push(normalized);
        if (normalized.blockNumber > BigInt(maxBlock)) {
          maxBlock = Number(normalized.blockNumber);
        }
      }

      // Advance even when quiet so we don't re-scan the whole lookback every cycle.
      this.lastBlockBySlug.set(collection.slug, Math.max(maxBlock, latestBlock));
      console.log(
        `[anvil] ${collection.slug}: blocks ${fromBlock}→${latestBlock} bought=${rows.length} posted_candidates=${events.filter((e) => e.collectionSlug === collection.slug).length}`,
      );
    }

    return events;
  }

  private normalizeBought(
    row: ExplorerLog,
    collection: TrackedCollection,
    vault: string,
  ): CanonicalSaleEvent | null {
    const topics = row.topics ?? [];
    if (topics.length < 3) return null;
    const txHash = row.transactionHash?.toLowerCase();
    if (!txHash || !/^0x[a-f0-9]{64}$/.test(txHash)) return null;

    const buyer = `0x${topics[1]!.slice(-40)}`.toLowerCase() as `0x${string}`;
    const tokenId = BigInt(topics[2]!).toString();
    const data = (row.data ?? "0x").replace(/^0x/i, "");
    if (data.length < 64 * 5) return null;

    const cost = word(data, 0);
    const ethFee = word(data, 1);
    const logIndex = parseHexInt(row.logIndex);
    const blockNumber = BigInt(parseHexInt(row.blockNumber));
    const tsSec = parseHexInt(row.timeStamp);
    const timestamp = tsSec > 0 ? new Date(tsSec * 1000) : null;

    // Primary price is $STONKBROKER spent (18 decimals). ethFee is the small ETH surcharge.
    const priceTokens = Number(cost) / 1e18;
    const priceEthFee = Number(ethFee) / 1e18;

    return {
      chainId: collection.chainId,
      contract: collection.contract,
      collectionSlug: collection.slug,
      tokenId,
      txHash: txHash as `0x${string}`,
      logIndex,
      blockNumber,
      timestamp,
      marketplace: "anvil",
      buyer,
      seller: vault as `0x${string}`,
      priceEth: Number.isFinite(priceTokens) ? priceTokens : null,
      priceUsd: null,
      paymentSymbol: "STONKBROKER",
      ethFee: Number.isFinite(priceEthFee) ? priceEthFee : null,
      assetUrl: `https://opensea.io/assets/robinhood/${collection.contract}/${tokenId}`,
      imageUrl: STONKBROKER_POST_IMAGE,
      txUrl: `https://robinhoodchain.blockscout.com/tx/${txHash}`,
      floorChangePct: null,
      eventId: `${txHash}:anvil:${tokenId}:${logIndex}`,
      payload: row,
    };
  }
}
