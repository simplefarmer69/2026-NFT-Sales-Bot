import { readFileSync } from "node:fs";
import type { TrackedCollection } from "../types.js";

type RawCollection = {
  slug?: unknown;
  openseaSlug?: unknown;
  contract?: unknown;
  chainId?: unknown;
  displayName?: unknown;
  emoji?: unknown;
  communityCallToAction?: unknown;
  communityUrl?: unknown;
  minPriceEth?: unknown;
};

function asString(name: string, value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${where}: ${name} must be a non-empty string`);
  }
  return value.trim();
}

function asAddress(name: string, value: unknown, where: string): `0x${string}` {
  const str = asString(name, value, where);
  if (!/^0x[a-fA-F0-9]{40}$/.test(str)) {
    throw new Error(`${where}: ${name}=${str} is not a valid 0x-prefixed 40-char hex address`);
  }
  return str.toLowerCase() as `0x${string}`;
}

function asInt(name: string, value: unknown, where: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${where}: ${name}=${String(value)} must be a positive integer`);
  }
  return n;
}

function asOptionalNumber(value: unknown, where: string, name: string): number | null {
  if (value === undefined || value === null) return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${where}: ${name}=${String(value)} must be a non-negative number or null`);
  }
  return n;
}

function parseOne(raw: RawCollection, idx: number): TrackedCollection {
  const where = `collections[${idx}]`;
  const slug = asString("slug", raw.slug, where).toLowerCase();
  if (!/^[a-z0-9_-]{2,64}$/.test(slug)) {
    throw new Error(`${where}: slug=${slug} must match [a-z0-9_-]{2,64}`);
  }
  return {
    slug,
    openseaSlug: asString("openseaSlug", raw.openseaSlug, where),
    contract: asAddress("contract", raw.contract, where),
    chainId: asInt("chainId", raw.chainId, where),
    displayName: asString("displayName", raw.displayName, where),
    emoji: asString("emoji", raw.emoji, where),
    communityCallToAction: asString("communityCallToAction", raw.communityCallToAction, where),
    communityUrl: asString("communityUrl", raw.communityUrl, where),
    minPriceEth: asOptionalNumber(raw.minPriceEth, where, "minPriceEth"),
  };
}

export function loadCollections(input: { path: string | null; json: string | null }): TrackedCollection[] {
  let raw: string;
  let source: string;
  if (input.json) {
    raw = input.json;
    source = "COLLECTIONS_JSON";
  } else if (input.path) {
    raw = readFileSync(input.path, "utf8");
    source = input.path;
  } else {
    throw new Error("loadCollections: one of path or json is required");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${source}: ${(error as Error).message}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${source}: expected a non-empty JSON array of collection objects`);
  }

  const collections = parsed.map((row, idx) => parseOne(row as RawCollection, idx));

  const seenSlugs = new Set<string>();
  for (const c of collections) {
    if (seenSlugs.has(c.slug)) {
      throw new Error(`Duplicate slug "${c.slug}" in ${source}`);
    }
    seenSlugs.add(c.slug);
  }
  return collections;
}
