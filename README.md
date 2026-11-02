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
- `app/api/` — API routes: contact, analytics, chat, auth, sketch-share, admin
- `app/admin/` — admin panel for visit and chat logs
- `app/finance/` — private owner-only finance tracker
- `app/globals.css` — theme, layout, responsive behavior, and animations
- `.env.example` — every environment variable this app reads, grouped by feature
- `docker-compose.yml` — local MySQL for analytics/finance (see "Run locally")

## Run locally

Every feature past the portfolio itself (analytics, admin, chat, finance)
degrades gracefully when its own config is missing — the site still
renders and those routes just report "not configured" or redirect to a login
page instead of erroring. So step 1 already gets you a working site; the rest
is opt-in per feature, cheapest first.

### 1. Zero-config quick start

```powershell
npm install
npm run dev
```

Open `http://localhost:3000`. The portfolio, chat widget UI, and contact form
all render; `/admin` returns 503 (no admin token yet) and `/finance`
redirects to its login page (no database or auth yet) — all
expected, not bugs.

Copy `.env.example` to `.env.local` as you enable pieces below — it documents
every variable this app reads, grouped by feature, with the same guidance as
this section.

### 2. Local database (analytics, admin panel, finance)

These features share one MySQL database via `DATABASE_URL`. `docker-compose.yml`
starts one with Docker:

```powershell
npm run db:up
```

Then in `.env.local`:

```env
DATABASE_URL=mysql://root:devpassword@localhost:3306/portfolio
```

Restart `npm run dev`, then create the finance tables (safe to re-run):

```powershell
npm run db:init:finance          # add -- --seed for sample bills/goals
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

### 4. Finance tracker (`/finance`)

The tracker is gated to one owner email (`FINANCE_ALLOWED_EMAILS`,
defaulting to `laurenceburce@gmail.com`) via OAuth sign-in. For local testing, skip OAuth
entirely with a dev-only bypass instead of registering an OAuth app (it is
ignored whenever `NODE_ENV=production`):

```env
FINANCE_DEV_BYPASS=true
```

The planner uses the MySQL connection from step 2. Its new table is created
automatically on the first authorized visit; existing monthly salary and bill
records are imported once, and the previous tables are retained. Without a
database, the interface loads with saving disabled.

The finance workspace separates recorded activity from your plans:

- **Overview:** net worth, recorded income, spending, and net cash flow; a
  six-month income/spending graph; a planned allocation chart; dated bills
  and recent activity. Select a month and display amounts in USD or PHP.
- **Bills:** monthly and annual bills, native payment currency, due day,
  optional payment method/autopay, annual installments, and a monthly annual-bill reserve.
- **Spending plan:** automatic per-pay income, USD/PHP bills, annual reserves,
  and custom savings or expense allocations. Twice-monthly pay uses 24 periods;
  every-two-weeks pay uses 26. Select the schedule and first payday under salary.
- **Budget plans:** independent dated forecasts with starting USD/PHP balances,
  automatic bills/paydays, custom income/expense entries, conversions, and running
  balances in both currencies. Undated bills are flagged and excluded until dated.
- **Transactions:** quickly record one-time income or expenses from any view.
  Amount and description come first; date, category, note, and account are optional
  details. Search and filter history, edit manual entries, and view bank imports.
- **Bank accounts:** connect US accounts through Plaid, view native balances,
  and sync transactions. Production and sandbox connections are clearly labeled.
- **Salary & settings:** monthly salary with instant USD/PHP conversion and
  the first payday used by forecasts.

Actual income/spending totals exclude pending and future-dated transactions,
bank transfers, and loan-payment categories. Planned salary, recurring bills,
and allocations are not counted as posted activity. Bank account balances stay
provider-reported; one-time entries assigned to a manually tracked account
update its balance in that account's native currency. Imported records remain
read-only so a sync cannot silently replace your edits. Avoid manually recording
transactions that your bank already imports.

Plaid requires `PLAID_CLIENT_ID`, `PLAID_SECRET`, and `PLAID_ENV`, plus
`FINANCE_TOKEN_SECRET` or the existing `AUTH_SECRET` for encrypted token storage.
For OAuth banks, register an HTTPS `PLAID_REDIRECT_URI` ending at `/finance`
in your Plaid dashboard. The app resumes bank redirects on the accounts view.
Philippine bank authorization through Brankas requires a configured
`BRANKAS_LINK_URL`; this existing integration saves authorization only and does
not import balances or transactions. Its callback verifies a short-lived,
one-use state tied to the current browser.

The exchange rate comes from Frankfurter's daily USD/PHP reference feed,
cached for an hour with a manual refresh. It is not a bank's executable exchange
quote; provider failures show a clearly marked last-known rate or estimate.
Concurrent changes on another device are rejected instead of silently overwritten.

For a starting point, choose **Use workbook example** under **Salary & settings**.
It adds editable sample bills from the reference workbook; it does not record
payments or move money. Budget plans are hypothetical and recalculate when
salary, bills, or reference rates change.

For phone access, deploy this app to your existing HTTPS host with the same
MySQL, `AUTH_SECRET`, and OAuth settings. Open `/finance` on your phone and sign in with the
owner account. The **On your phone** control explains installation (Safari:
Share → Add to Home Screen; Android: browser menu → Install app). Saved changes
share the same database across devices. The home-screen **Quick transaction**
shortcut opens the entry form directly. The finance app requires a connection;
its service worker caches only public icons and shows a generic offline screen.

Run the finance calculation and validation checks with `npm run test:finance`.

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
