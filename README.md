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
  Choose **Every payday** for a bill paid on your salary schedule. Enter the
  amount of each payment, such as ₱19,000 per payday, rather than a monthly total.
  It follows the first payday and frequency under salary settings automatically;
  biweekly months can have three payments. The monthly view and overview chart
  show its average monthly cost (per-pay amount × 26 or 24 ÷ 12); spending plans
  deduct the full per-pay amount, and budget plans use the actual payday dates.
  Monthly bills retain their combined monthly total and fixed date rules.
  Monthly bills can split their total across two due days. Annual bills show a
  **Target saved by now**, prorated between the previous and next payment dates;
  the target is not a recorded bank or savings balance. Undated annual bills
  need a due date before a savings target can be calculated.
  Each annual bill also has a manually entered **Saved so far** balance in its
  payment currency, with **Still to fund** shown separately from the suggested target.
  Changing that balance recalculates the item's monthly contribution, reserve
  totals, overview allocation chart, spending plan, and budget forecasts.
  Contributions use each bill's next payment or installment, less its saved
  funds, divided across salary paydays from today through its due date. Same-day
  paydays can fund that day's payment. Contributions round up to cents; the final
  planned set-aside is capped at the remaining shortfall. The monthly allocation
  is the equivalent of this per-pay contribution. Extra savings on one bill do
  not cover another bill. A funded next installment needs no contribution until
  it is paid. The calendar progress target and full annual cost stay separate;
  meeting today's target still allows ongoing funding for future payments.
  Bills without a date or salary schedule show an estimate. A payment with no
  eligible payday remaining shows its immediate cash shortfall separately.
- **Spending plan:** automatic per-pay income, USD/PHP bills, annual reserves,
  and custom savings or expense allocations. Twice-monthly pay uses 24 periods;
  every-two-weeks pay uses 26. The annual row highlights the total monthly
  funding and lists the per-payday deduction beneath it. Remaining funds and
  payday allocations use that deduction. The expanded annual breakdown shows
  both units for each bill. Select the schedule and first payday under salary;
  the next four paydays preview before saving. New planners default to every
  two weeks, anchored exactly 14 days from the first payday. Twice-monthly pay
  deliberately uses two fixed calendar dates instead.
- **Budget plans:** dated money-flow plans with starting available USD/PHP balances
  and separately entered annual reserves. Include salary, bills, payday savings
  and expense allocations, annual-bill set-asides, custom entries/conversions,
  and recorded transactions across the entire date range (including transfers).
  Pending bank entries are excluded until posted. A matching posted salary or
  bill replaces its scheduled row; conservative matching uses amount, currency,
  date and description. Each annual bill keeps its own saved balance and payday
  contributions. An annual payment row shows only the additional cash needed
  after using those funds, with the full payment and reserve used in its detail.
  For example, a $395 bill with $100 saved needs $295 more; later set-asides can
  reduce that further. If two paydays remain before it is due, the contribution
  is $147.50 per payday. Plans recalculate against the remaining payment dates
  and earmarked balance on every payday. Set-asides pause when the next payment
  is funded, then resume after payment for the following installment or renewal.
  Saved balances seed each hypothetical plan once and are
  not reduced in the bill editor by a forecast. Undated bills are flagged;
  annual reserves still build on paydays.
  Flow sources can be toggled when creating or editing a plan. Opening balances
  are measured before the first day's flows; opening reserves must be actual
  funds you have set aside, not the suggested savings target.
  Saved amounts entered on annual bills are included automatically in the
  starting reserve. The plan's total starting reserve can increase that amount
  with unassigned funds; it does not add the same item savings a second time.
  Select starting bank accounts and a percentage of each current actual balance,
  then add flat USD/PHP amounts. These links stay live rather than saving bank
  balance snapshots. Already-earmarked annual savings are excluded from available
  starting cash once and remain in the reserve pocket. Posted and historical
  flows already reflected in selected live balances stay visible without being
  applied to those balances again.
  Rows can be marked done or reopened manually. Posted transactions automatically
  complete conservative account/currency/amount/date/name matches; pending and
  future entries do not. Automatic completion remains available when recorded
  cash-flow rows are hidden. Transfers need both assigned native legs, including
  grouped annual-reserve contributions. Checkmarks record progress and do not
  create bank payments or change forecast amounts.
  Bank balances and transaction matches refresh when Budget plans opens, regains
  focus, and every five minutes while visible. Automatic provider refresh attempts
  share a 60-second cooldown; **Refresh bank data** forces a fresh request. Failures
  keep the last known data with an explicit notice.
  Edit a scheduled row to change its date, description, or amount for that one
  occurrence in that plan. Recurring settings and other dates stay unchanged;
  **Reset** restores the recurring default. Enter zero to skip an occurrence's
  amount. Annual payment edits use the full payment before reserve coverage;
  annual set-aside edits are distributed across bills up to their funding need.
  Running savings columns start with linked savings-account balances and show
  planned movements, with annual reserves excluded. Accounts are counted once;
  savings without an assigned account accumulate separately from zero. Unknown
  bank balances are shown as unavailable.
- **Transactions:** quickly record one-time income or expenses from any view.
  Amount and description come first; date, category, note, and account are optional
  details. Search and filter history, edit manual entries, and view bank imports.
- **Bank accounts:** connect US accounts through Plaid, view native balances,
  and sync transactions. Production and sandbox connections are clearly labeled.
  Use **Update accounts** on an existing connection when adding another bank
  account. Account identities and masked account numbers keep confirmed copies
  from a re-link together while distinct savings accounts stay separate.
  **Find duplicate accounts** previews confirmed identity matches before merging;
  merged accounts retain their transaction history and planner assignments.
  Cross-connection copies are excluded from totals without deleting their source
  rows. Removing an account hides it from active tracking and future syncs;
  unlinking a connection revokes access and retains its historical transactions.
  Add a manual USD/PHP account for cash or a bank without a connected provider;
  its native opening balance and recorded movements are tracked in the app.
- **Salary & settings:** monthly salary with instant USD/PHP conversion and
  the first payday used by forecasts.
  Choose the account receiving salary. Each bill can select a payment account;
  annual bills can also select a reserve savings account and funding source.
  Payday savings select a destination account and optional source (defaulting
  to the salary account in the same currency). Account cards show annual funds
  reserved, planned payday savings, and any reserve balance exceeding bank funds.
  Budget plans project native account balances and transfers alongside available
  funds. Selected live starting accounts use their latest percentage allocation;
  already-posted history is excluded from that account forecast. Manual transfers
  preserve total funds; cross-currency
  moves require an explicit conversion. Assignments and projections never move
  bank funds or change synced balances.

Finance number fields preserve partial editing text, validate values on save,
and accept unambiguous pasted USD/PHP amounts. Backdrop gestures do not dismiss
edit dialogs; explicit close/Escape remain available, and Enter in text fields
does not accidentally submit the form.

Overview income/spending totals exclude pending and future-dated transactions,
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
