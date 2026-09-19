export type AppEnv = {
  databaseUrl: string;
  openSeaApiKey: string;
  openSeaBaseUrl: string;
  openSeaPollLookbackSec: number;
  seaportRhLookbackSec: number;
  xCredentials: {
    apiKey: string;
    apiSecret: string;
    accessToken: string;
    accessTokenSecret: string;
  };
  collectionsPath: string | null;
  collectionsJson: string | null;
  pollMs: number;
  runMigrations: boolean;
  floorDeltaLine: boolean;
  /** Sales older than this many seconds are baselined (marked posted) without tweeting. 0 = off. */
  maxPostAgeSec: number;
};

function requireString(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function parseBool(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error(`Invalid boolean for ${name}=${raw} (expected true|false|1|0)`);
}

function parsePositiveNumber(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid numeric env var ${name}=${raw}`);
  }
  return parsed;
}

function parseNonNegativeNumber(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid numeric env var ${name}=${raw}`);
  }
  return parsed;
}

function parseOptionalString(name: string): string | null {
  const value = process.env[name];
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function loadEnv(): AppEnv {
  const xCredentials = {
    apiKey: requireString("X_API_KEY"),
    apiSecret: requireString("X_API_SECRET"),
    accessToken: requireString("X_ACCESS_TOKEN"),
    accessTokenSecret: requireString("X_ACCESS_TOKEN_SECRET"),
  };

  const collectionsPath = parseOptionalString("COLLECTIONS_PATH");
  const collectionsJson = parseOptionalString("COLLECTIONS_JSON");
  if (!collectionsPath && !collectionsJson) {
    throw new Error(
      "Set COLLECTIONS_PATH (file path) or COLLECTIONS_JSON (inline). See collections.example.json.",
    );
  }

  return {
    databaseUrl: requireString("DATABASE_URL"),
    openSeaApiKey: requireString("OPENSEA_API_KEY"),
    openSeaBaseUrl: process.env.OPENSEA_BASE_URL ?? "https://api.opensea.io",
    // OpenSea HTTP API lookback (Pup Cup).
    openSeaPollLookbackSec: parsePositiveNumber("OPENSEA_POLL_LOOKBACK_SEC", 1800),
    // Seaport-on-RH lookback — StonkBrokers / Stonk Interns OpenSea fills are sparse vs AMM
    // traffic. Railway often pins OPENSEA_POLL_LOOKBACK_SEC=900 (15m), which
    // drops marketplace sales that land outside that window. 4h default so a
    // redeploy also back-fills sales missed while the old window was live;
    // DB dedupe (posted=true) prevents double tweets.
    seaportRhLookbackSec: parsePositiveNumber("SEAPORT_RH_LOOKBACK_SEC", 14_400),
    xCredentials,
    collectionsPath,
    collectionsJson,
    pollMs: parsePositiveNumber("ALERT_POLL_MS", 4000),
    runMigrations: parseBool("RUN_MIGRATIONS", true),
    floorDeltaLine: parseBool("FLOOR_DELTA_LINE", true),
    // Cutover guard: when a NEW collection joins the tracking list, the 4h
    // Seaport lookback would replay its whole recent history as a tweet burst.
    // Set this (e.g. 900) for the first deploy so older sales are baselined
    // into the dedupe table silently, then remove it so outage backfills work.
    maxPostAgeSec: parseNonNegativeNumber("MAX_POST_AGE_SEC", 0),
  };
}
