# DeployForge

A self-hosted deployment platform. A student connects a GitHub repository;
DeployForge works out how it should be built, builds it, stores the image, and
runs it behind its own URL. An administrator watches the machine they all
share and controls what each account may do.

Built for a class on one server, so quotas, per-app resource limits and
administrator control are part of the design rather than bolted on.

---

## What it does

```
GitHub repo ─> download ─> detect ─> build ─> registry ─> run ─> URL
               (tarball)   (read     (one of      (image    (container)
                            only)     three)      stored)
```

**Three build paths**, chosen from the files actually downloaded — never from a
stale detection row:

| What you picked | How it is built | What runs |
|---|---|---|
| A directory with `docker-compose.yml` | `docker compose up --build` | **every service in the file** |
| A directory with a `Dockerfile` | `docker build` | one container |
| A directory with neither | Cloud Native Buildpacks (`pack`) | one container |
| **Several directories** | each on its own terms, then composed | **all of them, wired together** |

Compose wins over a Dockerfile beside it: when a repository has both, the
compose file is the author saying "this app is these services together".

**Monorepos, together or apart.** A repository with `frontend/` and `backend/`
offers both. Tick one to deploy it alone; tick several and they become **one
deployment** — each directory built on its own terms, then run together on a
private network.

That last part is the point: a frontend is useless without the backend it
calls. Services in a stack reach each other by name, and the address is
injected for them:

```
frontend  ->  BACKEND_URL=http://backend:8080
backend   ->  FRONTEND_URL=http://frontend:8080
```

No hostname is hardcoded, and a variable you set yourself is never overwritten.
One service gets the public URL (a directory named `frontend`, `web`, `client`
… or the first you picked); the rest are reachable only from inside the stack.

**One target, one app.** A target that is already connected is marked in the
repository list and cannot be selected again — a monorepo's *other* directories
stay available.

### Apps and deployments

An **app** is a target a student connected. A **deployment** is one attempt to
build and run it. Rebuilding gives an app another deployment; it does not give
the student another app, and the dashboard counts apps.

Three things follow, and all three are what a student would assume anyway:

- **The URL belongs to the app.** It is derived from the app, not from a build
  of it, so a link that was shared still works after a redeploy. The database
  enforces that only one deployment is live on a hostname at a time.
- **A new deployment replaces the one before it** — but only once it has
  proved it can boot. The old container is stopped after the new one is
  healthy, never before, so a redeploy that fails to start leaves the working
  app up.
- **A failed redeploy does not take an app down.** While something is running,
  that is the app's state; the failure is in the history, where its log is.

- **The same build is never made twice.** Every successful build records a
  fingerprint of what went into it (commit, directory, build method, and for
  buildpacks the build-time environment and builder). Redeploying a commit
  that was already built with the same settings reuses that image and is
  ready in seconds; the deployment is marked *instant*. **Redeploy ▾ → Rebuild
  from scratch** builds anyway, for a `latest` base image or a package that
  moved. See `backend/app/builder/reuse.py`.
- **A finished build goes live by itself**, whether it was built on this
  server or in GitHub Actions — unless a newer build has overtaken it.
- **A release that crashes soon after going live is rolled back.** For
  `AUTO_ROLLBACK_WINDOW_SECONDS` (default 300) after a version goes live, the
  platform checks on its container every 10 seconds. If it stopped or is
  crash-looping, the previous version's image is started again and the
  crashed one is marked failed with its last output. A version started by a
  rollback is never itself rolled back. See `backend/app/runtime/guardian.py`.
- **Saving environment variables puts them into effect.** Each start records
  a hash of every value (never the value). After a save, the Environment tab
  asks what the change needs: nothing (the app is not running), a restart
  (done automatically, in seconds), or a redeploy (a `NEXT_PUBLIC_*`-style
  value was baked into a buildpack build — offered with one click). The tab
  always shows whether the running app has the saved values.
- **GitHub Actions builds show their steps.** The deployment page splits the
  build stage of the progress bar into the workflow run's own steps, and the
  app's banner names the step in progress.
- **A restart never loses a build.** Builds live on the Redis queue, not in a
  browser tab or a request: refreshing the page, closing it, or restarting the
  backend does not cancel one. A build whose server stopped mid-way is put
  back at the front of its lane within about 15 seconds (each worker keeps a
  short-lived "alive" key), its row says *queued* with an event explaining
  why, and it starts again by itself. Builds on GitHub Actions run on GitHub
  and report back whenever they finish. Every page re-reads state from the
  API on load, and logs replay from the start, so a reload shows exactly
  where things are.

Deleting an app removes its containers, its history and the connection, so the
repository can be connected again. Deleting one deployment removes only that
build from the history.

### Routing

Every app gets a hostname: `<repo>-<id6>.localhost`. Browsers resolve
any `*.localhost` name to the loopback address with no DNS or hosts entry,
which is what makes per-app URLs work on a laptop.

Traefik polls `GET /internal/traefik/config` and rebuilds its routing table
from the `deployments` table, so the database is the single source of truth: a
stopped app leaves the routing table within one poll, and no proxy config is
ever written to disk or reloaded by hand.

It also means the proxy needs **no access to the Docker socket** — socket access
is root-equivalent on the host, and granting it to an internet-facing process
to save writing one endpoint would be a poor trade.

### Isolation and control

Each container gets a memory cap, a CPU cap, a PID limit and
`--security-opt no-new-privileges`, and publishes no host port. A compose stack
runs on its own private network, and only its web service is additionally
attached to the shared edge network — one student's database is unreachable
from another student's app.

**`ports:` and `container_name:` are removed from a stack's compose file.** The
container port is kept as `expose:`. Publishing a port means claiming it on the machine everyone
shares: every Next.js compose file publishes 3000, so the second student to
deploy one gets `ports are not available`, and a published `5432` would put
their database on the host — exactly what the isolation above exists to
prevent. Nothing is lost: the router reaches a stack by container name over the
shared network, and services still reach each other by service name. The build
log says what was removed rather than rewriting a file silently.

`container_name:` is global to the Docker daemon, so two students deploying the
same repository would collide on it and the second would be told the name is
already in use for reasons entirely outside their control. Removing it also
makes the container's name predictable — but the name is read back from Docker
after the stack is up rather than assumed, because a name that turns out to be
wrong means the router points at a host that does not exist and a healthy app
is reported as having died on boot.

Administrators have three distinct levers, kept separate because they answer
different problems:

| Lever | Effect |
|---|---|
| **Quota** | how many apps this account may run at once (builds of one app count once) |
| **Block deploys** | account keeps working; cannot create, build or start anything |
| **Disable account** | cannot log in at all |
| **Suspend a project** | stopped, and the owner cannot start, delete or re-add it |

Suspension deliberately blocks deletion. Otherwise the owner could delete the
suspended deployment, reconnect the same repository, and have a clean one a
moment later.

---

## Requirements

- **Docker Desktop** (or Docker Engine) — required. Runs PostgreSQL, Redis,
  the registry, the router, and every deployed app.
- **Python 3.12+**, **Node.js 20+**
- **`pack` CLI 0.40+** — only for repositories with neither a Dockerfile nor a
  compose file. Everything else works without it.

---

## 1. Infrastructure

**On Windows, one command does sections 1, 3's migrations and 9:**

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\dev.ps1 up        # network, Postgres, Redis, registry, Traefik, migrations
powershell -ExecutionPolicy Bypass -File .\scripts\dev.ps1 backend   # frees port 8000 from a stale uvicorn, then runs it
powershell -ExecutionPolicy Bypass -File .\scripts\dev.ps1 frontend
powershell -ExecutionPolicy Bypass -File .\scripts\dev.ps1 status
```

`up` is safe to run any number of times: containers that exist are started,
not recreated (no more `container name ... is already in use`), and Traefik is
recreated only when its provider token differs from `TRAEFIK_PROVIDER_TOKEN`
in `backend/.env` — the cause of `403 Forbidden` on
`/internal/traefik/config`. `backend` stops only leftover `uvicorn app.main`
processes holding port 8000, which Windows reports as `WinError 10013`.

The manual steps follow. Five containers. Run these once; they restart with Docker afterwards.

```bash
docker network create deployforge_edge
```

```bash
docker run -d --name deployforge-db --restart unless-stopped -e POSTGRES_USER=deployforge -e POSTGRES_PASSWORD=deployforge -e POSTGRES_DB=deployforge -p 5433:5432 -v deployforge_pgdata:/var/lib/postgresql/data postgres:17
```

```bash
docker run -d --name deployforge-redis --restart unless-stopped -p 127.0.0.1:6379:6379 -v deployforge_redis:/data redis:7-alpine redis-server --appendonly yes --save ""
```

```bash
docker run -d --name deployforge-registry --restart unless-stopped -p 127.0.0.1:5000:5000 -v deployforge_registry:/var/lib/registry --network deployforge_edge registry:2
```

```bash
docker run -d --name deployforge-traefik --restart unless-stopped -p 80:80 -p 127.0.0.1:8090:8080 --network deployforge_edge traefik:v3.3 --api.dashboard=true --api.insecure=true --providers.http.endpoint="http://host.docker.internal:8000/internal/traefik/config?token=CHANGE_ME" --providers.http.pollInterval=5s --entrypoints.web.address=:80
```

The database is published on **5433**, not 5432, so it cannot collide with a
PostgreSQL already on the host. The token in the Traefik command must match
`TRAEFIK_PROVIDER_TOKEN` in `backend/.env`.

Traefik reaches the backend at `host.docker.internal`, which Docker Desktop
provides. On Linux, add `--add-host=host.docker.internal:host-gateway`.

Redis holds the build queue, rate limits, metrics and cached GitHub
responses. Nothing in it is the source of truth — the database is — but it is
persisted (`--appendonly yes`) so queued builds survive a restart.

Check all five are up:

```bash
docker ps --filter name=deployforge
```

## 2. Buildpacks (optional)

Only needed for repositories with no Dockerfile and no compose file.

```bash
winget install --id Buildpacks.pack --source winget
```

On macOS use `brew install buildpacks/tap/pack`; otherwise see
<https://buildpacks.io/docs/install-pack/>. Versions below 0.40 use a Docker API
modern daemons reject — check with `pack version`.

If `pack` is not on the server's `PATH`, set `PACK_BINARY` in `backend/.env` to
its full path.

## 3. Backend

```bash
cd backend && python -m venv .venv && .venv/Scripts/pip install -r requirements.txt
```

On Linux/macOS use `.venv/bin/pip` throughout.

## 4. Configuration

```bash
cd backend && cp .env.example .env
```

Generate the two secrets:

```bash
cd backend && .venv/Scripts/python -c "import secrets; from cryptography.fernet import Fernet; print('JWT_SECRET=' + secrets.token_hex(32)); print('TOKEN_ENCRYPTION_KEY=' + Fernet.generate_key().decode())"
```

Then edit `backend/.env` and set:

```
DATABASE_URL=postgresql+asyncpg://deployforge:deployforge@localhost:5433/deployforge
JWT_SECRET=<from above>
TOKEN_ENCRYPTION_KEY=<from above>
GITHUB_CLIENT_ID=<from step 5>
GITHUB_CLIENT_SECRET=<from step 5>
TRAEFIK_PROVIDER_TOKEN=<same value used in the Traefik command>
```

> **Never re-copy `.env.example` over a working `.env`.** It resets
> `DATABASE_URL` to port 5432, and replacing `TOKEN_ENCRYPTION_KEY` makes every
> stored GitHub token permanently undecryptable. Edit the lines you need.

Resource limits, quotas and the registry host all have working defaults — see
the comments in `.env.example`.

## 5. GitHub OAuth App

**GitHub → Settings → Developer settings → OAuth Apps → New OAuth App**

| Field | Value |
|---|---|
| Application name | `DeployForge (local)` |
| Homepage URL | `http://localhost:3000` |
| Authorization callback URL | `http://localhost:8000/github/callback` |

The callback must match `GITHUB_CALLBACK_URL` exactly — port **8000**, not
3000. Generate a client secret; it is shown once and can only be replaced,
never retrieved.

Students authorize this same app with their own GitHub accounts.

## 6. Database schema

```bash
cd backend && .venv/Scripts/alembic upgrade head
```

Re-run this after pulling changes; it is safe to run when already up to date.

## 7. Create the administrator

Signing up through the UI **always** creates a normal student account. This
script is the only way an administrator comes into existence:

```bash
cd backend && .venv/Scripts/python -m scripts.create_admin you@example.com
```

It prompts for a password without echoing it. To set one non-interactively:

```bash
cd backend && .venv/Scripts/python -m scripts.create_admin you@example.com --password "your-password"
```

Run against an existing account, it promotes that account to administrator
rather than failing.

## 8. Frontend

```bash
cd frontend && npm install && cp .env.example .env.local
```

## 9. Run

Two terminals.

```bash
cd backend && .venv/Scripts/uvicorn app.main:app --reload --port 8000
```

```bash
cd frontend && npm run dev
```

Open <http://localhost:3000>.

> `.env` changes need a backend **restart** — uvicorn's reloader only watches
> `.py` files, and settings are cached at import. On a synced folder (OneDrive,
> Dropbox) the reloader can miss `.py` changes too; restart by hand if an edit
> seems to have no effect.

## 10. Verify

- <http://localhost:8000/health> reports `"status":"ok"`, `"database":"ok"` and
  `"redis":"ok"`.
- Log in as the administrator → **Infrastructure**. Docker, Redis, Registry and
  Router should be operational; Buildpacks too if you did step 2.
- <http://localhost:8090> is the Traefik dashboard.

## 11. Tests

```bash
backend/.venv/Scripts/python -m pytest backend/tests/
```

Tests run against the real database inside transactions that roll back, so they
leave no rows behind. Redis is an in-process fake with Lua enabled, so the
queue's atomic scripts run exactly as in production. Docker, GitHub and the
Anthropic API are stubbed; nothing is built, run, fetched or paid for.

CI (`.github/workflows/ci.yml`) runs the same tests against a fresh
PostgreSQL, type-checks and lints the frontend, and builds both images on every
push to `main`.

---

## Running it on a server (Azure)

Steps 1–9 are for a laptop. On a server the whole platform — database, router,
API, console — is one `docker compose` project (`docker-compose.yml`), served
over HTTPS with certificates from Let's Encrypt:

| Host | What |
|---|---|
| `console.<DOMAIN>` | the dashboard |
| `api.<DOMAIN>` | the API |
| `<app>.<DOMAIN>` | each deployed app |

Without a domain of your own, [sslip.io](https://sslip.io) maps any name
containing an IP to that IP, so a server at `20.1.2.3` uses
`DOMAIN=20-1-2-3.sslip.io` and needs no DNS setup.

**1. Create the VM** (Azure CLI: `winget install Microsoft.AzureCLI`, then
`az login`):

```bash
infra/azure/provision.sh
```

This creates an Ubuntu VM with a static IP and ports 80 and 443 open, and
installs Docker on first boot. It prints the IP and the URLs. On an Azure for
Students subscription, if creation fails with `RequestDisallowedByPolicy` or
`SkuNotAvailable`, retry with another region:
`LOCATION=southindia infra/azure/provision.sh`.

**2. Create a second GitHub OAuth App** for the server. An OAuth App has one
callback URL, so the laptop's app cannot be reused. The callback URL is
`https://api.<DOMAIN>/github/callback`.

**3. Deploy:**

```bash
infra/deploy.sh <server-ip>
```

On the first run this asks for the OAuth App's ID and secret and an email for
Let's Encrypt, and generates every other secret on the server. It deploys the
committed `HEAD` (uncommitted changes are not shipped). Re-run it to ship new
commits; the server's `.env` is kept between runs.

**4. Create the administrator** — the deploy script prints the exact command.

To move to your own domain later, point `*.yourdomain` and `yourdomain` at the
VM's IP, change `DOMAIN` in `/opt/deployforge/.env` on the server, update the
OAuth App's callback URL, and re-run `infra/deploy.sh`.

### Builds run in GitHub Actions

On the server (`BUILD_BACKEND=actions`, set by `docker-compose.yml`) nothing
is built on the VM. Each app is built in its own repository's GitHub Actions,
and the server only pulls and runs the result:

```
Deploy button ─> DeployForge commits .github/workflows/deployforge-<id>.yml
                 to the repo (first time only) and starts it
git push ──────> the same workflow starts by itself
                        │
                GitHub Actions, in the student's repository
                  build: compose file / Dockerfile / buildpacks
                  push:  ghcr.io/<student>/<repo>/...:<commit>
                  report the result and the log ──> DeployForge
                        │
                DeployForge pulls the image, stores it in its own registry
                (versioned by commit), deletes GitHub's copy, and replaces
                the running app with the stored version
```

- **Every push to the connected branch redeploys the app.** Pushes to other
  branches are ignored, and in a monorepo only changes under the app's own
  directory trigger it. Deleting the workflow file turns this off.
- **Nothing secret is stored in the student's repository.** Each run proves
  which repository it is in with a GitHub-signed OIDC token, and the server
  only accepts results for apps connected from that repository. The app's
  environment variables are handed to the run when it starts, masked in its
  log, and removed from the log copy the server keeps.
- **Every version is kept here.** The run pushes to the student's GitHub
  container registry — the one registry a workflow can push to with no secret
  in the repository — and the server then copies the image into its own
  registry (`localhost:5000/deployforge/<owner>/<repo>/<target>:<commit>`)
  and runs it from there. Rollback therefore never depends on GitHub, and the
  server does not pull from the internet to start a version.
- **GitHub's copy is cleared.** Private packages count against a free GitHub
  account's storage, so once the copy is stored the server deletes the
  version it came from — only images the app's own builds pushed, and only
  when the student granted `delete:packages`. Without that scope the copy is
  left and the build log says how to allow cleanup. If copying fails for any
  reason, the app simply runs from GitHub's copy instead.
- The student's workflow file is a few lines that call
  `.github/workflows/deployforge-build.yml` **in this repository**, which
  must therefore be public and have that file on `main` (`CI_WORKFLOW`
  changes where it points).

Students connect GitHub with four permissions: `repo`, `workflow` (to add the
workflow file), `read:packages` (to pull their images) and `delete:packages`
(to clear them from GitHub once stored). Anyone who connected
before builds moved to Actions sees a **Reconnect GitHub** button under
**Deploy new**.

On a laptop the default stays `BUILD_BACKEND=local`, and GitHub cannot reach
`localhost` — so neither GitHub Actions builds nor push deploys work until the
laptop has a public address. **One** ngrok tunnel (a free static domain) is
enough, because the console forwards `/backend/*` to the API
(`frontend/next.config.ts`):

| Through `https://<NGROK_DOMAIN>` | Goes to |
|---|---|
| `/` | the console (port 3000), for showing the demo on any device |
| `/backend/webhooks/github?app=<id>` | GitHub push webhooks |
| `/backend/ci/runs…` | GitHub Actions asking what to build and reporting back |

```powershell
# backend/.env: NGROK_DOMAIN=<your static domain>   (once)
powershell -ExecutionPolicy Bypass -File .\scripts\dev.ps1 tunnel actions   # or "local"; keep it open
powershell -ExecutionPolicy Bypass -File .\scripts\dev.ps1 backend          # restart the API
```

`tunnel` writes `PUBLIC_API_URL=https://<domain>/backend`, generates
`GITHUB_WEBHOOK_SECRET` the first time, optionally sets `BUILD_BACKEND`, and
runs `ngrok http 3000 --url=<domain>`. When the API starts it gives every app
with push deploys on a GitHub webhook pointing at that address (re-pointing
existing ones, so a changed address never leaves dead hooks), signed with the
secret. `POST /admin/webhooks/sync` does the same on demand.

A push then deploys, whichever backend builds:

- **local** — the webhook queues a build on the laptop; it goes live when done.
- **actions** — the first push (or Redeploy) commits the DeployForge workflow
  to the repository and runs it; after that the workflow itself runs on each
  push and the webhook stands aside, so nothing is built twice.

A push to another branch, to another app's folder in a monorepo, with push
deploys turned off, or that only changes the workflow file does not deploy —
the reason is in the webhook's **Recent deliveries** on GitHub.

While the tunnel is open the API is reachable from the internet. Every route
still needs a login, webhook deliveries need the HMAC signature, the router's
endpoint needs its token, and build callbacks need a GitHub-signed token for
the app's own repository. GitHub sign-in still returns to the OAuth app's
callback URL (`localhost:3000`), so sign in on the laptop.

---

## Using it

### As a student

Sign up → **New app** → **Connect GitHub** → pick a repository → tick what
inside it to deploy (optionally paste a `.env`) → **Deploy**.

The sidebar has **Overview** (live apps, build health, recent activity),
**Apps**, **Deployments** (every build across every app), **Activity**,
**Usage & limits** and **Settings**. `Ctrl K` jumps to any page or app by
typing part of its name.

Each app has eight tabs:

| Tab | What it is for |
|---|---|
| **Overview** | Uptime, response time, CPU and memory now; the production deployment; build health; recent deployments with one-click rollback |
| **Code** | The repository the way GitHub shows it — file tree, highlighted files, READMEs, commit history, every branch. Press `t` to jump to a file |
| **Deployments** | Every build. **Changes** shows the commits and diff since the previous one; **Roll back** runs an earlier version's image again in seconds |
| **Logs** | Runtime and build logs, streamed live, with filtering, wrapping and download |
| **Metrics** | CPU, memory, response time and network over 1h / 6h / 24h |
| **Activity** | Everything that happened to the app, including anything an administrator did |
| **Environment** | Variables, encrypted at rest and injected at build and run time |
| **Settings** | The branch it deploys from, push deploys on or off, its address and HTTPS state, delete |

A redeploy keeps the app's address: the hostname belongs to the app, not to
a build of it. The new version replaces the old one only once it has started
cleanly, so a broken redeploy never takes a working app down.

The build runs in the background and its log streams on the deployment page.
The first buildpack build on a machine downloads a large builder image, so it
takes a while; Dockerfile and Compose builds have no such cost.

Two logs are kept apart on purpose:

- the **build log** says why no image could be produced. Recognised failures
  are explained in plain words on the deployment itself — "change `next build
  --turbopack` to `next build`" rather than "exit status 1";
- the **runtime log** says why the app that was built will not stay up. For a
  compose stack it covers every service, because the reason the web service is
  failing is usually printed by the database next to it.

Both are read the same way: a container that dies on boot has its output
matched against known failures, so an unreachable database or a rejected
password is named as such instead of "exit code 1". An unrecognized crash keeps
the raw detail — a confident wrong explanation would be worse than none.

**Explain with AI.** With `ANTHROPIC_API_KEY` set, a failed deployment offers
*Explain this failure*: Claude reads the end of the log with what the platform
knows about the app and returns the cause, the fix, and how confident it is.
It runs only when asked (each call costs money), the answer is stored so
asking twice is free, and it is rate limited per account.

Environment variables are encrypted at rest and injected at build and run time.
Restart the app for changes to take effect.

### As an administrator

Administrators do not deploy. Their navigation has no GitHub connection and no
deploy flow at all:

- **Overview** — service health, machine CPU and memory over time, build
  success, the queue, and what is failing or suspended right now.
- **Apps** — every student's app with live usage. Start, stop and restart
  from the list; open one for the same tabs its owner has (minus the code and
  environment) plus **Redeploy**, **Roll back**, **Suspend** and **Resume**.
- **Students** — every account: quota, deploy rights, enable/disable. Each
  has a page with their apps, usage, activity and every admin action on them.
- **Build queue** — the fair scheduler made visible: build slots, each
  student's lane, the exact order builds will run in, retries backing off.
  **Builds at once** is adjustable here (− / +, up to `BUILD_CONCURRENCY_MAX`,
  default 8). It takes effect within seconds without a restart and survives
  one; lowering it lets running builds finish. `BUILD_CONCURRENCY` is only
  the starting value. About one build per two CPU cores keeps each build fast.
- **Infrastructure** — service checks, load over time, every container with
  live usage and the app and student it belongs to, Docker's disk use.
- **Audit log** — every administrator action, who took it and on whose app.

An administrator's start bypasses the student's quota and deploy block (they
set those), but not a suspension — lifting that is a separate, recorded act.

---

## Layout

```
backend/
  app/
    api/          route handlers: apps, deployments, admin, admin operations
    auth/         JWT issuing, hashing, dependencies
    builder/      docker build, buildpacks, compose, the build trigger, AI diagnosis
    ci/           GitHub Actions builds: the workflow file, run identity, callbacks
    core/         Redis client, GCRA rate limiting, errors, encryption
    detection/    pure repository analysis — no network, no database
    github/       OAuth, API client, tarball download, the cached code browser
    metrics/      sampler, Redis-stream time series, LTTB downsampling
    models/       SQLAlchemy tables, including the audit log
    queue/        the fair build queue: Lua scripts, workers, fairness maths
    runtime/      container lifecycle, naming, ports, log streams, image mirroring
    services/     app views and auditing shared by student and admin routes
    worker.py     run the queue's workers as their own process
frontend/
  app/(console)/  every signed-in page; the layout resolves the session once
  components/     design system (ui.tsx), charts, log viewer, code browser,
                  app screens shared by student and admin (components/app)
  lib/            typed API client, the owner/admin app adapters, fuzzy search
```

### Notes for whoever works on this next

- **Reconciliation at startup.** Deployment rows outlive the process that wrote
  them. On boot the API checks every supposedly-running deployment against
  Docker and corrects the ones that are not, so the dashboard never claims an
  app is up when it is not. The same sweep fails builds that were in flight
  when the process stopped — otherwise a restart mid-build leaves a row stuck
  on `building` for ever, with no way to retry it.
- **One live deployment per hostname, enforced by the database.** A partial
  unique index (`uq_deployments_live_subdomain`) covers only rows that are
  running. An app's builds all share its hostname, so an outright UNIQUE
  constraint would reject the second one; what must never happen is two of them
  serving that name at once, and that is what the index says.
- **The build queue is fair, durable and atomic.** One FIFO per student and a
  ring of students with work; a worker takes one job from the head of the ring
  and moves that student to the back (round-robin, i.e. deficit round-robin
  with a quantum of one). A student's wait is bounded by the number of
  *students* ahead, not jobs. Every state change is a single Lua script, so
  two workers can never take one job. Workers hold a lease and renew it on a
  heartbeat; a lapsed lease puts the job back at the front of its lane.
  Only transient failures (network, GitHub 5xx, Docker not answering) are
  retried, with exponential backoff and full jitter. Queue position is
  computed in O(students) from the ring, and tested against a brute-force
  simulation over random queues. See `queue/fairness.py`.
- **Rate limits use GCRA**: one timestamp per account, checked and updated in
  one Lua call, so it is exact across several API processes. It fails open —
  refusing everyone because the limiter's store is down protects nobody.
- **Metrics live in Redis streams.** A stream id is the millisecond it was
  written, so a stream is already a time-ordered log with range queries by
  time and trimming by length. Charts are downsampled with LTTB, which keeps
  the spikes that averaging would flatten.
- **The code browser caches by content.** Trees and blobs at a commit SHA never
  change, so they are cached for a week; only "which commit is `main` now?"
  goes to GitHub, and that is held for 30 seconds.
- **Suspension applies to the app, not one deployment.** It is stored on the
  deployment an administrator stopped, but every start and build checks the
  whole app — otherwise redeploying would produce a fresh, unsuspended row.
- **Logs stream over SSE read with `fetch`**, not `EventSource`, because
  `EventSource` cannot send the Authorization header and a token in the URL
  would land in every access log.
- **The routing table is never returned empty.** Traefik keeps its previous
  configuration when handed an empty one, so a sentinel route is always
  included. Without it, stopping the last running app leaves its URL pointing
  at a dead container. See `api/internal_routes.py`.
- **External commands run on a worker thread**, not through
  `asyncio.create_subprocess_exec`, which raises `NotImplementedError` on a
  Windows Selector event loop — the loop a server may well be running on.
- **`eager_defaults` is on** for every model. Without it `updated_at` is left
  expired after an UPDATE and reading it while building a response emits SQL
  with no greenlet context.
- **Detection never executes anything.** It reads and parses files. Building
  does run the project's own tooling — inherent to building source — which is
  why builds have a hard timeout and are killed as a process tree.
