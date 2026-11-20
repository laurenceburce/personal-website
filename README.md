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
- **Live planner:** one ongoing planner is available automatically, with no plan
  creation, switching, or deletion step. Existing entry and receipt IDs stay intact.
  Use date presets or custom **From / Through** dates to browse past activity and
  upcoming payments. These dates change only the view and can be shared in the URL;
  they never trim saved entries, change account balances, or record a payment.
  Projection ranges can extend up to two years. New transactions can be dated
  outside the current view, and recurring entries can continue without an end date.
  The USD and PHP summaries compare **Current balance** with **Projected balance**
  through the selected end date, including changes and a trend. Native asset balances
  stay separate from card/loan balances. Expand **Balances by account** for individual
  comparisons. Projections start with today's live values and remaining future flows;
  past-only ranges show history and live current balances without inventing past
  running balances. Unknown account values remain unavailable.
  The table opens in its compact view: date, description, source account, native
  amount, projected balance, and status. **Expand accounts** in the balance column
  reveals individual account columns across the whole table; **Collapse accounts**
  returns to the compact view. Search or filter **All / Upcoming / Recorded /
  Overdue** without changing calculated balances. Expand **Details** for statement,
  reserve, conversion, and bank matching evidence. Secondary actions stay in each
  row's menu; the primary payment/receipt action stays visible.
  The table scrolls within a fixed-height viewport and initially positions the
  highlighted latest row for today (or the nearest activity). **Jump to current**
  returns there without moving the page; refreshes preserve your browsing position.
  Expanded account columns use a horizontally scrollable grid on desktop and
  mobile, labeled by account name, currency, and balance owed for credit/loan accounts.
  On mobile, the compact view keeps its readable cards and an account-columns toggle.
  Future rows show projections; recorded rows reconstruct tracked balances from
  current values and later posted activity, following the table's transaction order
  within each day. Later transactions do not change earlier rows' account balances.
  Today's planned and recorded rows share that same sequence, including partially
  recorded transfers. Remaining planned movements carry into later rows once;
  compact cash totals use the same balances as the expanded account columns.
  Incomplete history stays unavailable. Text, status chips, and amount colors use
  stronger contrast, with labels as well as color to distinguish states.
  Manual accounts use the live planner as their source of truth: the saved starting
  balance and existing independent transactions form the baseline, and assigned
  planner activity through today updates the balance automatically. This includes
  existing entries, recurring occurrences, salary, bills, savings, and annual reserves.
  Future activity stays projected. Editing, deleting, or moving a planner entry corrects
  its generated account movements without duplicating them on refresh. Manual-only
  entries show their balance source instead of a separate recording choice.
  An existing manual transaction that uniquely matches a planner entry follows that
  entry too: edits update the same movement, and deleting it or moving it into the
  future removes its current balance effect. Unrelated transaction history is retained.
  Linked-account entries can be **Planned** or **Recorded · already happened**.
  Linked accounts include explicitly recorded amounts while awaiting a unique posted bank match,
  which replaces the generated record once. Use **Record payment** or **Record receipt**
  to enter the actual date and amount, including early or partial payments.
  **Credit card payment / Live remaining card balance** follows new charges and earlier
  payments, while recorded payments keep their actual amounts. Statement balances and
  optional autopay timing remain configurable under **Bank accounts**. No action sends
  a bank payment. Removing a recorded custom row reverses generated manual transactions;
  imported bank records are retained.
  **Planner settings** contains income, allocation, reserve, and optional account
  assignments. A new workspace starts with no assumed salary. Salary and bill schedules
  still drive payday allocations and annual reserves. Repeating transactions and
  payment setup details are available below the table. Balances and transaction matches
  refresh on open, focus, and every five minutes while visible; **Refresh** checks now.
- **Transactions:** quickly record one-time income or expenses from any view.
  Amount and description come first; date, category, note, and account are optional
  details. Search and filter history, edit manual entries, and view bank imports.
- **Bank accounts:** connect US accounts through Plaid, view native balances,
  and sync transactions. Production and sandbox connections are clearly labeled.
  Accounts are grouped into Checking, Savings, Credit cards, and Others. Credit
  cards show their reported statement balance and next payment due date.
  Use **Update accounts** on an existing connection when adding another bank
  account. Account identities and masked account numbers keep confirmed copies
  from a re-link together while distinct savings accounts stay separate.
  **Find duplicate accounts** previews confirmed identity matches before merging;
  merged accounts retain their transaction history and planner assignments.
  Cross-connection copies are excluded from totals without deleting their source
  rows. Removing an account hides it from active tracking and future syncs;
  unlinking a connection revokes access and retains its historical transactions.
  Add a manual USD/PHP account for cash or a bank without a connected provider;
  its native starting balance and live planner activity are tracked in the app.
  Balances refresh on open, focus, and every five minutes while visible, including
  when the Accounts or Overview screen stays open overnight.
  Use **Edit account** on a manual account or card to change its name, type,
  or current native balance. Balance corrections adjust the starting balance and retain transaction history;
  card statement details and automatic payment settings stay separate.
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
  preserve total funds. Moving general savings into a spending account releases
  those funds into the available balance, and the reverse sets them aside.
  Transfers within the same pocket stay neutral. Cross-currency
  moves require an explicit conversion. Assignments and projections never move
  bank funds or change synced balances.

Finance number fields preserve partial editing text, validate values on save,
and accept unambiguous pasted USD/PHP amounts. Backdrop gestures do not dismiss
edit dialogs; explicit close/Escape remain available, and Enter in text fields
does not accidentally submit the form.
Phone layouts use compact navigation, two-column plan summaries, and ledger
cards that fit the screen with completion and edit actions on each card. Unused
reserve/savings currencies collapse on phones; desktop keeps every column.
Plan refresh/delete controls live under **More options**, with account forecasts
and supporting details expandable. Edit dialogs follow the keyboard viewport and
restore the page's scroll position when closed.

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
New and updated links request additional consent for Liabilities, then retrieve
statement data only for linked credit accounts. Enable the Liabilities product
for the Plaid application to receive this data; existing links may need **Update
accounts** to grant the additional consent. Unsupported banks and failed
Liabilities requests keep balance and transaction syncing available. Previously
reported statement details are retained and marked stale. The implementation
retries Link token creation without additional statement consent if the Plaid
credentials are not enabled for Liabilities, preserving existing bank linking.
It follows Plaid's [personal finance product initialization guidance](https://plaid.com/docs/link/initializing-products/)
and [Liabilities field definitions](https://plaid.com/docs/api/products/liabilities/).
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
