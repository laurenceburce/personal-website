# Job Search: submit-worker deployment (event-driven)

The submit-worker is an always-running server that the main app wakes up
immediately when there's new work (an approval, or a scoring pass with
auto-apply on) — purely event-driven, no periodic fallback check. This is
what needs to change on Railway to run it that way.

## What's in the repo

- `scripts/job-search-submit-worker-server.mjs` — the persistent server:
  `POST /run` (secret-protected) triggers a pass immediately, `GET /health`
  for liveness. Also runs one pass on startup.
- `Dockerfile.job-search-submit-worker` — `CMD` points at the server script.
- `app/lib/jobSearchSubmitTrigger.js` — the main app's side of this: a
  best-effort, fire-and-forget call to the submit-worker's `/run` endpoint.
  Wired into approve/batchApprove (Review Queue) and scoreNow (when
  auto-apply is on).

There's no fallback timer: if a trigger call is dropped or fails (misconfig,
network blip, this service mid-restart), an approved posting sits untouched
until the next trigger-worthy event (any pass sweeps up ALL approved
postings, not just the one that triggered it) or the next service restart.

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
   - Everything else the worker needs regardless of shape (DB connection
     vars, `JOB_SEARCH_PLAYWRIGHT_HEADLESS=true`, etc.) stays the same.

## Main app — new environment variables

- `JOB_SEARCH_SUBMIT_WORKER_URL` — the submit-worker's private-network
  address, e.g. `http://job-search-submit-worker.railway.internal:8080`
  (use whatever the service is actually named in your Railway project, and
  whatever port it's listening on if you changed it from the default).
- `JOB_SEARCH_SUBMIT_TRIGGER_SECRET` — the exact same value set on the
  submit-worker service above.

If either of these is left unset, `triggerSubmitWorker()` just silently
no-ops (see its own comment) — approving still works, but nothing will pick
the posting up until the submit-worker's next startup (there's no fallback
timer). Nothing breaks if you deploy the main app before the submit-worker
service is ready, or vice versa, but check the submit-worker's `/health` and
logs after a deploy of either service to make sure the trigger path is
actually wired up — see "Verifying it worked" below.

## Verifying it worked

- `GET` the submit-worker's `/health` endpoint (from within the Railway
  project — e.g. Railway's own shell/exec into another service, or
  temporarily attach a public domain just to check, then remove it) — should
  return `{"ok":true,"isRunning":false,...}` shortly after deploy (it runs
  once on startup).
- Approve a posting in Review Queue, then check the submit-worker service's
  logs — you should see `[run] Starting submit-worker pass (reason: approve)`
  within a couple seconds, not after a multi-minute wait.
