import type { CanonicalSaleEvent, TrackedCollection } from "../types.js";

/**
 * Footer tickers: the Stonkbroker token, the three live mainnet stock tokens,
 * and Robinhood's own ticker. X allows only ONE cashtag per post, so each
 * tweet cashtags exactly one of these (rotating by token id) and renders the
 * rest as plain text.
 */
export const STONKBROKER_FOOTER_TICKERS = [
  "Stonkbroker",
  "AAPL",
  "AMZN",
  "NVDA",
  "HOOD",
] as const;

/** Brand-correct marketplace name: "opensea" → "OpenSea", "blur" → "Blur". */
function prettyMarketplace(raw: string | null | undefined): string {
  if (!raw) return "Unknown";
  if (raw.toLowerCase() === "opensea") return "OpenSea";
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

function isStonkBroker(collection: TrackedCollection): boolean {
  return collection.slug === "stonkbroker" || collection.openseaSlug === "stonkbrokers-434284142";
}

/**
 * StonkBroker sales: no emojis, no hashtags. Tickers close the post.
 *
 *   StonkBroker #4347 SOLD
 *   0.050 ETH
 *   OpenSea on Robinhood Chain
 *   0x1234…abcd → 0x5678…ef01
 *   {assetUrl}
 *   CLOCK IN https://www.stonkbrokers.cash/marketplace
 *   $Stonkbroker AAPL AMZN NVDA HOOD   (cashtag rotates per token id)
 *
 * Price is ETH only (never USD); the line is omitted if unresolved.
 * Only ONE cashtag allowed — X 403s posts with multiple $SYMBOLs.
 */
function renderStonkBrokerAlert(input: {
  event: CanonicalSaleEvent;
  collection: TrackedCollection;
}): string {
  const { event, collection } = input;
  const lines: string[] = [];

  lines.push(`${collection.displayName} #${event.tokenId} SOLD`);

  // ETH price only — never USD. When the price can't be resolved on-chain,
  // omit the line entirely rather than echo "price on OpenSea" (which put
  // the word OpenSea in the tweet twice).
  const symbol = (event.paymentSymbol ?? "ETH").replace(/^\$/, "");
  if (event.priceEth !== null && Number.isFinite(event.priceEth)) {
    const price =
      symbol === "STONKBROKER"
        ? Math.round(event.priceEth).toLocaleString("en-US")
        : formatEth(event.priceEth);
    const unit = symbol === "ETH" ? "ETH" : `$${symbol}`;
    const fee =
      event.ethFee !== null &&
      event.ethFee !== undefined &&
      Number.isFinite(event.ethFee) &&
      event.ethFee > 0
        ? ` (+ ${formatEth(event.ethFee)} ETH fee)`
        : "";
    lines.push(`${price} ${unit}${fee}`);
  }
  const venue = event.marketplace === "anvil" ? "Anvil AMM" : prettyMarketplace(event.marketplace);
  lines.push(`${venue} on Robinhood Chain`);
  lines.push(`${shortenAddress(event.seller)} → ${shortenAddress(event.buyer)}`);
  if (event.assetUrl) lines.push(event.assetUrl);

  // Plain CTA — no emoji arrow.
  const cta = collection.communityCallToAction.replace(/(?:➡️|→|➜|👉)\s*$/u, "").trim() || "CLOCK IN";
  lines.push(`${cta} ${collection.communityUrl}`);

  // X hard-rejects posts with more than one cashtag (403 "limited to a
  // maximum of one cashtag"). Rotate which ticker gets the cashtag, keyed by
  // token id so retries of the same sale render identically.
  const tokenNum = Number.parseInt(event.tokenId, 10);
  const cashtagIndex = Number.isFinite(tokenNum)
    ? Math.abs(tokenNum) % STONKBROKER_FOOTER_TICKERS.length
    : 0;
  const tickers = STONKBROKER_FOOTER_TICKERS.map((ticker, i) =>
    i === cashtagIndex ? `$${ticker}` : ticker,
  );
  lines.push(tickers.join(" "));

  return lines.join("\n");
}

/**
 * Render the X post body for a sale.
 *
 * StonkBroker posts use a dedicated no-emoji / ticker footer layout.
 * Other collections keep the stock-desk emoji template.
 */
export function renderSaleAlert(input: {
  event: CanonicalSaleEvent;
  collection: TrackedCollection;
  showFloorLine: boolean;
}): string {
  if (isStonkBroker(input.collection)) {
    return renderStonkBrokerAlert(input);
  }

  const { event, collection, showFloorLine } = input;
  const lines: string[] = [];

  lines.push(`${collection.displayName} #${event.tokenId} SOLD`);
  const symbol = (event.paymentSymbol ?? "ETH").replace(/^\$/, "");
  const price =
    event.priceEth === null || !Number.isFinite(event.priceEth)
      ? "?"
      : formatEth(event.priceEth);
  const unit = symbol === "ETH" ? "ETH" : `$${symbol}`;
  lines.push(`${price} ${unit}`);
  lines.push(prettyMarketplace(event.marketplace));
  lines.push(`${shortenAddress(event.seller)} → ${shortenAddress(event.buyer)}`);
  if (event.assetUrl) lines.push(event.assetUrl);
  const cta = collection.communityCallToAction;
  const hasArrow = /(?:➡️|→|➜|👉)\s*$/u.test(cta);
  lines.push(hasArrow ? `${cta} ${collection.communityUrl}` : `${cta}: ${collection.communityUrl}`);

  if (
    showFloorLine &&
    event.floorChangePct !== null &&
    Number.isFinite(event.floorChangePct) &&
    event.floorChangePct > 0
  ) {
    lines.push(`Floor +${event.floorChangePct.toFixed(1)}%`);
  }

  if (collection.hashtags && collection.hashtags.length > 0) {
    lines.push(collection.hashtags.join(" "));
  }

  return lines.join("\n");
}
