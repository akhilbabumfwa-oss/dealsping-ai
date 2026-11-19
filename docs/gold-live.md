# Gold Live Spot — local feature branch

## Final refinements / data provenance (19 November 2026)

The public feature is titled **Gold Live**. Kerala Gold Spot Market defaults to 1H and supports 1H/1D/1W/1M/3M/6M/1Y; USA stays on 1D with its existing filters.

Apply `006_gold_rate_provenance.sql` after `005_gold_live.sql` when preparing a database. Only LOCAL D1 has been migrated during development. Legacy rows are preserved as `unverified`, not promoted to genuine observations. Public manual rates/history require `admin_verified` provenance and a genuine server verification timestamp. Reference observations additionally require `reference_verified` provenance and permitted source metadata. Corrections retain their audit history.

Admin save now requires `verified: true`, corresponding to the explicit verification checkbox in the existing review dialog. With `GOLD_DEMO_MODE=true`, saved rows are classified as `test`, have no market verification timestamp, and stay excluded from public prices/history. Clients also reject demo/unverified legacy responses and show **Rate unavailable**, leaving calculator estimates unavailable.

The earlier local ₹12,140 CLT value was created by `local-gold-test`, not a verified market feed. It remains in the audit table but is not exposed publicly. No production database was inspected or modified for this refinement.

This adds `/api/gold/summary`, `/api/gold/history` and `/admin/gold/rates` to the existing Worker. No existing routes or Firebase synchronization are replaced.

## Development and release gates

- Apply `migrations/005_gold_live.sql` with `wrangler d1 execute dealsping-ai-db --local --file=migrations/005_gold_live.sql` for development only. It adds Gold tables; it never drops existing tables.
- Run `wrangler dev --local --port 8787`. `.dev.vars` is ignored. Use a local-only `ADMIN_SECRET`, `GOLD_WRITES_ENABLED=true`, and `GOLD_DEMO_MODE=true` for explicitly marked test rates. Never copy a production secret into test fixtures.
- The existing Admin server uses its existing verified administrator authentication, then proxies the existing Worker secret through `GOLD_WORKER_ADMIN_SECRET`. This secret never goes to the browser. Both website and Admin use server-only `GOLD_WORKER_ORIGIN=http://127.0.0.1:8787` in ignored development env files.
- Flutter uses `--dart-define=GOLD_API_ORIGIN=http://127.0.0.1:8787` for local Web previews; the normal default is the existing HTTPS Worker origin. No provider/admin keys are bundled in Flutter.
- Writes remain disabled unless the target Worker explicitly sets `GOLD_WRITES_ENABLED=true`. Development Admin writes refuse non-loopback Workers.
- Production migration, environment configuration, deployment and enabling writes require separate user approval. Nothing in this feature automatically applies a remote migration or deploys a service.

## Source policy and limitations

- Gold-API commercial use: https://gold-api.com/terms ; documented schema: https://gold-api.com/llms.txt ; limits: https://gold-api.com/faqs . Reviewed 19 November 2026.
- Current XAU/USD and XAU/INR conversion requests use a 30-second D1 cache and per-isolate request deduplication. Failures retain explicitly stale last-good values and use a 30-second retry backoff. Provider timestamps are retained.
- Optional `GOLD_API_KEY` is a Worker secret for daily history. The free provider offers daily aggregation, not minute/hour history, and shares 10 history/OHLC requests per hour. This implementation budgets at most eight hourly attempts and caches a year of daily averages for 24 hours.
- Without the history key, or during a provider outage, ranges show only genuinely collected D1 spot snapshots. There is no backfill of fictional points. Intraday snapshots are collected when current quotes are requested; no new unattended collector/cron is enabled. Missing periods remain gaps.
- No Kerala reference provider is configured. Reference rates must have a separately stored source with an actual permission URL and verification timestamp before they can appear. No scraping or international-to-Kerala fabricated local conversion is performed.
- Today's valid manual bullion spot takes priority over today's permitted jewellery reference. Old observations are visibly stale. Reference and manual histories remain separate series with labeled tooltips.
- Daily changes require a real previous-day observation. Missing changes are `null`, not zero. Estimates use `weight × selected 24K INR/g × purity/24`; taxes, making charges, premiums and buyback deductions are excluded.

## Audit and testing

Manual rates are append-only, with effective/recorded times and editor identity. Corrections reference the previous row, preserve the original market/time, require a reason and reject competing revisions. The legacy six-row editor and Quick Paste batches (up to 120 observations) are atomic. Future entries stay scheduled; unusually large changes require explicit confirmation. Public endpoints never accept mutations.

## Quick Paste and homepage status — local implementation

- Apply additive migration `007_gold_quick_paste.sql` after 005 and 006, only to an explicitly approved target. It has been applied to local D1 only. Original observations are not updated or removed.
- The existing Admin Gold page offers Quick Paste. Parsing the Telegram message produces an editable draft; unknown source, date, time, metal, purity and unit require explicit confirmation. The message and source are retained in `gold_rate_imports`; rows retain quoted amount/unit, normalized INR/g, author and batch ID. SPOT, RTGS, GOLD/SILVER and purities remain independent series.
- Supported explicit units: INR/g, INR/8g, INR/10g and INR/kg. Gold purities: 24K, 22K, 18K; silver fineness: 999 or 925. Unknown fineness/units cannot be published. Exact quoted amounts remain stored; normalized per-gram prices are used for the 24K graph only.
- Only admin-approved GOLD / 24K / SPOT rows participate in the existing Kerala summary/history/calculator. RTGS, lower purities and silver are available in the authenticated audit list, never substituted into the 24K chart. Repeated market/series/time imports are rejected; use the existing audited correction editor for supported legacy 24K/g entries. No historical observation is overwritten.
- Admin authentication/allowlisting and same-origin checks remain required. Development publishing requires a loopback Worker. `GOLD_WRITES_ENABLED=true` is still required; `GOLD_DEMO_MODE=true` saves test provenance which is excluded from public rates.
- Homepage Design 03 replaces the app bell/heart footprint with a 96x44 touch target / 96x32 glass button, retaining the original bullion asset. There is no large Gold homepage banner. The website uses the same compact entry in its existing navbar.
- The status dot refers to **international provider data**, never manual Kerala prices. Green requires a validated positive provider quote, nonfuture provider timestamp within 5 minutes, no stale/error/demo flag, and provider provenance. Its 1.5-second breathing cycle retains at least 65% core opacity. Reduced motion, inactive Flutter routes/background lifecycle and hidden browser documents stop the animation.
- The provider documentation (`https://gold-api.com/llms.txt`) does not expose a session-status field. Confirmed closure can be signalled by Worker configuration `GOLD_MARKET_STATUS=closed`, producing static amber for a valid provider quote. Do not infer closure from an old timestamp; absent trusted closure information, stale/unavailable data remains grey. Provider timestamp validation is not an independent guarantee of market-price accuracy.
- Targeted tests: `node --test test/gold*.test.js` (30 Worker/SQLite tests), Admin `node --test lib/goldQuickPaste.test.mjs` (5 parser tests), website `node --test lib/goldLive.test.mjs` (6 helper tests), Flutter Gold/header/preview suite (32 tests). Browser-only provider fixtures and quarantined local D1 fixtures are not production rates.

Run `node --test test/gold.test.js` (Node 24, built-in SQLite) and `wrangler deploy --dry-run` for a local compilation check only. Tests use an isolated in-memory database and provider stubs, not production data. The live localhost integration smoke check should be run only against the local Wrangler D1 instance.

The pinned pre-existing Wrangler development dependency tree reports six advisories (five high, one low); production dependencies have zero audit findings. Review a toolchain upgrade separately rather than automatically updating unrelated dependencies.

## Historical review and continuous chart segments (19 November 2026)

Apply additive migrations 008 and 009 after 007. They have been applied to LOCAL D1 only. Migration 009 adds rejection audit records and cross-decision guards; it never edits source cells or published prices. GET history-records reports original structural status plus approval/rejection and rejection reasons. POST history-approve and history-reject use the same existing admin authorization, same-origin proxy and write guard. Approval requires independent financial review and explicit metadata confirmation. Rejection requires a reason of 8–1000 characters and retains the source observation. Approved records cannot be rejected; corrections remain append-only. Pending ambiguous records cannot be promoted through the approval endpoint.

The workbook remains unchanged: SHA256 6ff5dda8f7d97b0f094461a66667458faa5793381a5b5a0f88d069da910640f1. Local staging contains 3355 observations, 289 source rows and 5170 original cells. Of these, 1690 city SPOT/RTGS observations are structurally accepted, not financially approved. The other 1665 are 817 commodity, 344 currency, 199 retail and 305 Market Open observations. All 1665 have unresolved complete currency/unit semantics; 305 have no recorded time. Seven auxiliary commodity jumps are flagged without corrections. There are zero workbook approval or rejection decisions and zero workbook observations published.

Website and Flutter now use smooth bounded cubic drawing through actual endpoints instead of manual step lines. Cubic controls remain within endpoint prices, preventing invented extrema. These curves are visual guides, not added observations. Normal overnight intervals on consecutive IST calendar dates can connect; missing IST dates, gaps over 36 hours, and duplicate timestamps split segments. The 1H window retains a one-hour gap limit. USA provider gaps remain unchanged. Tooltip prices retain cents/paise where present and timestamps include recorded date/time in IST. Statistics use actual samples only. Default Kerala range is 1H; USA is 1D. The development review can select 1M without changing production defaults.

The authenticated Admin remains the only publication path. Development-only loopback review pages show unpublished source data with an unverified label, disable calculator estimates for those quotes, and never affect the live-status dot. Re-import remains idempotent. No source or historical values were automatically approved or corrected.

Validation this pass: 30 Worker tests, 6 website tests, 5 Admin parser tests, 32 Flutter tests passed; targeted Flutter analysis and Admin TypeScript clean; website production build passed. Real local browser checks exercised all seven ranges, exact IST tooltips, five curve segments in CLT 1M, mobile 320/415 and desktop 1280 widths in both themes, plus unauthorized approval/rejection 401 responses. Local provider smoke test returned XAU/USD and USD/INR with provider observation timestamps; local demo mode deliberately keeps the dot grey. The pre-existing website article-index and workspace-root warnings remain unrelated. Signed-in end-to-end Admin publishing is still pending: no unverified workbook values were published to test the browser.

## Final Kerala continuity / historical headline correction

This supersedes the earlier Kerala missing-date segmentation policy. Flutter and Website connect consecutive actual Kerala samples in chronological order even across missing calendar dates. The disclosure explicitly states that intervening prices were not recorded; the line does not add samples, change statistics or fabricate timestamps. USA gap handling is unchanged. Separate reference/SPOT series remain separate.

History returns lastRecorded independently of the selected range. It contains the latest comparable24K SPOT INR/g observation, original timestamp, source cell when available, and change from the preceding strictly earlier comparable observation. It is always marked historical/notlive, never verified as a live quote. Public history still selects approved records only; staging remains admin/local-review only. The chart uses this fallback when a current Kerala quote is absent or stale. The live indicator and calculator do not consume it.

Workbook SPOT Rates!C217 is exactly13150, dated19Nov2026 10:42IST; I217 is separateRTGS13340. User-confirmed metadata:24K INR/g andIST. The preceding SPOT observation is13370, giving-220; this is a prior-observation change, not a guaranteed previous-day change. No source values were edited. Prior Rate unavailable was due to correctly quarantined unpublished data plus a missing historical-headline fallback.

Flutter debug local review can be enabled with GOLD_HISTORY_REVIEW_SOURCE=6ff5dda8f7d97b0f094461a66667458faa5793381a5b5a0f88d069da910640f1 and GOLD_REVIEW_ORIGIN=http://127.0.0.1:3001. This reads the existing local-only Admin review proxy, requires preview=true/verified=false, and is disabled outside debug/loopback. No admin secret enters Flutter. Release/public verification gates are unchanged. Unapproved observations are not bundled in the app or published. Native captures use the same local-review response structure and original workbook points.

Targeted validation:31Worker tests,7Website helper tests,22Flutter tests pass. Website production build passes; targeted Gold Flutter analysis passes after a braces-only lint correction. No commit/push/merge/deploy/APK/AAB or new workbook approval decisions.
