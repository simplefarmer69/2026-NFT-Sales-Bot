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
 * Stonk Interns — the 8,888-piece companion collection on Robinhood Chain
 * (two interns per StonkBroker, token N / N+4444). Same Seaport-on-Robinhood
 * sale detection and the same no-emoji ticker tweet layout as the brokers.
 *
 * Contract deployed 2026-09-19 (StonkInterns, ERC-721C). Dormant sweeps into
 * broker wallets and paid mints out of them are plain Transfers with no
 * Seaport OrderFulfilled in the tx, so only real OpenSea sales post.
 */
export const STONK_INTERNS_COLLECTION: TrackedCollection = {
  slug: "stonk-interns",
  openseaSlug: "interns",
  contract: "0xfc4b0c4f464dc3037cf013934648a8a726d565a5",
  chainId: 4663,
  displayName: "Stonk Intern",
  emoji: "",
  communityCallToAction: "CLOCK IN",
  communityUrl: "https://www.stonkbrokers.cash/marketplace?tab=interns",
  minPriceEth: null,
};

/** Robinhood Chain collections that are always tracked regardless of env. */
export const ROBINHOOD_COLLECTIONS: readonly TrackedCollection[] = [
  STONKBROKER_COLLECTION,
  STONK_INTERNS_COLLECTION,
];

/**
 * Collections this bot no longer posts. Pixel Pups was replaced by the Stonk
 * Interns on 2026-09-19; the filter here means a stale COLLECTIONS_JSON on
 * Railway cannot bring it back.
 */
export const RETIRED_SLUGS: ReadonlySet<string> = new Set(["pixel-pups"]);

function matchesRobinhoodCollection(candidate: TrackedCollection, canonical: TrackedCollection): boolean {
  return (
    candidate.slug === canonical.slug ||
    candidate.openseaSlug === canonical.openseaSlug ||
    (candidate.chainId === canonical.chainId &&
      candidate.contract.toLowerCase() === canonical.contract.toLowerCase())
  );
}

/**
 * Ensure the Robinhood Chain collections (StonkBrokers + Stonk Interns) are
 * always tracked with the canonical config + CLOCK IN CTA — even when
 * Railway's COLLECTIONS_JSON predates them — and drop retired collections.
 */
export function ensureRobinhoodCollectionsTracked(collections: TrackedCollection[]): TrackedCollection[] {
  const next = collections.filter((c) => !RETIRED_SLUGS.has(c.slug));

  for (const canonical of ROBINHOOD_COLLECTIONS) {
    const idx = next.findIndex((c) => matchesRobinhoodCollection(c, canonical));
    if (idx === -1) {
      next.push(canonical);
      continue;
    }
    next[idx] = {
      ...canonical,
      // Keep an operator-tuned minPriceEth if they set one explicitly.
      minPriceEth: next[idx]!.minPriceEth,
    };
  }
  return next;
}

/** @deprecated kept for callers that predate the interns; use ensureRobinhoodCollectionsTracked. */
export const ensureStonkBrokerTracked = ensureRobinhoodCollectionsTracked;
