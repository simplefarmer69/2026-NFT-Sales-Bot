import type { CanonicalSaleEvent, TrackedCollection } from "./types.js";

type OpenSeaSaleEvent = {
  event_type?: string;
  event_timestamp?: string | number;
  transaction?:
    | string
    | {
        hash?: string;
        timestamp?: string;
        block_number?: string | number;
      };
  nft_id?: string;
  item?: {
    nft_id?: string;
    permalink?: string;
    metadata?: {
      image_url?: string;
    };
  };
  nft?: {
    identifier?: string;
    contract?: string;
    image_url?: string;
    display_image_url?: string;
    opensea_url?: string;
  };
  asset?: {
    token_id?: string | number;
    asset_contract?: { address?: string };
    permalink?: string;
    image_url?: string;
  };
  // v2 returns these as raw address strings; legacy v1 returned objects.
  seller?: string | { address?: string };
  buyer?: string | { address?: string };
  from_account?: { address?: string };
  to_account?: { address?: string };
  winner_account?: { address?: string };
  payment?: {
    quantity?: string;
    symbol?: string;
    decimals?: number;
    usd_price?: string | number;
  };
  sale_price?: string;
};

function normalizeAddress(value: string | undefined): `0x${string}` | null {
  if (!value || !/^0x[a-fA-F0-9]{40}$/.test(value)) return null;
  return value.toLowerCase() as `0x${string}`;
}

function readAddressLike(value: string | { address?: string } | undefined): string | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return value;
  return value.address;
}

function parseIsoTime(value: string | undefined): Date | null {
  if (!value) return null;
  const ts = Date.parse(value);
  return Number.isNaN(ts) ? null : new Date(ts);
}

function parseEventTime(value: string | number | undefined): Date | null {
  if (value === undefined) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? new Date(value * 1000) : null;
  }
  return parseIsoTime(value);
}

function parseEthAmountRaw(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const asBigInt = BigInt(raw);
  const asNumber = Number(asBigInt) / 1e18;
  return Number.isFinite(asNumber) ? asNumber : null;
}

function parseNumberish(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseNftId(nftId: string | undefined): { contract: `0x${string}` | null; tokenId: string | null } {
  if (!nftId) return { contract: null, tokenId: null };
  const parts = nftId.split("/");
  if (parts.length < 3) return { contract: null, tokenId: null };
  return { contract: normalizeAddress(parts[1]), tokenId: parts[2] ?? null };
}

/** OpenSea asset path segment for a given EVM chain id. */
function openSeaChainSlug(chainId: number): string {
  if (chainId === 4663) return "robinhood";
  return "ethereum";
}

function explorerTxUrl(chainId: number, txHash: string): string {
  if (chainId === 4663) return `https://robinhoodchain.blockscout.com/tx/${txHash}`;
  return `https://etherscan.io/tx/${txHash}`;
}

/**
 * Convert a raw OpenSea v2 sale event into our canonical shape. Returns null if
 * the event is missing fields we require for safe alerting (tx hash, token id).
 *
 * `logIndex` is hardcoded to 0 because the v2 events API does not expose it
 * per event. This is fine for dedupe — a given (txHash, contract, tokenId)
 * tuple maps to exactly one sale, even in multi-sale transactions.
 */
export function normalizeOpenSeaSale(
  sale: OpenSeaSaleEvent,
  collection: TrackedCollection,
): CanonicalSaleEvent | null {
  const parsed = parseNftId(sale.nft_id ?? sale.item?.nft_id);
  const assetContract = normalizeAddress(sale.asset?.asset_contract?.address);
  const nftContract = normalizeAddress(sale.nft?.contract);
  const contract = parsed.contract ?? assetContract ?? nftContract ?? collection.contract;
  if (!contract) return null;

  const tokenId = parsed.tokenId ?? String(sale.asset?.token_id ?? sale.nft?.identifier ?? "");
  if (!tokenId) return null;

  const txHash = typeof sale.transaction === "string" ? sale.transaction : sale.transaction?.hash;
  if (!txHash || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) return null;

  const blockRaw = typeof sale.transaction === "string" ? undefined : sale.transaction?.block_number;
  const blockNumber = blockRaw === undefined ? 0n : BigInt(blockRaw);
  const txTimestamp = typeof sale.transaction === "string" ? undefined : sale.transaction?.timestamp;
  const timestamp = parseEventTime(sale.event_timestamp) ?? parseIsoTime(txTimestamp);

  const buyer = normalizeAddress(
    readAddressLike(sale.buyer) ?? sale.winner_account?.address ?? sale.to_account?.address,
  );
  const seller = normalizeAddress(readAddressLike(sale.seller) ?? sale.from_account?.address);
  const priceEth = parseEthAmountRaw(sale.payment?.quantity) ?? parseEthAmountRaw(sale.sale_price);
  const priceUsd = parseNumberish(sale.payment?.usd_price);

  const assetUrl =
    sale.nft?.opensea_url ??
    sale.item?.permalink ??
    sale.asset?.permalink ??
    `https://opensea.io/assets/${openSeaChainSlug(collection.chainId)}/${contract}/${tokenId}`;
  const imageUrl =
    sale.nft?.display_image_url ??
    sale.nft?.image_url ??
    sale.item?.metadata?.image_url ??
    sale.asset?.image_url ??
    null;

  return {
    chainId: collection.chainId,
    contract,
    collectionSlug: collection.slug,
    tokenId,
    txHash: txHash.toLowerCase() as `0x${string}`,
    logIndex: 0,
    blockNumber,
    timestamp,
    marketplace: "opensea",
    buyer,
    seller,
    priceEth,
    priceUsd,
    assetUrl,
    imageUrl,
    txUrl: explorerTxUrl(collection.chainId, txHash),
    floorChangePct: null,
    eventId: `${txHash}:${collection.slug}:${tokenId}`,
    payload: sale,
  };
}
