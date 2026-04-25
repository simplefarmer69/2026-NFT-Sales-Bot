/**
 * Configuration for a single tracked NFT collection.
 *
 * Loaded from COLLECTIONS_PATH (file) or COLLECTIONS_JSON (inline). Each
 * collection becomes its own polling stream against OpenSea and its own
 * stream of X posts.
 */
export type TrackedCollection = {
  /** Unique stable identifier you choose. Used as a primary key in the DB. Lowercase, hyphens ok. */
  slug: string;
  /** The OpenSea collection slug — the path segment in https://opensea.io/collection/{slug}. */
  openseaSlug: string;
  /** ERC-721/1155 contract address. Used for safety filtering and asset URLs. */
  contract: `0x${string}`;
  /** EVM chain id. 1 = Ethereum mainnet. */
  chainId: number;
  /** Singular display name, used in the alert text. e.g. "Pixel Pup", "BAYC". */
  displayName: string;
  /** Emoji prepended to the alert. e.g. "🐾", "🐒". */
  emoji: string;
  /** Phrase printed before the collection link. e.g. "The pack is growing". */
  communityCallToAction: string;
  /** URL printed after the call-to-action — usually the OpenSea collection page. */
  communityUrl: string;
  /** Optional floor for posting. Sales below this ETH value are silently skipped. */
  minPriceEth: number | null;
};

/**
 * The canonical, marketplace-agnostic shape of a single sale we'll alert on.
 * Producers (currently only OpenSea) normalize their raw events into this
 * shape; consumers (DB, formatter, X client) only see this.
 */
export type CanonicalSaleEvent = {
  chainId: number;
  contract: `0x${string}`;
  collectionSlug: string;
  tokenId: string;
  txHash: `0x${string}`;
  logIndex: number;
  blockNumber: bigint;
  timestamp: Date | null;
  marketplace: string;
  buyer: `0x${string}` | null;
  seller: `0x${string}` | null;
  priceEth: number | null;
  priceUsd: number | null;
  assetUrl: string | null;
  imageUrl: string | null;
  txUrl: string;
  /** Filled in by the main loop after computing 24h delta. null = no line shown. */
  floorChangePct: number | null;
  eventId: string;
  /** Original payload preserved for audit/debugging. */
  payload: unknown;
};
