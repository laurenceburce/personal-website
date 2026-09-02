# Job Search: submit-worker deployment (event-driven)

The submit-worker is an always-running server that the app or poll worker
wakes up immediately when there's new work (an approval, or a scoring pass
with auto-apply on) — event-driven, with capped follow-up passes to drain
normal backlogs. This is what needs to change on Railway to run it that way.

## What's in the repo

- `scripts/job-search-submit-worker-server.mjs` — the persistent server:
  `POST /run` (secret-protected) triggers a pass immediately, `GET /health`
  for liveness. Also runs one pass on startup.
- `Dockerfile.job-search-submit-worker` — `CMD` points at the server script.
- `app/lib/jobSearchSubmitTrigger.js` — the main app's side of this: a
  best-effort, fire-and-forget call to the submit-worker's `/run` endpoint.
  Wired into approve/batchApprove (Review Queue), scoreNow (when auto-apply
  is on), and the poll worker after its scoring pass.

There's no standalone fallback timer inside the submit-worker: if a trigger
call is dropped or fails (misconfig, network blip, this service mid-restart),
an approved posting sits untouched until the next trigger-worthy event (any
pass sweeps up approved and auto-apply-eligible postings, not just the one
that triggered it) or the next service restart.

## Submit-worker service — Railway dashboard changes

1. **Start Command**: no change needed if you're already using
   `RAILWAY_DOCKERFILE_PATH=Dockerfile.job-search-submit-worker` (the
   Dockerfile's own `CMD` now runs the server). If the service was somehow
   configured with an explicit Start Command override instead of relying on
   the Dockerfile's `CMD`, update it to `node scripts/job-search-submit-worker-server.mjs`.
2. **Remove the Cron Schedule** on this service (Settings → Cron Schedule) —
   the server stays running continuously now; a cron schedule would restart
   it repeatedly instead of letting it serve requests.
3. **Networking**: do NOT attach a public domain to this service. It only
   needs to be reachable from the main app over Railway's private network
   (`<service-name>.railway.internal`). Confirm private networking is enabled
   for the project (it is by default for services in the same environment).
4. **New environment variables** on this service:
   - `JOB_SEARCH_SUBMIT_TRIGGER_SECRET` — a random secret string. Must match
     the same value set on the main app (below). Defense in depth on top of
     private networking already not being internet-reachable.
   - `JOB_SEARCH_SUBMIT_WORKER_PORT` — optional, defaults to `8080` (already
     set in the Dockerfile). Only change this if `8080` conflicts with
     something else on the service.
   - For automatic security-code entry, set the Gmail lookup variables below
     on this submit-worker service too. The worker process reads the inbox
     itself when it hits an emailed-code prompt.
   - Everything else the worker needs regardless of shape (DB connection
     vars, `JOB_SEARCH_PLAYWRIGHT_HEADLESS=true`, etc.) stays the same.

## Main app — new environment variables

- `JOB_SEARCH_SUBMIT_WORKER_URL` — the submit-worker's private-network
  address, e.g. `http://job-search-submit-worker.railway.internal:8080`
  (use whatever the service is actually named in your Railway project, and
  whatever port it's listening on if you changed it from the default).
- `JOB_SEARCH_SUBMIT_TRIGGER_SECRET` — the exact same value set on the
  submit-worker service above.
- `JOB_SEARCH_EMAIL_PROVIDER=gmail` — enables Gmail lookup for held
  security-code prompts. This defaults to Gmail because it is the only
  supported provider today, but setting it explicitly is clearer.
- Connect Gmail from Job Search -> User Settings to store an encrypted refresh
  token in the job-search DB. The web app and submit-worker service must share
  the same DB and `AUTH_SECRET`/`JOB_SEARCH_TOKEN_SECRET`.
- `JOB_SEARCH_GMAIL_REFRESH_TOKEN` — optional deployment-level Gmail OAuth
  refresh token with `https://www.googleapis.com/auth/gmail.readonly`. If set,
  it overrides the DB-stored connection.
- `JOB_SEARCH_GMAIL_CLIENT_ID` / `JOB_SEARCH_GMAIL_CLIENT_SECRET` — optional
  when `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` already belong to the
  Gmail-enabled OAuth client.
- `JOB_SEARCH_TOKEN_SECRET` — optional when `AUTH_SECRET` is already shared
  by the web app and submit-worker service; used to encrypt/decrypt the
  DB-stored Gmail refresh token.
- `JOB_SEARCH_AUTO_EMAIL_SECURITY_CODE` — optional, defaults to `true`; set
  `false` to require dashboard-entered security codes.
- `JOB_SEARCH_AUTO_EMAIL_SECURITY_CODE_WAIT_MS` — optional, defaults to the
  same value as `JOB_SEARCH_SECURITY_CODE_WAIT_MS`.
- `JOB_SEARCH_AUTO_EMAIL_SECURITY_CODE_POLL_MS` — optional, defaults to
  `5000`.
- `JOB_SEARCH_EMAIL_LOOKBACK_MINUTES` — optional, defaults to `30`, capped at
  `60`.
- `JOB_SEARCH_EMAIL_MAX_RESULTS` — optional, defaults to `30`, capped at
  `100`.
- `JOB_SEARCH_EMAIL_PRE_CHALLENGE_GRACE_MS` — optional, defaults to `30000`;
  email lookup ignores code messages older than the challenge by more than
  this window, which prevents rapid same-company Greenhouse retries from
  reusing the previous code.
- `JOB_SEARCH_EMAIL_LATEST_MESSAGE_WINDOW_MS` — optional, defaults to `90000`;
  when multiple code emails match, the newest message in this window wins.
- `JOB_SEARCH_GMAIL_LABEL_IDS` — optional, defaults to `INBOX`; use `*` to
  search recent mail across labels.
- `JOB_SEARCH_EMAIL_SEARCH_QUERY` — optional extra Gmail search filter, such
  as `from:no-reply@example.com`.

If either submit-worker trigger variable is left unset,
`triggerSubmitWorker()` just silently no-ops (see its own comment) —
approving still works, but nothing will pick the posting up until the
submit-worker's next startup (there's no fallback timer). Nothing breaks if
you deploy the main app before the submit-worker service is ready, or vice
versa, but check the submit-worker's `/health` and logs after a deploy of
either service to make sure the trigger path is actually wired up — see
"Verifying it worked" below.

## Verifying it worked

- `GET` the submit-worker's `/health` endpoint (from within the Railway
  project — e.g. Railway's own shell/exec into another service, or
  temporarily attach a public domain just to check, then remove it) — should
  return `{"ok":true,"isRunning":false,...}` shortly after deploy (it runs
  once on startup).
- Approve a posting in Review Queue, then check the submit-worker service's
  logs — you should see `[run] Starting submit-worker pass (reason: approve)`
  within a couple seconds, not after a multi-minute wait.
