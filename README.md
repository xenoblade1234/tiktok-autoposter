# Vienna Webdesigns TikTok Autoposter

KI-Video erzeugen -> im Dashboard prüfen und einplanen -> automatisch auf TikTok posten.

- `template/` HyperFrames-Vorlage (1080x1920, 15 s, Vienna-Look), Texte als Variablen
- `generator/generate.mjs` schreibt Texte mit OpenAI, rendert, lädt hoch (GitHub Actions täglich 05:00 UTC)
- `worker/` Cloudflare Worker: Dashboard, D1 (Status, Token verschlüsselt), KV (Videos), Cron alle 10 Min.

Nichts wird ohne "Einplanen" im Dashboard gepostet. Jedes Video wird als KI-generiert gekennzeichnet (is_aigc).

Dashboard: https://vienna-tiktok-autoposter.facebookleadssms.workers.dev

Worker-Secrets: TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, DASHBOARD_PASSWORD, APP_SECRET, AUTOPOSTER_SECRET
GitHub-Secrets: OPENAI_API_KEY, AUTOPOSTER_URL, AUTOPOSTER_SECRET
Website-Worker viennawebdesigns: TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, AUTOPOSTER_URL, AUTOPOSTER_SECRET

Lokal testen: `cd worker && npx wrangler dev` (Testwerte in `.dev.vars`),
Generator ohne Upload: `DRY_RUN=1 OPENAI_API_KEY=... node generator/generate.mjs`
