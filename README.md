# 2026 NFT Sales Bot

A production-grade NFT sales tracker for **X (Twitter)**. Drop in your collection, your X API keys, and an OpenSea key — get a live, image-rich sales feed posted automatically, every time someone buys.

```
🐾 Pixel Pup #4421 SOLD
💰 0.184 ETH
🐕 Opensea
🐕 0x2946…0b1a → 0xd317…0b22
https://opensea.io/assets/ethereum/0x1c75df005dd674630b212ce8106fcab29b1ac1bf/4421
The pack is growing: https://opensea.io/collection/pixel-pups
📈 Floor +4.2%
```

→ posted to X with the NFT image attached, automatically, within seconds of the sale settling on-chain.

---

## Why this exists

NFT sales bots exist on Discord and Telegram for years, but X bots are scarce — partly because the X API is awkward (OAuth 1.0a, image upload via media v2, aggressive rate limits) and partly because the OpenSea v2 events API has subtle quirks (mixed `nft`/`asset` shapes, address strings vs objects, missing `log_index`). This repo solves both.

It is the X-only carve-out of a battle-tested multi-platform sales bot, polished into a reusable skeleton any team can fork.

---

## Features

- **X-native posts** with NFT image attached (PNG/JPEG/WebP — content-negotiated automatically).
- **Multi-collection** — track any number of EVM NFT collections from one bot.
- **Per-sale dedupe** via Postgres unique constraint — never posts the same sale twice, even across restarts.
- **Burst-safe** — sales come in waves (mints, listings expiring); the X client serializes posts through a queue with a 1.5s minimum gap and 5-minute hard ceiling on retries so a stuck post can't block the burst.
- **24h floor delta** — gracefully gated to only display the `📈 Floor +X.X%` line once you have a true 24h baseline (no misleading "floor +12% in 7 minutes" out-of-the-box surprises).
- **OpenSea v2** events provider with chronological re-sort, pagination cap, and robust normalizer for the legacy/v2 payload variations.
- **OAuth 1.0a HMAC-SHA1 signing** built in — no third-party SDK, no surprises.
- **Idempotent self-migrating Postgres schema** — first start creates the tables, subsequent starts no-op.
- **Configurable per collection**: emoji, display name, call-to-action, community URL, minimum-price floor.
- **Drop-in deploy targets**: Railway one-click, Docker / docker-compose, plain Node.js.

---

## Architecture

```
┌──────────────┐    ┌──────────────────────┐     ┌─────────────────┐
│  OpenSea v2  │───▶│  fetchLatestSales()  │────▶│   normalize()   │
│  /events &   │    │  (per-collection     │     │  (canonical     │
│  /stats      │    │   cursor + paging)   │     │   shape)        │
└──────────────┘    └──────────────────────┘     └────────┬────────┘
                                                          │
                                                          ▼
┌──────────────┐    ┌──────────────────────┐     ┌─────────────────┐
│  X API v2    │◀───│   XClient.sendPost   │◀────│ db.upsertSale() │
│  /tweets +   │    │   (queue, OAuth 1.0a,│     │ (UNIQUE = dedupe│
│  /media      │    │    media upload)     │     │  primary)       │
└──────────────┘    └──────────────────────┘     └─────────────────┘
                                                          │
                          ┌───────────────────────────────┘
                          ▼
                   ┌──────────────────────┐
                   │ floor_snapshots +    │
                   │ getFloorBaseline()   │
                   │ (true 24h gating)    │
                   └──────────────────────┘
```

---

## Quick start

### 1. Clone and install

```bash
git clone https://github.com/simplefarmer69/2026-NFT-Sales-Bot.git
cd 2026-NFT-Sales-Bot
npm install
```

### 2. Get your keys

You'll need three things:

| Service     | What you need                                                      | Where                                                          |
| ----------- | ------------------------------------------------------------------ | -------------------------------------------------------------- |
| **OpenSea** | API key                                                            | <https://docs.opensea.io/reference/api-keys>                   |
| **X**       | App with OAuth 1.0a tokens (consumer key/secret + access pair)     | <https://developer.x.com> — see [X developer setup](#x-developer-setup) below |
| **Postgres**| Any Postgres 14+ database                                          | Locally via `docker compose up db`, or any managed Postgres    |

### 3. Configure your collections

Copy the example file and edit it for your collection(s):

```bash
cp collections.example.json collections.json
$EDITOR collections.json
```

Each entry looks like this:

```json
{
  "slug": "pixel-pups",
  "openseaSlug": "pixel-pups",
  "contract": "0x1c75df005dd674630b212ce8106fcab29b1ac1bf",
  "chainId": 1,
  "displayName": "Pixel Pup",
  "emoji": "🐾",
  "communityCallToAction": "The pack is growing",
  "communityUrl": "https://opensea.io/collection/pixel-pups",
  "minPriceEth": null
}
```

| Field                    | Required | Notes                                                                            |
| ------------------------ | -------- | -------------------------------------------------------------------------------- |
| `slug`                   | yes      | Stable internal id you choose. Lowercase + hyphens. Used for dedupe and logs.    |
| `openseaSlug`            | yes      | The path segment in `https://opensea.io/collection/{slug}`.                      |
| `contract`               | yes      | ERC-721/1155 contract address.                                                   |
| `chainId`                | yes      | EVM chain id. `1` for Ethereum mainnet.                                          |
| `displayName`            | yes      | Singular form, used in the alert. e.g. `Pixel Pup`, `BAYC`, `Doodle`.            |
| `emoji`                  | yes      | Single emoji prepended to the alert.                                             |
| `communityCallToAction`  | yes      | Phrase before the community URL. e.g. `The pack is growing`.                     |
| `communityUrl`           | yes      | URL printed after the call-to-action. Usually your OpenSea collection page.      |
| `minPriceEth`            | no       | Skip sales below this ETH value. Set to `null` to post all sales.                |

### 4. Set environment variables

```bash
cp .env.example .env
$EDITOR .env
```

Fill in `DATABASE_URL`, `OPENSEA_API_KEY`, and the four X tokens.

### 5. Run it

```bash
npm run build
npm start
```

You should see:

```
[migrate] applying 2 migration(s) from /path/db/migrations
[migrate]   001_sale_events.sql ok
[migrate]   002_floor_snapshots.sql ok
[migrate] all migrations applied
[boot] tracking 1 collection(s): pixel-pups
[boot] database OK
[boot] X client ready (OAuth 1.0a)
[loop] polling every 4000ms
```

The next sale of your collection on OpenSea will appear on your X account.

---

## X developer setup

This is the part most teams trip on. Read it once, do it correctly, never touch it again.

### A. Apply for X developer access

1. Go to <https://developer.x.com> and apply for an account with the X account you want the bot to post FROM.
2. Pick an access tier. **Free tier caps you at ~17 posts per 24h** — fine for a sleepy collection, useless for an active one. **Basic ($100/mo) gives you ~100 posts per 24h** which covers most real collections. **Pro** if you're tracking high-volume floors.

### B. Create an app

1. In the developer portal: **Projects & Apps → Create App** (or attach to an existing Project).
2. After creation, you'll see your **API Key** and **API Key Secret** (= consumer key/secret). **Save them now** — they're shown once.

### C. Set the app's permissions to *Read and Write*

This is the easy step to forget. The bot needs to **post tweets**, which requires Write.

- App settings → **User authentication settings** → **Set up**
- **App permissions: Read and write** (not Read-only).
- **Type of App: Web App, Automated App or Bot**.
- **Callback URI**: `http://localhost` (any valid URL works for OAuth 1.0a access-token-only use).
- **Website URL**: your project URL.
- Save.

### D. Generate the access token pair

- App page → **Keys and tokens** → **Access Token and Secret** → **Generate**.
- This produces an **Access Token** and **Access Token Secret** scoped to the **account that created the app**. **Save them now**.

⚠️ If you generated the access token pair *before* setting the app to Read+Write, the tokens will be Read-only and your tweets will 401. **Regenerate** the access token pair after flipping permissions.

### E. Wire them into `.env`

```dotenv
X_API_KEY=...                # the Consumer Key from step B
X_API_SECRET=...             # the Consumer Secret from step B
X_ACCESS_TOKEN=...           # from step D
X_ACCESS_TOKEN_SECRET=...    # from step D
```

### F. Sanity-check by sending one post manually

Before letting the bot run free, you can confirm credentials with a one-shot:

```bash
node -e '
import("./dist/src/x/client.js").then(async ({ XClient }) => {
  const x = new XClient({
    apiKey: process.env.X_API_KEY,
    apiSecret: process.env.X_API_SECRET,
    accessToken: process.env.X_ACCESS_TOKEN,
    accessTokenSecret: process.env.X_ACCESS_TOKEN_SECRET,
  });
  await x.sendPost("Tracker bot online ✅");
  console.log("ok");
});
'
```

If you see a 401, your tokens are Read-only — go back to step C/D.

---

## Deployment

### Railway (recommended, ~5 minutes)

1. Push the repo to your GitHub.
2. **railway.com → New Project → Deploy from GitHub** → select this repo.
3. **Add → Database → Postgres**.
4. In the bot service → **Variables** → wire in (`DATABASE_URL=${{Postgres.DATABASE_URL}}` and the X / OpenSea keys), plus `COLLECTIONS_JSON` with the inline collection config (the inline form avoids needing a writable filesystem).
5. **Deploy**. The bot self-migrates the database on startup and starts polling.
6. Verify by tailing logs — you should see `[boot] tracking N collection(s)` and shortly after, `[post] ok ...` lines as sales come in.

### Docker / docker-compose

```bash
cp .env.example .env
$EDITOR .env             # set X + OpenSea keys
cp collections.example.json collections.json
$EDITOR collections.json
docker compose up --build
```

That spins up a local Postgres and the bot side-by-side.

### Plain Node (your own VM / PM2 / systemd)

```bash
npm install
npm run build
NODE_ENV=production node dist/src/index.js
```

Put it behind PM2 or systemd with `restart=on-failure`. The bot is stateless apart from Postgres so you can run as many instances as you want against different collections — but only run **one** per X account or you'll trip rate limits.

---

## Customizing the alert format

The post layout is in [`src/format/alert.ts`](src/format/alert.ts). It's intentionally simple — open it and edit. Common tweaks:

- **Replace dog emojis** (🐕) with whatever fits your community.
- **Add USD price**: `lines.push(\`$\${event.priceUsd?.toFixed(0)}\`)`.
- **Replace the community CTA** with a Discord/Telegram invite instead of OpenSea.
- **Add tx link** (Etherscan): `lines.push(event.txUrl)`.

Keep total length under ~280 chars; the X client truncates as a final guardrail.

---

## How it works (the interesting bits)

### Dedupe is the database, not the application

The bot relies on Postgres `INSERT ... ON CONFLICT ... DO NOTHING` against a UNIQUE constraint over `(chain_id, tx_hash, log_index, contract, token_id)`. The `rowCount` of 1 vs 0 tells the loop whether to post. This means a crash mid-cycle is safe: on restart the same events get re-fetched from OpenSea but the DB silently swallows the duplicates and only the genuinely new ones get posted.

### Floor delta gating

The 24h `📈 Floor +X.X%` line is suppressed until the bot has at least one snapshot ≥24 hours old. Day 0 of a fresh deployment shows no floor line, and that's intentional — a "+12% over 7 minutes since launch" signal is misleading. Once the snapshot table accumulates a true 24h history, the line appears automatically. Snapshots are pruned weekly to bound storage.

### Burst handling

Sales arrive in clusters (a 50-NFT mint sweep, a series of bid acceptances). The OpenSea fetcher pages up to 2000 events per cycle and re-sorts them chronologically so the X feed reads oldest → newest. The X client wraps every send in a single global queue with a 1.5s minimum gap, so a 50-event burst paces itself out automatically and stays well clear of the X rate limit envelope. Failed posts log and continue; they don't block the rest of the burst.

### Image upload

X media v2 needs binary multipart, not a URL. The bot fetches the image with `Accept: image/png` first, falling back to `image/jpeg` then `image/webp` (because some IPFS gateways respond with AVIF by default, which X rejects). The response body is uploaded as a Blob inside `FormData`, with `media_category: tweet_image`. The response shape is read in both v2 (`data.id` / `data.media_key`) and legacy v1.1 (`media_id_string`) forms so X migrations don't silently break image attachment. If upload fails, the post still goes out — text-only — with a warning logged.

---

## Environment variables

See [`.env.example`](.env.example) for the full list. The required ones:

| Var                       | Purpose                                                  |
| ------------------------- | -------------------------------------------------------- |
| `DATABASE_URL`            | Postgres connection string                               |
| `OPENSEA_API_KEY`         | From the OpenSea developer portal                        |
| `X_API_KEY`               | Consumer Key                                             |
| `X_API_SECRET`            | Consumer Secret                                          |
| `X_ACCESS_TOKEN`          | Access token                                             |
| `X_ACCESS_TOKEN_SECRET`   | Access token secret                                      |
| `COLLECTIONS_PATH` *or* `COLLECTIONS_JSON` | One of: a path to a JSON file, or the JSON inline |

---

## Troubleshooting

### `401 Unauthorized` from X

Almost always: your access token pair was generated *before* you set the app to Read+Write. **Regenerate** the access token pair from the app's Keys page after flipping permissions.

### Posts arrive without an image

1. Confirm the `imageUrl` field on the canonical event is non-null — check the `[post] ok` log lines and the database `payload` column.
2. The image host is responding with AVIF or some other unsupported format → look for `[x.uploadMedia] image fetch failed for ... returned image/avif` in the logs.
3. The image is huge (X caps at 5 MB). The bot does not currently down-scale; if your collection's images are massive, swap `imageUrl` to OpenSea's `display_image_url` (the bot already prefers that when present).

### `429 Too Many Requests` from X

Your tier's post cap is exhausted. Free tier is ~17/day. The bot honors `retry-after` and `x-rate-limit-reset` automatically, but if you're consistently hitting the wall, upgrade to Basic.

### Duplicate posts

If you're seeing duplicates, your dedupe table is being reset. Make sure you're using a persistent `DATABASE_URL` and not an ephemeral one (e.g. `postgres://localhost/test` that gets nuked between restarts).

### Bot posts nothing for hours

1. Is the collection actually trading? Check OpenSea manually.
2. Are you running the bot against a contract that lives on a chain other than mainnet (e.g. Base, ApeChain)? OpenSea's `/api/v2/events/collection/{slug}` returns events from the chain the slug is registered on; double-check the chain matches your `chainId`.
3. Check `[loop] polling every Xms` is being logged. If the loop stopped, look for an unrecoverable error above it.

### `Could not locate db/migrations dir`

The migration runner walks up from its own location looking for a sibling `db/migrations` folder. If you've moved the compiled output around, point the runner at it manually by setting `RUN_MIGRATIONS=false` and running `npm run migrate` separately, or restoring the standard `dist/src` + `db/` layout.

---

## FAQ

**Can I track non-EVM chains?** Today: no — the OpenSea provider hits the v2 events endpoint which is EVM-only. Solana support would mean swapping the provider.

**Can I post to multiple X accounts?** Run multiple instances of the bot against the same Postgres, each with its own `COLLECTIONS_JSON` and X tokens. The dedupe table will keep them honest.

**Does it back-fill old sales?** No — by design. On first start it looks back `OPENSEA_POLL_LOOKBACK_SEC` seconds (default 15 min) and ignores anything older. Cranking that knob too high can spam your X account on a busy collection.

**Can I add Discord / Telegram?** This repo deliberately stays X-only to keep it tight. The architecture (canonical event → dispatcher) makes adding other delivery channels straightforward — the X client is just one consumer of the canonical event stream.

**What happens if my Postgres dies?** The bot crashes, the platform restarts it (`restartPolicyType: ON_FAILURE` in `railway.json`), and it picks up where it left off thanks to the unique constraint. No duplicate posts.

**How accurate is the 24h floor delta?** It's whatever OpenSea's `/collections/{slug}/stats.total.floor_price` returned 24h ago vs. now. The bot snapshots once per polling cycle, so it's accurate within `ALERT_POLL_MS` resolution. The line is **strictly gated** — if you don't yet have a 24h-old snapshot, the line is suppressed entirely instead of showing a misleading shorter-window delta.

---

## Project structure

```
.
├── README.md                  ← you are here
├── LICENSE                    ← MIT
├── package.json
├── tsconfig.json
├── Dockerfile
├── docker-compose.yml
├── railway.json
├── .env.example
├── collections.example.json
├── db/migrations/
│   ├── 001_sale_events.sql
│   └── 002_floor_snapshots.sql
├── src/
│   ├── index.ts               ← main loop
│   ├── types.ts
│   ├── config/
│   │   ├── env.ts
│   │   └── collections.ts
│   ├── db.ts
│   ├── db/
│   │   ├── migrate.ts
│   │   └── migrate-cli.ts
│   ├── providers/
│   │   └── opensea.ts
│   ├── normalize.ts
│   ├── format/
│   │   └── alert.ts
│   └── x/
│       └── client.ts
└── .github/workflows/ci.yml
```

---

## Contributing

PRs welcome. Two small asks:

1. Keep dependencies near-zero (`pg` and Node built-ins are it). Adding `axios`, `twit`, `oauth-1.0a` etc. is a regression — the existing OAuth and HTTP code is intentionally hand-written so the bot stays auditable in <1000 lines of TypeScript.
2. If you change the canonical event shape or the alert format, update both the `renderSaleAlert` test cases and the README example block at the top.

---

## License

MIT — see [LICENSE](LICENSE).
