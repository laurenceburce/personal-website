# Portfolio (Next.js)

A responsive personal portfolio with dark/light theming, an AI-powered chat assistant, OAuth authentication, visitor analytics, and an interactive floating toolkit.

## Stack

- Next.js 16 (App Router) + React 19
- Plain CSS (`app/globals.css`) + `next/font/google` (Manrope, DM Serif Display)
- Google Gemini AI (`@google/genai`) — AI portfolio chat assistant
- NextAuth v5 — OAuth authentication (GitHub / Google)
- MySQL2 — visitor analytics, admin panel, and private finance tracker
- Resend — contact form email delivery
- html2canvas — sketch-to-image for the floating toolkit

## Project structure

- `app/layout.js` — global layout, metadata, font setup, and persistent widgets
- `app/page.js` — main portfolio page and sidebar
- `app/data/portfolio.js` — all editable content: skills, projects, timeline
- `app/components/portfolio/` — section components (Hero, About, Work, Education, Skills, Projects)
- `app/components/chat/ChatWidget.js` — Gemini-powered AI chat assistant
- `app/components/auth/` — NextAuth OAuth sign-in flow and feature gating
- `app/components/floating-toolbar/` — floating toolkit (sketch overlay, magnifier, calculator, virtual keyboard)
- `app/api/` — API routes: contact, analytics, chat, auth, sketch-share, download, admin
- `app/admin/` — admin panel for visit and chat logs
- `app/finance/` — private owner-only finance tracker
- `app/globals.css` — theme, layout, responsive behavior, and animations
- `.env.example` — every environment variable this app reads, grouped by feature
- `docker-compose.yml` — local MySQL for analytics/finance/job-search (see "Run locally")

## Run locally

Every feature past the portfolio itself (analytics, admin, chat, finance, job
search) degrades gracefully when its own config is missing — the site still
renders and those routes just report "not configured" or redirect to a login
page instead of erroring. So step 1 already gets you a working site; the rest
is opt-in per feature, cheapest first.

### 1. Zero-config quick start

```powershell
npm install
npm run dev
```

Open `http://localhost:3000`. The portfolio, chat widget UI, and contact form
all render; `/admin` returns 503 (no admin token yet) and `/finance` /
`/job-search` redirect to their login pages (no database or auth yet) — all
expected, not bugs.

Copy `.env.example` to `.env.local` as you enable pieces below — it documents
every variable this app reads, grouped by feature, with the same guidance as
this section.

### 2. Local database (analytics, admin panel, finance, job search)

All three share one MySQL database via `DATABASE_URL`. `docker-compose.yml`
starts one with Docker:

```powershell
npm run db:up
```

Then in `.env.local`:

```env
DATABASE_URL=mysql://root:devpassword@localhost:3306/portfolio
```

Restart `npm run dev`, then create each feature's tables (safe to re-run —
both are idempotent):

```powershell
npm run db:init:finance          # add -- --seed for sample bills/goals
npm run db:init:job-search
```

`npm run db:down` stops the container; the data stays in a named Docker
volume until you `docker compose down -v`. No local MySQL install needed —
if you'd rather point at an existing MySQL instance, skip `db:up` and just
set `DATABASE_URL` to that instead.

Without a database at all, analytics silently reports zero visits and the
admin panel's underlying data stays empty, but visitor counting itself never
throws.

### 3. Admin panel (`/admin`)

Needs only a token, no database:

```env
ANALYTICS_ADMIN_TOKEN=dev-admin-token
```

Sign in at `/admin/login` with that string as the password.
`GET /api/analytics/identified` also accepts it as
`Authorization: Bearer ANALYTICS_ADMIN_TOKEN`.

### 4. Finance tracker (`/finance`) and job search dashboard (`/job-search`)

Both are gated to one owner email (`FINANCE_ALLOWED_EMAILS` /
`JOB_SEARCH_ALLOWED_EMAILS`, defaulting to `laurenceburce@gmail.com`) via
OAuth sign-in — real visitors never see them. For local testing, skip OAuth
entirely with a dev-only bypass instead of registering an OAuth app (each is
ignored whenever `NODE_ENV=production`):

```env
FINANCE_DEV_BYPASS=true
JOB_SEARCH_DEV_BYPASS=true
```

Both need the local database from step 2 (`npm run db:init:finance` /
`npm run db:init:job-search`) to hold real data — without it they still load,
just empty.

Finance's linked-bank-account sync (Plaid, Brankas) and the job-search
dashboard's live posting discovery / LLM scoring / Playwright-driven ATS
submission are real integrations against live third-party services — see
`.env.example` for their variables. The submission side in particular drives
real applications to real companies, so there's no meaningful "local test
mode" for it beyond the dashboard/API/database layer above; treat it as a
production-only feature you configure once you mean to actually run it (see
`docs/job-search-submit-worker-deployment.md` for its separate always-on
worker service).

### 5. Contact form (Resend)

```env
RESEND_API_KEY=re_your_api_key
RESEND_FROM=Portfolio Contact <onboarding@resend.dev>
CONTACT_TO=your_destination_email@example.com
```

Use a verified sender/domain for `RESEND_FROM` in production. Resend's
`onboarding@resend.dev` sender works for local testing without one.

### 6. AI portfolio chat assistant (Gemini + sign-in)

Sending a chat message needs both a Gemini key and a signed-in NextAuth
session (any provider — this gate is "any visitor," not the owner-only one
above, so there's no dev-bypass flag for it). Add a key:

```env
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-3.5-flash
```

Then to actually sign in locally, the fastest path is a free GitHub OAuth
App (Settings → Developer settings → OAuth Apps → New, at
`https://github.com/settings/developers`) with:

- Homepage URL: `http://localhost:3000`
- Authorization callback URL: `http://localhost:3000/api/auth/callback/github`

```env
AUTH_GITHUB_ID=...
AUTH_GITHUB_SECRET=...
```

Google, LinkedIn, and Microsoft Entra ID work the same way (see
`.env.example`) — NextAuth only registers a provider once its own ID+secret
pair is set (`auth.js`).

### 7. Job search's Gmail security-code lookup

For the private job-search dashboard's security-code lookup, enable the Gmail
API for the same OAuth client and store a refresh token with the
`https://www.googleapis.com/auth/gmail.readonly` scope. The submit worker uses
this automatically when a supported emailed code prompt appears, and the
dashboard's "Check Email" button remains available as a manual fallback. The
dedicated `JOB_SEARCH_GMAIL_*` client values are optional if `AUTH_GOOGLE_ID`
and `AUTH_GOOGLE_SECRET` already point at that Gmail-enabled client.
In production, set these Gmail variables on the submit-worker service for
automatic entry, and on the web app service too if you want the dashboard
button fallback.

```env
JOB_SEARCH_EMAIL_PROVIDER=gmail
JOB_SEARCH_GMAIL_REFRESH_TOKEN=your_gmail_refresh_token
JOB_SEARCH_GMAIL_CLIENT_ID=optional_if_AUTH_GOOGLE_ID_is_the_same_client
JOB_SEARCH_GMAIL_CLIENT_SECRET=optional_if_AUTH_GOOGLE_SECRET_is_the_same_client
JOB_SEARCH_EMAIL_LOOKBACK_MINUTES=30
JOB_SEARCH_EMAIL_MAX_RESULTS=30
JOB_SEARCH_GMAIL_LABEL_IDS=INBOX
JOB_SEARCH_AUTO_EMAIL_SECURITY_CODE=true
```

Optional: set `JOB_SEARCH_EMAIL_SEARCH_QUERY` to add Gmail search filters such
as `from:no-reply@example.com`, or set `JOB_SEARCH_GMAIL_LABEL_IDS=*` to search
recent mail across labels instead of only `INBOX`. Set
`JOB_SEARCH_AUTO_EMAIL_SECURITY_CODE=false` to keep security-code prompts fully
manual. Keep the refresh token server-side only; never expose it with a
`NEXT_PUBLIC_` prefix.

### Production

On Railway, set `DATABASE_URL` as a reference variable to
`${{MySQL.MYSQL_URL}}`. The sidebar displays total and unique visit counts.
Visitor emails are stored only after a successful contact form submission and
can be read from the protected `/api/analytics/identified` endpoint using
`Authorization: Bearer ANALYTICS_ADMIN_TOKEN`.

Build and run the production server the same way Railway does:

```powershell
npm run build
npm start
```

## Customize quickly

1. Update your name, role, and copy in `app/data/portfolio.js` and `app/page.js`.
2. Edit arrays in `app/data/portfolio.js`:
   - `skillGroups`
   - `projects`
   - `timeline`
3. Adjust colors and spacing in `app/globals.css` under `:root`.
