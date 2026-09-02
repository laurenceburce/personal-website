# Job-search code removal plan (not executed yet)

The job-search feature that used to live in this repo has been extracted
into its own standalone, multi-tenant platform:
**https://github.com/laurenceburce/job-search-platform** — see that repo's
[`docs/source-repo-relationship.md`](https://github.com/laurenceburce/job-search-platform/blob/main/docs/source-repo-relationship.md)
for the full story of what was ported, what changed, and what still
differs.

**Production is already off** (2026-09-02): both dedicated Railway
services in this repo's `personal-website` project —
`job-search-poll-worker` and `job-search-submit-worker` — have been
stopped (zero running replicas) and disconnected from GitHub auto-deploy.
A future push to `main` will not resurrect them. The `web` service (this
site) is still running as normal, since it also serves finance and the
rest of the portfolio — its `/job-search` and `/api/job-search/*` routes
are still reachable in the browser, but inert: nothing is running behind
them to discover, score, or submit anything anymore.

This document is the **inventory for removing the code itself**, which is
deliberately not done yet. Nothing below has been executed.

## Fully job-search-exclusive — safe to delete outright

- `app/job-search/` — 17 files, every UI page for the feature.
- `app/api/job-search/` — 19 files, every API route.
- `app/lib/jobSearch*.js` — 35 files (stores, pipelines, adapters glue).
- `app/lib/jobSearchAdapters/` — 20 files (the 8 ATS submission adapters +
  shared helpers).
- `scripts/init-job-search-db.mjs`, `scripts/job-search-worker.mjs`,
  `scripts/job-search-submit-worker-server.mjs`,
  `scripts/job-search-oracle-connect.mjs`,
  `scripts/job-search-ats-submission-audit.mjs` — 5 files.
- `Dockerfile.job-search-submit-worker`.
- `docs/job-search-submit-worker-deployment.md`.
- `instrumentation.js` — its ONLY job is starting
  `jobSearchHeldChallengeWatcher.js` (confirmed: nothing else registers
  through this hook). Delete the file entirely rather than emptying it,
  unless something else starts using Next's `register()` hook before this
  removal happens.
- `public/sw.js` — its ONLY job is job-search's push notifications
  (confirmed: no other feature here uses a service worker). Delete
  entirely, same caveat as above.

That's ~97 files gone outright, no partial edits needed.

## Shared files needing a partial edit, not full deletion

These also serve finance/other portfolio content — remove only the
job-search-specific lines, verify the rest still works:

- **`auth.js`** — remove `DEFAULT_JOB_SEARCH_EMAIL` (line 9),
  `getJobSearchAllowedEmails()`/`isJobSearchAuthorizedEmail()` (lines
  22-31), and the `session.user.isJobSearchAuthorized = ...` assignment
  (line 82). Leave the finance equivalents (`getFinanceAllowedEmails`,
  `isFinanceAuthorizedEmail`) and the shared OAuth provider setup
  untouched.
- **`app/globals.css`** — the entire job-search stylesheet is one
  contiguous, clearly-labeled block: lines 7117
  (`/* ... Job Search — self-contained owner-only dashboard ... */`)
  through 8400 (the closing job-search-specific mobile media-query rules)
  — confirmed via grep, no job-search CSS classes appear outside that
  range. Delete that whole span as one cut.
- **`app/robots.js`** — remove `"/job-search", "/api/job-search"` from the
  `disallow` array; keep `/admin`, `/finance`, `/api/finance`, `/api/admin`.
- **`app/components/PublicWidgets.js`** — remove `"/job-search"` from the
  `PRIVATE_PREFIXES` array.
- **`next.config.mjs`** — two spots: the `pdf-parse`/`pdfjs-dist` webpack
  bundling workaround (check first whether anything non-job-search in this
  repo also parses PDFs before removing — if not, the whole workaround
  goes), and the `blob:` addition to the CSP's `style-src` that was added
  specifically for the live-CAPTCHA relay's frame viewer.
- **`docker-compose.yml`** — drop the `db:init:job-search` comment line and
  update the file's own top comment (currently "Local-only MySQL for
  analytics, the finance tracker, and the job-search dashboard") to drop
  the job-search mention.
- **`package.json`** — remove the `"db:init:job-search": "node scripts/init-job-search-db.mjs"`
  script entry. Also audit dependencies used ONLY by job-search once the
  code is gone (candidates to check, don't assume: `playwright`,
  `@google/genai`, `pdf-parse`, `web-push` — confirm none of these are
  used by finance/other features before removing them from
  `package.json`).
- **`.env.example`** — remove the ~37 `JOB_SEARCH_*`/`ADZUNA_*` lines (keep
  anything shared, like `DATABASE_URL`, if finance also reads it).
- **`README.md`** — remove the ~22 lines mentioning the job-search feature
  (its own section, plus any project-structure list entries).

## Explicitly NOT part of "code removal" — a separate decision

- **The `job_search_*` tables in the shared production MySQL** (same
  database instance finance uses, per `docker-compose.yml`'s own comment).
  Dropping tables is a distinct, more sensitive decision than deleting
  source files — data loss, not just code cleanup. Don't fold this into
  a "remove the code" pass without being asked explicitly; flag it and
  wait.
- **The `job-search-poll-worker`/`job-search-submit-worker` Railway
  services themselves** (as opposed to their deployments) — currently
  stopped and disconnected, not deleted. Deleting the services outright
  is a further, separate step past "turned off," and easy to do later
  (`railway service delete --service <name> --yes`) once code removal
  actually happens and there's no reason to keep the service shells around.

## Suggested order, when this actually happens

1. Delete the fully-exclusive files/directories first (no shared-file risk).
2. Edit the shared files one at a time, running `npm run build` after each
   to catch a broken import immediately rather than after all edits are
   made.
3. Re-run whatever this repo's own test/verification pattern is for
   finance (to confirm nothing job-search-adjacent was actually load-bearing
   for it) before considering the removal done.
4. Only after that: decide separately about dropping the `job_search_*`
   tables and deleting the two stopped Railway services.
