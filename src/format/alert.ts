import type { CanonicalSaleEvent, TrackedCollection } from "../types.js";

/** Title-case a marketplace name like "opensea" → "Opensea", "blur" → "Blur". */
function prettyMarketplace(raw: string | null | undefined): string {
  if (!raw) return "Unknown";
  if (raw.length <= 1) return raw.toUpperCase();
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/** Shorten an EVM address to leading + trailing 4 chars: 0x1234…abcd. */
function shortenAddress(address: string | null): string {
  if (!address || address.length < 10) return "?";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatEth(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "?";
  if (value >= 1) return value.toFixed(3);
  if (value >= 0.01) return value.toFixed(3);
  return value.toFixed(4);
}

/**
 * Render the X post body for a sale.
 *
 * Layout:
 *   {emoji} {displayName} #{tokenId} SOLD
 *   💰 {priceEth} ETH
 *   🐕 {Marketplace}
 *   🐕 {seller→buyer}
 *   {assetUrl}
 *   {communityCallToAction}: {communityUrl}
 *   📈 Floor +{X.X}%        (only if positive AND >=24h baseline AND enabled)
 *
 * The 280-character truncation in the X client is the final guardrail.
 */
export function renderSaleAlert(input: {
  event: CanonicalSaleEvent;
  collection: TrackedCollection;
  showFloorLine: boolean;
}): string {
  const { event, collection, showFloorLine } = input;
  const lines: string[] = [];

  lines.push(`${collection.emoji} ${collection.displayName} #${event.tokenId} SOLD`);
  lines.push(`💰 ${formatEth(event.priceEth)} ETH`);
  lines.push(`🐕 ${prettyMarketplace(event.marketplace)}`);
  lines.push(`🐕 ${shortenAddress(event.seller)} → ${shortenAddress(event.buyer)}`);
  if (event.assetUrl) lines.push(event.assetUrl);
  lines.push(`${collection.communityCallToAction}: ${collection.communityUrl}`);

  if (
    showFloorLine &&
    event.floorChangePct !== null &&
    Number.isFinite(event.floorChangePct) &&
    event.floorChangePct > 0
  ) {
    lines.push(`📈 Floor +${event.floorChangePct.toFixed(1)}%`);
  }

  return lines.join("\n");
}
