import { createHmac, randomBytes } from "node:crypto";

type SupportedImageMime = "image/png" | "image/jpeg" | "image/webp";

const EXTENSION_BY_MIME: Record<SupportedImageMime, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
};

function detectSupportedMime(contentType: string): SupportedImageMime | null {
  if (contentType.startsWith("image/png")) return "image/png";
  if (contentType.startsWith("image/jpeg") || contentType.startsWith("image/jpg")) return "image/jpeg";
  if (contentType.startsWith("image/webp")) return "image/webp";
  return null;
}

function percentEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/!/g, "%21")
    .replace(/\*/g, "%2A")
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");
}

function oauthHeader(input: {
  url: string;
  method: string;
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}): string {
  const nonce = randomBytes(16).toString("hex");
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: input.consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp,
    oauth_token: input.accessToken,
    oauth_version: "1.0",
  };

  const normalizedParams = Object.entries(oauthParams)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${percentEncode(key)}=${percentEncode(value)}`)
    .join("&");

  const baseString = [
    input.method.toUpperCase(),
    percentEncode(input.url),
    percentEncode(normalizedParams),
  ].join("&");
  const signingKey = `${percentEncode(input.consumerSecret)}&${percentEncode(input.accessTokenSecret)}`;
  const signature = createHmac("sha1", signingKey).update(baseString).digest("base64");

  const authParts = { ...oauthParams, oauth_signature: signature };
  return `OAuth ${Object.entries(authParts)
    .map(([key, value]) => `${percentEncode(key)}="${percentEncode(value)}"`)
    .join(", ")}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * X API v2 client with:
 *  - OAuth 1.0a HMAC-SHA1 signing
 *  - Single global queue (X rate limits are app-wide, not per-channel)
 *  - 1500ms minimum gap between posts
 *  - 429 retry honoring `retry-after` and `x-rate-limit-reset` headers
 *  - Hard 5-minute total wait ceiling per post so a stuck retry can't block
 *    the rest of a sales burst
 *  - Image upload with content negotiation (png/jpeg/webp), v2 + v1.1
 *    response field compatibility, and graceful text-only fallback on failure
 */
export class XClient {
  private readonly createTweetUrl = "https://api.x.com/2/tweets";
  private readonly mediaUploadUrl = "https://api.x.com/2/media/upload";

  private queue: Promise<void> = Promise.resolve();
  private readonly minGapMs = 1500;
  private lastSendAt = 0;
  private readonly maxRetryWaitMs = 5 * 60 * 1000;

  public constructor(
    private readonly credentials: {
      apiKey: string;
      apiSecret: string;
      accessToken: string;
      accessTokenSecret: string;
    },
  ) {}

  private createAuthorization(method: string, url: string): string {
    return oauthHeader({
      method,
      url,
      consumerKey: this.credentials.apiKey,
      consumerSecret: this.credentials.apiSecret,
      accessToken: this.credentials.accessToken,
      accessTokenSecret: this.credentials.accessTokenSecret,
    });
  }

  private async fetchSupportedImage(
    imageUrl: string,
  ): Promise<{ buffer: Buffer; contentType: SupportedImageMime } | null> {
    // Some hosts default to AVIF (which X won't accept). We content-negotiate
    // through png → jpeg → webp until we get something X can ingest.
    const acceptHeaders: SupportedImageMime[] = ["image/png", "image/jpeg", "image/webp"];
    let lastError: string | null = null;

    for (const accept of acceptHeaders) {
      try {
        const response = await fetch(imageUrl, { headers: { accept } });
        if (!response.ok) {
          lastError = `fetch ${accept} -> ${response.status}`;
          continue;
        }
        const ct = (response.headers.get("content-type") ?? "").toLowerCase();
        const detected = detectSupportedMime(ct);
        if (!detected) {
          lastError = `fetch ${accept} returned ${ct || "unknown"}`;
          continue;
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.byteLength === 0) {
          lastError = `fetch ${accept} returned 0 bytes`;
          continue;
        }
        return { buffer, contentType: detected };
      } catch (error) {
        lastError = `fetch ${accept} threw ${(error as Error).message}`;
      }
    }

    console.warn(`[x.uploadMedia] image fetch failed for ${imageUrl}: ${lastError ?? "unknown"}`);
    return null;
  }

  /** Compute how long to wait after a 429, honoring retry-after / x-rate-limit-reset. */
  private rateLimitWaitMs(response: Response): number {
    const retryAfterRaw = response.headers.get("retry-after");
    if (retryAfterRaw) {
      const seconds = Number(retryAfterRaw);
      if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, this.maxRetryWaitMs);
    }
    const resetRaw = response.headers.get("x-rate-limit-reset");
    if (resetRaw) {
      const epochSec = Number(resetRaw);
      if (Number.isFinite(epochSec) && epochSec > 0) {
        const ms = epochSec * 1000 - Date.now();
        if (ms > 0) return Math.min(ms, this.maxRetryWaitMs);
      }
    }
    return 30_000;
  }

  private async uploadMediaFromUrl(imageUrl: string): Promise<string | null> {
    const fetched = await this.fetchSupportedImage(imageUrl);
    if (!fetched) return null;

    let totalWaited = 0;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const formData = new FormData();
      const filename = `nft-image${EXTENSION_BY_MIME[fetched.contentType]}`;
      const arrayBuffer = new ArrayBuffer(fetched.buffer.byteLength);
      new Uint8Array(arrayBuffer).set(fetched.buffer);
      formData.append("media", new Blob([arrayBuffer], { type: fetched.contentType }), filename);
      formData.append("media_category", "tweet_image");
      formData.append("media_type", fetched.contentType);

      const response = await fetch(this.mediaUploadUrl, {
        method: "POST",
        headers: { Authorization: this.createAuthorization("POST", this.mediaUploadUrl) },
        body: formData,
      });

      if (response.ok) {
        // X v2 returns `{ data: { id, media_key } }`; legacy v1.1 used
        // `{ media_id_string }`. Read both so the bot doesn't silently fall
        // through to a text-only tweet when X migrates the response shape.
        const payload = (await response.json()) as {
          data?: { id?: string; media_key?: string };
          media_id_string?: string;
          id?: string;
        };
        const mediaId =
          payload?.data?.id ??
          payload?.data?.media_key ??
          payload?.media_id_string ??
          payload?.id ??
          null;
        if (!mediaId) {
          console.warn(
            `[x.uploadMedia] upload OK but no media id in response: ${JSON.stringify(payload).slice(0, 200)}`,
          );
        }
        return mediaId;
      }

      if (response.status === 429 && totalWaited < this.maxRetryWaitMs) {
        const waitMs = Math.min(this.rateLimitWaitMs(response), this.maxRetryWaitMs - totalWaited);
        console.warn(`[x.uploadMedia] 429 rate-limited; sleeping ${Math.round(waitMs / 1000)}s before retry`);
        await sleep(waitMs);
        totalWaited += waitMs;
        continue;
      }

      const body = await response.text().catch(() => "");
      console.warn(`[x.uploadMedia] X media upload failed (${response.status}): ${body}`);
      return null;
    }
    return null;
  }

  /**
   * Public entry point. Chains every send onto a single queue so X never sees
   * concurrent requests from this bot and bursts are paced naturally.
   */
  public sendPost(text: string, imageUrl?: string | null): Promise<void> {
    const job = this.queue.then(async () => {
      const sinceLast = Date.now() - this.lastSendAt;
      if (sinceLast < this.minGapMs) await sleep(this.minGapMs - sinceLast);
      try {
        await this.doSendPost(text, imageUrl ?? null);
      } finally {
        this.lastSendAt = Date.now();
      }
    });
    // Errors on one job must not poison the queue, so we swallow into the
    // chain promise but rethrow to the original caller.
    this.queue = job.catch(() => undefined);
    return job;
  }

  private async doSendPost(text: string, imageUrl: string | null): Promise<void> {
    const mediaId = imageUrl ? await this.uploadMediaFromUrl(imageUrl) : null;
    if (imageUrl && !mediaId) {
      console.warn(
        `[x.sendPost] image was supplied but media upload failed; posting text-only — imageUrl=${imageUrl}`,
      );
    }
    const payload: { text: string; media?: { media_ids: string[] } } = { text: text.slice(0, 280) };
    if (mediaId) payload.media = { media_ids: [mediaId] };

    let totalWaited = 0;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const authorization = this.createAuthorization("POST", this.createTweetUrl);
      const response = await fetch(this.createTweetUrl, {
        method: "POST",
        headers: { Authorization: authorization, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (response.ok) return;

      if (response.status === 429 && totalWaited < this.maxRetryWaitMs) {
        const waitMs = Math.min(this.rateLimitWaitMs(response), this.maxRetryWaitMs - totalWaited);
        console.warn(`[x.sendPost] 429 rate-limited; sleeping ${Math.round(waitMs / 1000)}s before retry`);
        await sleep(waitMs);
        totalWaited += waitMs;
        continue;
      }

      throw new Error(`X post failed (${response.status}): ${await response.text()}`);
    }
    throw new Error("X post failed: rate-limit retries exhausted");
  }
}
