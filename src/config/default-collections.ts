import type { TrackedCollection } from "../types.js";

/**
 * Canonical StonkBrokers entry — Robinhood Chain (4663).
 * OpenSea marketplace sales on Robinhood; Anvil AMM buys are not posted
 * (provider kept in repo but not wired into the main loop for now).
 */
export const STONKBROKER_COLLECTION: TrackedCollection = {
  slug: "stonkbroker",
  openseaSlug: "stonkbrokers-434284142",
  contract: "0x539cdd042c2f3d93ebc5be7dfff0c79f3b4fabf0",
  chainId: 4663,
  displayName: "StonkBroker",
  emoji: "",
  communityCallToAction: "CLOCK IN",
  communityUrl: "https://www.stonkbrokers.cash/marketplace",
  minPriceEth: null,
  // No hashtags — ticker line ($Stonkbroker $AAPL …) is rendered by the formatter.
};

/**
 * Ensure StonkBrokers is always tracked with the correct Robinhood Chain
 * config + CLOCK IN CTA — even when Railway's COLLECTIONS_JSON still only
 * lists Pixel Pups / Pup Cup from an older deploy.
 */
export function ensureStonkBrokerTracked(collections: TrackedCollection[]): TrackedCollection[] {
  const idx = collections.findIndex(
    (c) => c.slug === "stonkbroker" || c.openseaSlug === "stonkbrokers-434284142",
  );

  if (idx === -1) {
    return [...collections, STONKBROKER_COLLECTION];
  }

  const next = [...collections];
  next[idx] = {
    ...STONKBROKER_COLLECTION,
    // Keep an operator-tuned minPriceEth if they set one explicitly.
    minPriceEth: collections[idx]!.minPriceEth,
  };
  return next;
}
