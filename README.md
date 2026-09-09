# DealsPing AI — Deal Discovery System

Cloudflare Workers + D1 backend that mirrors DealsPing's Firebase deal data into a fast, AI-queryable API, MCP server, and admin dashboard. Completely separate from `dealsping-next` — read-only against Firebase, never writes back.

**Live:** https://dealsping-ai.akhilbabumfwa.workers.dev

## Architecture

- **sync.js** — pulls `deals` + `monitored_deals` from Firestore REST API (no SDK), maps to D1 schema, upserts, marks stale deals inactive.
- **engine.js** — deal score (0-100) calculation, freshness decay, AI list rebuilding, 4-day category rotation.
- **api.js** — public REST API (`/api/*`), rate-limited, CORS-open, 5-minute cache headers.
- **mcp.js** — Model Context Protocol tool server at `/mcp` + manifest at `/.well-known/mcp.json`.
- **admin.js** — protected dashboard API (`/admin/*`), gated by `X-Admin-Secret` header.
- **index.js** — router + cron handler (sync every 6h, rebuild lists every 2d, rotate categories every 4d).

## Setup

```bash
cd /home/ubuntu/dealsping-ai
npm install

# 1. Create the D1 database
npx wrangler d1 create dealsping-ai-db
# → copy the returned database_id into wrangler.toml

# 2. Apply schema (local + remote)
npx wrangler d1 execute dealsping-ai-db --file=schema.sql
npx wrangler d1 execute dealsping-ai-db --file=schema.sql --remote

# 3. Set secrets
npx wrangler secret put FIREBASE_API_KEY   # your Firebase Web API key
npx wrangler secret put SYNC_SECRET        # random string
npx wrangler secret put ADMIN_SECRET       # random string

# 4. Deploy
npx wrangler deploy
```

## Endpoints

| Path | Purpose |
|---|---|
| `GET /health` | Health check |
| `GET /api/deals/best` | Top deals by score |
| `GET /api/deals/latest` | Newest deals |
| `GET /api/deals/trending` | Trending deals |
| `GET /api/deals/featured` | Featured deals |
| `GET /api/deals/search?q=` | Keyword search |
| `GET /api/deals/category/:category` | Deals by category |
| `GET /api/deals/price?min=&max=` | Deals by price range |
| `GET /api/deals/store/:store` | Deals by store |
| `GET /api/deals/:id` | Single deal (id or slug) |
| `GET /api/lists/:list_type` | Any AI list |
| `GET /api/categories` | Category counts |
| `GET /api/stats` | Platform stats |
| `GET/POST /mcp` | MCP tool server |
| `GET /.well-known/mcp.json` | MCP manifest |
| `GET /.well-known/ai-plugin.json` | ChatGPT plugin manifest |
| `GET /openapi.yaml` | OpenAPI 3.0 spec |
| `GET /dashboard` | Admin dashboard UI |
| `GET/POST /admin/*` | Admin API (needs `X-Admin-Secret`) |
| `POST /sync` | Manual sync trigger (needs `X-Sync-Secret`) |

## AI Lists

`best_deals`, `latest_deals`, `trending_deals`, `featured_deals`, `under_500`, `under_1000`, `under_2000`, `under_5000`, `electronics`, `fashion`, `home_kitchen`, `mobiles`, `with_coupon`, `with_bank_offer`, `amazon_deals`, `flipkart_deals`.

## Deal Score Formula (0-100)

```
discount_score   = (discount_pct / 100) * 25
freshness_score  = freshness (0-1, decays over 7 days) * 20
price_score      = tiered by current_price, max 15
trending_score   = 15 if trending else 0
featured_score   = 10 if featured else 0
coupon_bonus     = 10 if coupon_code else 0
bank_offer_bonus = 5 if bank_offer else 0
```

## Notes / Limitations

- Rate limiting (60 req/min/IP) is best-effort in-memory per Worker isolate — not strictly distributed. Sufficient to blunt casual abuse; for hard guarantees, migrate to Durable Objects or a KV-backed counter.
- Affiliate URLs are copied verbatim from Firebase — never modified.
- Sync never touches Firebase; it's read-only via the Firestore REST API with an API key.
- `firestore.rules` on the source project already have `allow read: if true` on `deals`/`monitored_deals`, so the API key alone is sufficient (no service account needed for reads).
