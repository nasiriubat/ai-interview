# Deploying to a single VPS

For one person, once, on a fresh EU virtual machine with a domain already pointing at it. It
covers a pilot: real employee interview data, one host, unattended between check-ins. It does not
cover a multi-host production estate — see [What this deliberately does not
cover](#what-this-deliberately-does-not-cover).

For local development read [RUNNING.md](RUNNING.md) instead. The two stacks are separate files on
purpose: `docker-compose.yml` publishes Postgres on 5432 and runs a mail catcher, and a compose
overlay can neither unpublish a port nor delete a service, so production gets its own file that
can be read top to bottom and believed.

## What you end up with

```
        internet
           │  :80 → :443 (redirect), :443
    ┌──────▼──────┐
    │    caddy    │  the only container that publishes a port
    └──────┬──────┘  TLS from Let's Encrypt, renewed automatically
           │ http
    ┌──────▼──────┐
    │     web     │  Next.js; holds the session cookie
    └──────┬──────┘
           │ http, internal network only
    ┌──────▼──────┐        ┌────────┐
    │     api     │        │ worker │  pg-boss consumers
    └──────┬──────┘        └───┬────┘
           │  as app_api       │  as app_api
    ┌──────▼───────────────────▼────┐   ┌────────┐
    │           postgres            │◀──│ backup │ nightly pg_dump + uploads
    └───────────────────────────────┘   └────────┘
                  uploads volume ───────────┘  (audio and attached documents)
```

Two more services keep watch from outside the application, described under
[Operating it](#operating-it): `backup` encrypts, verifies and reports, and `ops-notify` delivers
alerts when the application cannot.

Images, all tagged with the git SHA they were built from (so the previous version stays on the host
and a rollback needs no build): `aidp-server` runs `migrate`, `api` and `worker`; `aidp-web` runs
`web`; `aidp-backup` (the server's Postgres plus `age`, `rclone` and `jq`) runs `backup`;
`aidp-ops-notify` (a shell script on Alpine) runs `ops-notify` and the `ops-state-init` one-shot.
The stock `pgvector/pgvector:pg16` runs `postgres` and the two database helpers (`db-grants`,
`preflight`); `caddy:2-alpine` runs Caddy; `yuzutech/kroki` and `yuzutech/kroki-mermaid` run the diagram
renderer ([PDF export and diagrams](#pdf-export-and-diagrams)). Eight images for thirteen services.

**The API is not on the internet.** The browser never calls it: every request goes to a Next.js
route handler (`apps/web/src/app/api/**`), which attaches the bearer token server-side
(`apps/web/src/lib/api/proxy.ts`) and streams the response back, SSE included. Publishing the API
on its own hostname would add a second internet-facing origin to CORS-configure and rate-limit,
and would put tokens in the browser, for no capability the product uses. So the web app's
`API_URL` is `http://api:4000` — a name on the compose network — and nothing else resolves it.

## Prerequisites

- A VPS in the EU (NFR-02). 2 vCPU, 4 GB RAM, 40 GB disk is the floor, and 4 GB needs the 4 GB
  preset: the limits in `deploy/compose.prod.yml` are the 8 GB ones (their sum is about 7.5 GB, most
  of it headroom for the on-host Whisper model), and `generate-env.sh <host> <email> --size 4gb`
  writes limits that fit. What the stack really uses is in [Capacity and load](#capacity-and-load).
  Postgres and the two Node services are the memory-hungry parts.
- Docker Engine 24+ with the Compose plugin. `docker compose version` must work.
- A DNS `A` record (and `AAAA` if the host has IPv6) for your hostname pointing at the VPS, already
  resolving. Caddy cannot get a certificate before this is true.
- Inbound TCP 80 and 443 open. Port 80 is not optional — ACME's HTTP challenge uses it, and it is
  what redirects visitors to HTTPS.
- An SMTP relay you can send from. Sign-in is a magic link; without a relay nobody can log in.
- Git, to clone the repository onto the host. The images are built on the VPS from the checkout.
  A 4 GB host building on top of the running stack is the likeliest way to run it out of memory:
  `upgrade.sh` refuses below 3 GB of free disk, and the quiet hour is the time to run it.
- Outbound HTTPS from the build host, once per build: the web build downloads the Inter font from
  Google Fonts and serves it from your own origin afterwards, so a build host with no egress fails
  at `next build`. The running site never contacts Google.

## First deployment

Production configuration is `deploy/.env` and only that file: it is generated, every variable is
named in `deploy/compose.prod.yml`, and a missing one stops the stack. The root `.env` described in
[RUNNING.md](RUNNING.md#configuration) is the development file and is never read here.

Run these as a user in the `docker` group, from the repository root.

```bash
git clone <your-remote> ai-interview && cd ai-interview

# 1. Secrets and settings. Writes deploy/.env, mode 600, including a backup encryption key pair
#    (when age-keygen is on this machine; upgrade.sh makes it otherwise). Refuses to overwrite.
./deploy/generate-env.sh pilot.example.com ops@example.com

# 2. Fill in what it cannot invent. Sign-in is broken until EMAIL_SMTP_URL points at a real relay,
#    and a failure reaches nobody until ALERT_EMAIL or ALERT_WEBHOOK_URL is set. (And if you have
#    an ANTHROPIC_API_KEY or OPENROUTER_API_KEY, add it now so first boot seeds a provider with
#    default routes; you can also do it in the admin UI later.)
$EDITOR deploy/.env

# 3. COPY deploy/.env TO YOUR PASSWORD MANAGER NOW. It holds the keys to the database, to the
#    stored provider keys and to every backup. It is not in the repository and not in the volumes.

# 4. Build, migrate, start, and check. The images are tagged with the git SHA; the backup image
#    and the key pair come first; the checks at the end are the ones in the list below.
./deploy/upgrade.sh

# 5. Watch it. Every service should be (healthy); `deploy/dc` is `docker compose` for this stack.
./deploy/dc ps
```

What step 4 proves, and what to look for if it stops: `preflight` printing exactly

```
preflight: ok — connected as app_api, no bypass, 29 tables under RLS, CREATE on database, untenanted reads return nothing
```

(`./deploy/dc logs preflight db-grants`; the count is whatever the schema has, and the stack does
not start if the check fails), and `migrate` ending with the bootstrap line naming your operator,
tenant and admin (`./deploy/dc logs migrate | tail -3`):

```
bootstrap: operator ops@example.com, tenant "First tenant" admin ops@example.com, templates 2, ...
```

Now open `https://pilot.example.com/auth/signin`, enter the operator address, and follow the magic
link from your inbox. Nothing will run an interview until `interview_turn` has a model route —
add a provider and set routes in the admin UI (see RUNNING.md, "Provider configuration").

Because the commands are long, the rest of this document uses:

```bash
alias dc='./deploy/dc'
```

`deploy/dc` supplies the compose file, `deploy/.env` and `deploy/versions.env` (the image tag
`upgrade.sh` recorded). Run through it, and never `docker compose up` by hand.

An install made before the images were versioned has volumes named `deploy_pgdata` and so on; it
must put `COMPOSE_PROJECT_NAME=deploy` in `deploy/.env`, and `upgrade.sh` refuses to continue
without it rather than start on an empty database.

## How the first admin signs in

Mailpit is a development tool (`docker-compose.yml`, mail on `:8025`); it is not in the production
stack and never receives anything there. In production the first admin signs in like this:

1. **The relay is set at deploy time, not in the admin.** `EMAIL_SMTP_URL` in `deploy/.env` is the
   address of a real mail server (`smtp://user:password@smtp.provider.com:587`, or `smtps://` for
   port 465; percent-encode `@`, `:` and `/` inside the user name or password). `compose.prod.yml`
   refuses to start without it, so the mistake shows at `./deploy/dc up`, not as a silent page.
   `EMAIL_FROM` is the sender. The web app takes the same value as `EMAIL_SERVER`.
2. **The first admin is `BOOTSTRAP_ADMIN_EMAIL`.** `generate-env.sh <host> <admin-email>` writes it.
   The `migrate` step creates the tenant and that user, and `/auth/signin` mails a one-time link to
   exactly that address.
3. **Google sign-in is the alternative.** Set `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET` in
   `deploy/.env` and the sign-in page offers "Continue with Google" beside the email link. Google
   does not need the relay to sign in, but invitations and reports still do, and
   `compose.prod.yml` still requires `EMAIL_SMTP_URL`.
4. **Afterwards, tenant admins configure their own mail** in Settings, Email: mail server host,
   port, security, user name and password, sender and reply-to, with a "Send test email" that
   tries the form before it is saved. That relay is used for what the tenant sends (invitations,
   reports, notices). It does **not** replace the deployment relay for sign-in links, which are sent
   by the web app from `EMAIL_SERVER` alone; keep `EMAIL_SMTP_URL` working.

When the relay is wrong, the sign-in page does not pretend: Auth.js reports `EmailSignin` and
`/auth/error` says that the sign-in email could not be sent and names `EMAIL_SMTP_URL`
(English and Finnish). If `EMAIL_SMTP_URL` is empty the stack does not start, and a production
web process without `EMAIL_SERVER` throws on start instead of falling back to a development relay.
In Settings, Email, "Send test email" with no relay anywhere answers "No mail server is
configured" rather than reporting a send that only went to the log.

### Break glass: a sign-in link from the server's shell

If the relay is wrong on a fresh install, or breaks later while every admin is signed out, nobody
can receive a sign-in email. Whoever has a shell on the server can mint the link instead:

```bash
deploy/signin-link.sh admin@example.com
# the same thing, by hand:
deploy/dc exec -T api node apps/api/dist/cli/signin-link.js admin@example.com
```

It prints one URL on stdout, `https://<PUBLIC_HOSTNAME>/api/auth/callback/nodemailer?...`. Open it in
the browser that should be signed in. The link:

- is for an **existing** staff user only (the platform operator, or a tenant admin or member). An
  unknown address, a disabled user and a user of a suspended organization are refused (exit status 1);
  nothing is created, so it cannot add a user or re-enable one;
- is made exactly the way the email sign-in makes it: a random token, stored only as its hash with
  `AUTH_SECRET` in the same table, consumed by the same callback, so it works **once**;
- is valid for **15 minutes**, not the 24 hours of an emailed link, because it is read off a screen;
- is recorded: an audit row `auth.signin_link_issued` in the user's organization, actor `cli`,
  target the user, with the expiry and never the token, plus a warning line on stderr.

This adds no privilege. A shell on the server already reads `deploy/.env`, which holds
`AUTH_SECRET` and the database password; the command only spares that person from forging a token
by hand. It prints nothing secret except the link itself, so do not paste its output into a ticket.

It is a way back in, not a way to run without mail. Production still needs a working relay in
`EMAIL_SMTP_URL`: invitations, reports, alerts and everybody else's sign-in go through it. Any SMTP
service that gives you a host, port and credentials will do, a transactional email provider, the
SMTP submission service of the mailbox provider your organization already uses, or your own mail
server; use port 587 with STARTTLS or 465 with TLS, and a sender address on a domain whose SPF and
DKIM records allow that relay, or the mail lands in spam. Once you are in, fix `EMAIL_SMTP_URL` in
`deploy/.env`, run `./deploy/dc up -d`, and send yourself a test from Settings, Email.
[OPERATIONS.md](OPERATIONS.md#locked-out--email-not-working) has the checklist.

## Model configuration, and the one route that is easy to miss

The platform routes each _purpose_ to a model independently, so a cheap model can drive the
conversation while a stronger one writes the report. The purposes are `interview_turn`,
`resume_summary`, `extraction`, `clustering`, `analysis_report`, `spec_turn`, `issue_detection`,
`spec_generation`, `transcription`, `stt_stream`, `tts`, `realtime_voice`, `file_ingest`,
`vision_ingest` and `embedding` (`packages/shared/src/purposes.ts` is the list). Admin → Providers
adds a provider and imports its model list from the provider's own API; Admin → Routing binds
purposes to models; Admin → Settings holds the defaults.

Every call to a provider has a deadline and a bounded number of retries, so a provider that goes
quiet fails the turn after two minutes at most instead of hanging it. The limits are
`PROVIDER_*` variables in `deploy/.env`; [OPERATIONS.md](OPERATIONS.md#provider-timeouts-and-retries)
has the table.

`interview_turn` is the one that blocks everything: with no route, no interview can start.

`embedding` is the one that fails quietly. Analysis clusters findings by semantic similarity, and
with no embedding route it falls back to lexical overlap — the run succeeds, the report is
produced, and the clusters are simply worse, grouping on shared words rather than shared meaning.
The pipeline records which path it took, so check it after your first analysis.

**Recorded voice answers work with no key at all (D-75).** Bootstrap always adds a platform
provider called "On this server (Whisper)", of kind `local`, and routes `transcription` to it
unless something else already has that route. The API runs Whisper on its own CPU, so the audio
never leaves the VPS and transcription costs nothing; the ledger still records each call, at zero.

- **First transcription downloads the model.** whisper-small at q8 is about 250 MB, fetched from
  Hugging Face into the `models` volume (`MODEL_CACHE_DIR=/models`). The API starts that download
  in the background as soon as it boots, so normally nobody waits for it. Watch it with
  `curl -s https://<domain>/api/v1/health/ready`: `speech.state` goes `downloading` (with
  `progress`) → `ready`. It never makes readiness fail. Offline at boot? The API starts anyway,
  logs `local speech: model did not load`, and the next recording tries again. After the first
  download the server needs no network for it.
- **Memory.** The API process holds the model on a worker thread: measured at about 0.9 GB resident
  once loaded and 1.6–2.0 GB while transcribing. It is released after
  `SPEECH_MODEL_IDLE_MINUTES` (default 10) without a recording and reloaded from the volume in
  about a second when the next one arrives, so an idle server does not hold it; set it to `0` to
  keep the model loaded permanently. Give the `api` service at least 2.5 GB; on a
  4 GB VPS that is fine alongside Postgres and the web app, on a 2 GB VPS it is not — route
  transcription to OpenAI instead (below) and the model is never loaded.
- **CPU.** One recording at a time, queued. A 10-second answer takes about a second on a laptop
  core and a few seconds on a 2-vCPU VPS. A recording that waits more than two minutes to start
  (a backlog, or the first download still running) gets a "try again in a minute", and its audio
  is kept.
- **Choosing the model** is the route's model field in Admin → Routing: `onnx-community/whisper-small`
  (default, good Finnish), `onnx-community/whisper-base` (faster, 80 MB, weaker Finnish) or
  `onnx-community/whisper-large-v3-turbo` (best, about 1.1 GB and 4+ GB of RAM). Only these three
  run; anything else is refused, so a tenant's route cannot make the server download arbitrary
  models. One model is held at a time.
- **Switching to OpenAI.** Point the `transcription` route at an OpenAI provider (whisper-1) in
  Admin → Routing, platform-wide or per tenant. The local provider stays in the list to switch back.

**Neither Anthropic nor OpenRouter can speak or embed.** Anthropic has no audio or embedding
endpoints, and OpenRouter proxies chat models only. Without a third key you get interviews that
work, recorded answers transcribed on the server, clustering that falls back to word overlap, and
no spoken interviewer.

Setting `OPENAI_API_KEY` in `deploy/.env` closes all three at once: first boot adds a platform
OpenAI provider and routes `transcription`, `stt_stream`, `tts` and `embedding` to it, leaving every
conversation purpose on whichever provider you chose. Transcription then goes to OpenAI rather
than the local model; the local provider is still created, so you can switch back.

| Purpose         | Default model            | What it turns on                          |
| --------------- | ------------------------ | ----------------------------------------- |
| `transcription` | `whisper-1`              | Voice answers, and live voice             |
| `stt_stream`    | `gpt-live-transcribe`    | Live captions while the participant talks |
| `tts`           | `tts-1`                  | The interviewer's own voice               |
| `embedding`     | `text-embedding-3-small` | Semantic clustering instead of keywords   |

The cheaper models are chosen deliberately: a voice interview pays per second of conversation.
Change a row in Admin → Routing for a better voice.

## Who may connect to what, and what may connect out

Three settings carry the network-facing security decisions; the defaults are right for the
single-host layout in this document and each is a stated number or list rather than a switch.

- **`TRUST_PROXY_HOPS`** (API, default `1`). How many proxies between the internet and the API
  write `X-Forwarded-For`. Caddy is one: for ordinary calls it writes the client address, the web
  app forwards that single value, and for the live-voice socket Caddy talks to the API directly.
  Caddy overwrites the header from the connection (`header_up X-Forwarded-For {remote_host}`),
  so a client cannot choose its own rate-limit bucket. Put another proxy or a CDN in front and
  this number has to change with it; a wrong value either lumps every visitor into one bucket or
  lets one visitor pick theirs. IPv6 clients are limited by their /64.
- **`EGRESS_ALLOW_HOSTS`** (API and worker; the compose default is `kroki`, the diagram renderer,
  whose host the API also adds by itself from `KROKI_URL`). The API connects out to model
  providers and mail relays that admins name. A **tenant** admin's address must be `https`, a
  public DNS name, port 443 or 8443, and may not resolve to a loopback, private, link-local or
  cloud-metadata address; this is checked on every connection, not only when it is saved. The
  **platform operator** may use `http` and may reach a private address only for the hostnames
  listed here (for instance a LiteLLM container named `litellm`). Leave it empty unless you run
  a model server inside this compose network, or an alert webhook (`ALERT_WEBHOOK_URL`, held to
  the same policy as a platform provider's address) on a private name. The metadata addresses (`169.254.169.254` and its
  relatives) are refused whatever you list. `EGRESS_MODE=permissive` exists for tests and the API
  refuses to start with it in production.
- **Request size.** Caddy refuses a body over 2 MB, except the two upload paths at 55 MB; the web
  app and the API apply the same ceilings, and a tenant's `files.maxSizeMb` (at most 50) is
  enforced before the file is read. Slow clients are cut off after 10 s of headers or 3 minutes of
  body.

Sign-in relay (`EMAIL_SMTP_URL`) is yours and is not restricted. An SMTP relay a tenant types in
Admin → Settings is: a public name, port 465, 587 or 2525, TLS required.

## Live voice

A live voice interview is the one browser call that does not go through the Next.js proxy. A route
handler cannot upgrade a connection, so `deploy/Caddyfile` forwards exactly
`/api/v1/p/session/live` to the API and everything else to the web app. The API authenticates it
with the same `aidp_participant` cookie the web app set, so the socket grants nothing an ordinary
HTTP call would not.

It is off until a tenant turns it on, from the **Live voice calls** switch at the top of Admin →
Settings → Voice. The panel shows whether the three voice purposes have a working route and where
it comes from. The call needs `transcription` and `tts`; if either is missing, turning the switch
on asks the admin for an OpenAI API key, checks it with one free request, stores it encrypted as
the tenant's OpenAI provider and routes the missing purposes to it (audited as
`voice.openai_connect`), then switches live voice on. With a platform `OPENAI_API_KEY` nobody is
asked for anything. `OPENAI_BASE_URL` in the API's environment points that key check and provider
somewhere other than `https://api.openai.com/v1`, for a regional endpoint or a proxy.

With an `stt_stream` route the call streams: the browser sends 24 kHz PCM continuously (about
48 kB/s per call, so allow for it on a thin uplink), the API holds one outbound WebSocket per call
to `wss://api.openai.com/v1/realtime?intent=transcription`, and captions grow while the participant
speaks. The API container needs outbound WebSocket access to OpenAI for that, as it already needs
HTTPS. If the streaming socket cannot be opened or drops mid-call, the call carries on per
utterance through `transcription`.

Without the required routes it degrades rather than breaking, and which rung it drops to depends on
what is missing:

| What is missing             | What the participant gets                                  |
| --------------------------- | ---------------------------------------------------------- |
| Streaming captions failing  | Captions per utterance, when the participant stops         |
| No `tts` route              | The call continues in captions, without the spoken voice   |
| A transcription that failed | The push-to-record button, worth retrying by hand          |
| No `transcription` route    | Typing. Nothing that listens can work, so nothing pretends |
| Transcription on the server | The push-to-record button, which does work (see below)     |

The interview itself is untouched in every case.

The on-server Whisper (the default `transcription` route) reads WAV only. The record button
converts each recording to WAV in the browser before uploading it; live voice streams WebM
utterances and does not, so with the default route a live call steps down to the record button on
the first utterance. For a live call that stays live, route `transcription` to OpenAI.

Costs run per second of conversation rather than per turn, which is worth knowing before opening
it to a whole department. The per-call figures land in the same cost ledger as everything else.

## PDF export and diagrams

The analysis report and each specification version can be downloaded as a PDF, and the
specification's diagrams are editable Mermaid. Two things make that work, and they are different
in kind.

**The PDF is composed inside the API process** (pdfmake, no browser). It needs no service, no
volume and no setting beyond the look of the document: `branding.productName` and
`branding.primaryColor` (the cover and headings), `exports.pdfPageSize` (A4 or Letter),
`exports.pdfCoverPage` and `exports.pdfFooterText`, all under Admin → Settings, per tenant. There
is no logo upload. A document is composed in about half a second at 135 pages (measured: 265 000
characters of Markdown, twelve diagrams over the cap shown as source), one at a time per API
process; a second request waits and a fourth is turned away with a 429.

**Diagrams are drawn by Kroki**, two containers in `deploy/compose.prod.yml`:

| Service         | Image                           | Limit  | Resident, measured             | What it is                               |
| --------------- | ------------------------------- | ------ | ------------------------------ | ---------------------------------------- |
| `kroki`         | `yuzutech/kroki:0.26.0`         | 320 MB | about 85 MB idle               | A JVM service (heap capped at 192 MB)    |
| `kroki-mermaid` | `yuzutech/kroki-mermaid:0.26.0` | 512 MB | about 115 MB idle, 295 MB busy | A Node service driving headless Chromium |

`kroki` cannot draw Mermaid by itself: it forwards the request to `kroki-mermaid` through
`KROKI_MERMAID_HOST`, which is why there are two. Together they add roughly 0.2 GB at rest and 0.4 GB
while a document with several diagrams is drawn (the API asks for at most three at a time). On the
4 GB host that is the headroom the Whisper model otherwise uses, so if you also run the on-server
transcription model, watch `docker stats` after the first exports; the limits above are the
ceilings that stop a runaway render taking the host with it.

- **Isolation.** Both sit on the `diagrams` network, which is `internal`: no route to the
  internet or to the host, and only `api` is also attached to it. A diagram label cannot make the
  renderer's browser fetch a URL or reach Postgres. The images are pinned; `latest` would change
  what a diagram looks like on the next pull. No port is published.
- **Wiring.** `KROKI_URL` (API only; compose sets `http://kroki:8000`) names the renderer. Its host
  is added to the egress allow-list for you, so `EGRESS_ALLOW_HOSTS` need not mention it, and a
  tenant's setting can never name a renderer. The default in compose is `kroki`, the same name.
- **When it is down.** Nothing fails. A PDF is still produced, each diagram that could not be
  drawn is printed as its Mermaid source under a note, and the download carries
  `x-export-warnings: diagram_unrendered:<n>`, which the exports panel shows. Saving a diagram in
  the editor still works and is marked "not verified".
- **Turning it off** (a 2 GB host, or no use for diagrams): put `KROKI_URL=` (empty) in
  `deploy/.env` and `deploy/dc stop kroki kroki-mermaid`. An upgrade starts them again, so
  also remove the two services from a local copy of the compose file if you want them gone.
- **Checking it.** `deploy/dc ps` shows both as `healthy`. To draw one by hand from the API's
  network: `deploy/dc exec -T api node -e "fetch('http://kroki:8000/mermaid/svg',{method:'POST',body:'flowchart LR\n A-->B'}).then(r=>console.log(r.status))"`.

The development stack runs the same pair under the `extras` profile
(`docker compose --profile extras up -d`), with Kroki published on 8000.

## Where the data lives

Named Docker volumes, all on this host's disk, under `/var/lib/docker/volumes/`:

| Volume              | Holds                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| `aidp_pgdata`       | The database. Everything that matters.                                                         |
| `aidp_uploads`      | Recorded audio and attached documents (FR-30, FR-31).                                          |
| `aidp_backups`      | Encrypted nightly `pg_dump` files and the matching file archive.                               |
| `aidp_models`       | The on-server Whisper model cache. Not backed up: it is re-downloaded.                         |
| `aidp_ops_state`    | Status and alert files shared between containers: the worker's heartbeat, the backup's status. |
| `aidp_caddy_data`   | TLS certificates and ACME account keys.                                                        |
| `aidp_caddy_config` | Caddy's autosaved config.                                                                      |
| `aidp_caddy_maint`  | The maintenance flag `upgrade.sh` raises during a switch.                                      |

`aidp_uploads` is the one people forget. Participants' recordings and the documents they attach
live there, not in Postgres, so a database-only backup would restore a system whose `Attachment`
rows all point at bytes that are gone — and nothing would say so until somebody pressed play. The
nightly job takes both, stamped identically, and `restore.sh` puts both back.

The prefix is the compose project name, pinned to `aidp` by `COMPOSE_PROJECT_NAME` in `deploy/.env`
(`generate-env.sh` writes it). An install made before it was pinned has the prefix `deploy`, and
keeps it by setting `COMPOSE_PROJECT_NAME=deploy`. `docker volume ls` shows the real names.

Every container that faces the network runs unprivileged: the API, the worker and the web app all
run as uid 1000 (`node`, in both images) over a root-owned, read-only
application tree. Confirm with `dc exec api id`.

`deploy/.env` is the sixth thing that matters and it is not in a volume. It is mode 600 in the
checkout, `.gitignore`d, and **not** baked into any image — the root `.dockerignore` excludes every
`.env` from the build context, and the images take their configuration from compose `environment:`
entries at run time. Back `deploy/.env` up somewhere other than this VPS: a database dump without
`PLATFORM_ENCRYPTION_KEY` cannot decrypt the provider keys or SMTP settings inside it.

## Database roles

Row-level security is the second tenancy fence (FR-01, NFR-03) and it only holds when the
application connects as `app_api`, which owns nothing and has no `BYPASSRLS`. The owner role
bypasses every policy, and when it does, nothing looks wrong — the app works, tests pass, and
tenant data leaks only once two tenants exist. That is the failure this deployment is built to
make impossible:

- `api` and `worker` have `postgresql://app_api:...` written literally into
  `deploy/compose.prod.yml`. Only the password comes from the environment, so there is no variable
  an operator can point back at the owner.
- `migrate` keeps the owner URL, because only the owner may change the schema, and it is handed
  `APP_DB_PASSWORD` so `bootstrap` gives `app_api` a login.
- `preflight` runs between them and refuses to let `api` or `worker` start unless it can prove, on
  a live connection, that: the URL names `app_api`, `current_user` agrees, the role has neither
  `rolsuper` nor `rolbypassrls`, no table that carries a `companyId` lacks row-level security,
  the role can read the job queue, and an untenanted connection sees **zero** `User` rows. The
  table check asks the database which tables have a `companyId` and no policy, and does not count
  against a floor, so a new tenant-owned table whose migration forgot its policy stops the stack on
  the next boot and names the table. A stack that would have run on the owner does not start at
  all, and the refusal is also written for the `ops-notify` sidecar to deliver, because nothing in
  the application is running to say so.

To check which role is in force on a running system:

```bash
dc exec -T postgres psql -U app -d ai_discovery \
  -c "select usename, count(*) from pg_stat_activity where datname='ai_discovery' and usename is not null group by 1;"
```

Healthy output — one `app` row is your own psql session:

```
 usename | count
---------+-------
 app     |     1
 app_api |    11
```

If you ever see the application's connections under `app`, stop the stack. `dc logs preflight`
will say which assertion failed.

Two runtime privileges were found by actually running the production stack rather than by reading
the schema. The first, pg-boss needing `CREATE` on the database, is migration
`0010_app_role_runtime_grants` and needs nothing from you: PostgreSQL checks that privilege before
it evaluates `CREATE SCHEMA IF NOT EXISTS`, so the API crash-loops without it. `CREATE` on a
database means "may create schemas in it" and nothing more; `app_api` still has no `BYPASSRLS` and
still owns no application table.

The second cannot be a migration, because it repairs state only a restore can produce, at a moment
when migrations have already run: `pg_restore` returns the pg-boss tables under the owner role with
nothing granted to `app_api`, and the API dies on "permission denied for table version". That is
what `deploy/grants.sql` and the `db-grants` service are for. It is idempotent and a no-op on a
healthy system.

## Backups

`backup` runs every night at `BACKUP_AT` (default 03:20, container clock, UTC) and writes an
**encrypted pair**, stamped identically: `ai_discovery-<stamp>.dump.age` (`pg_dump`, custom format)
and `uploads-<stamp>.tar.gz.age` (the uploads volume at the same moment). It decrypts the dump and
reads its table of contents before calling the run good, writes
`/ops-state/status/backup.json` (when, how big, table counts, offsite result), and keeps local files
for `BACKUP_RETENTION_DAYS` (14).

The container is **healthy only when the last backup succeeded and is recent.** It used to be
healthy for as long as its loop was alive, which a nightly `pg_dump` failing for a month never
disturbed. A failure now turns the container `unhealthy` and raises an alert (`backup.failed`, or
`backup.missing` after 26 hours without a success).

```bash
dc logs backup --tail 20                                   # what it has been doing
dc exec -T backup cat /ops-state/status/backup.json        # the last result, as data
dc exec -T backup /usr/local/bin/backup.sh once            # take one now
```

**Who it runs as.** Neither `backup` nor `ops-notify` runs as root (D-312). `backup` is the image's
`postgres` user (uid 999) with supplementary group 1000, which is how it reads the uploads volume
(the application writes its files `0640` as uid and gid 1000); `ops-notify` is uid 10001. A named
volume starts out root-owned, so the one-shot `ops-state-init` (the only service told to run as
root) gives `/backups` to 999 and the alert and watchdog directories to 10001 on every `up`,
including the first one after upgrading from a release in which they ran as root; there is no
manual `chown`. Checked in the rehearsal stack: `dc exec -T backup id` prints `uid=999(postgres)`,
a dump with an upload in the archive, the restore drill, a scratch restore and a live
`restore.sh --force` all work as that user.

**Encryption.** The key pair is `BACKUP_AGE_RECIPIENT` and `BACKUP_AGE_IDENTITY` in `deploy/.env`,
made once by `generate-env.sh` or `upgrade.sh`. Lose the identity and every backup is unreadable;
that is why `deploy/.env` goes to your password manager on day one.

**Offsite.** The volume is on the same disk as the database, so on its own it protects against a
dropped table and not against a dead host. Set `RCLONE_REMOTE` and its credentials in `deploy/.env`
(a commented block there shows an S3-compatible bucket and Backblaze B2, three lines each) and each
run copies the pair offsite, keeping 30 daily, 13 weekly and 13 monthly copies. Unset, the status
file says `offsite: not_configured`; the go-live list below asks you to decide that on purpose.

**Restore drill.** Every Sunday at 04:40 UTC the container restores the newest dump into a scratch
database and checks it against the manifest written beside the dump (row counts, and the files in
the uploads archive); a mismatch raises `backup.drill_failed` and makes the container unhealthy.
`BACKUP_DRILL=off`, `BACKUP_DRILL_DAY` (1 to 7, default 7) and `BACKUP_DRILL_AT` (default 04:40)
tune it.

Restoring, the restore drill, the upgrade and rollback flow, and what every alert means are in
[OPERATIONS.md](OPERATIONS.md#backups).

## Restoring

```bash
./deploy/restore.sh                                     # list the dumps
./deploy/restore.sh --latest --into ai_discovery_check   # verify a dump, live stack untouched
./deploy/restore.sh --latest --force                     # disaster: restore over the live database
```

It refuses to overwrite a database that still holds rows unless you pass `--force`, asks you to
type the target database name, and **reads and decrypts the dump before it stops or drops
anything**. Restoring over `ai_discovery` stops `api` and `worker`, recreates the database, runs
`pg_restore`, restores the matching uploads archive, then starts them again, which re-runs
`migrate`, `db-grants` and `preflight` on the way up: a dump older than the current code is migrated
forward, the runtime grants are re-applied and the role gate re-checks the result before traffic
returns.

The measured times (a restore on an Apple-silicon laptop against a freshly bootstrapped database
took 5 seconds end to end; a build from empty volumes to every service healthy took 48 to 51
seconds, images already built) are floors, not forecasts. Restore time is dominated by
`pg_restore`, which scales with data volume. Budget minutes rather than seconds, and measure your
own restore into a scratch database before you need it. The step-by-step, including onto a new
host from the offsite copy, is in [OPERATIONS.md](OPERATIONS.md#restoring).

```
restore: refusing to overwrite 'ai_discovery', which still has 3 User rows.
         Restore into a scratch database first (--into ai_discovery_check) to verify the
         dump, or pass --force if you really mean to discard what is there.
```

```
preflight: FAIL: APP_DATABASE_URL does not connect as app_api
preflight: FAIL: app_api has rolsuper/rolbypassrls = false true, expected 'false false'
```

## Secrets you cannot casually rotate

`PLATFORM_ENCRYPTION_KEY` is the platform key that encrypts provider API keys, provider headers,
secret settings and campaign link tokens at rest (`packages/core`, `Crypto`). It can be rotated
without losing anything, in four steps with a rollback at each; the full procedure, the drill and
what to check are in [the key rotation runbook](OPERATIONS.md#cryptorekey). In short:

1. Generate a new key and set it as `PLATFORM_ENCRYPTION_KEY`, moving the old value to
   `PLATFORM_ENCRYPTION_KEY_PREVIOUS` in `deploy/.env`. Restart. Everything still reads; new values
   are written under the new key.
2. As the platform operator, start the re-encryption (`POST /operator/crypto/rekey`, or the
   operator jobs page). It is safe to run twice.
3. Wait until `GET /operator/crypto/status` says `previousKeysRemovable: true`.
4. Remove `PLATFORM_ENCRYPTION_KEY_PREVIOUS` and restart.

Keep the old key until step 3 says it can go, and until a backup taken before the rotation has aged
out of your retention: restoring it needs the key that sealed it. If the old key is **compromised**
rather than merely old, also rotate the provider keys themselves at the provider, since the
ciphertext was exposed.

`AUTH_SECRET` signs session JWTs and is shared by the web app and the API. Changing it is safe and
signs everyone out; both services must get the same new value, so change it in `deploy/.env` and
recreate both.

`POSTGRES_PASSWORD` and `APP_DB_PASSWORD` are ordinary passwords. To change `APP_DB_PASSWORD`, edit
`deploy/.env` and run `dc up -d --force-recreate`: `migrate` re-runs `bootstrap`, which applies the
new password to the role, and the app picks up the same value from the same variable.
`POSTGRES_PASSWORD` is set by the Postgres image only on first initialisation, so changing it later
also needs `dc exec postgres psql -U app -c "alter role app password '<new>'"` before the recreate.

Back up `deploy/.env`. A database dump without it is only half a backup.

## Upgrading and rolling back

```bash
cd ai-interview
git pull
./deploy/upgrade.sh              # --dry-run says what it would do and changes nothing
./deploy/rollback.sh             # the previous version again: no build, no network
```

`upgrade.sh` takes a backup through the running backup container (and stops if that fails), builds
the images tagged with the git SHA, runs `migrate`, `db-grants` and `preflight`, switches `api`,
`worker` and `web` behind a maintenance page that says so in English and Finnish with a
`Retry-After`, and then checks that every service is healthy, that the API is ready with a live
database, and that Caddy serves the sign-in page. If a check fails it puts the previous code back
by itself. The previous image generation stays on the host (three are kept), which is what makes
`rollback.sh` a tag switch and not a rebuild.

Two things it will not do silently: build uncommitted changes (`--allow-dirty` tags them
`<sha>-dirty-<time>`, never the sha), and start on a host whose volumes belong to a different
project name (the empty-database mistake, caught before the build).

There is a gap of a few seconds while `api` restarts; the maintenance page covers it. A blue-green
rollout would double the memory the stack needs for those seconds and gain nothing on the schema
side, which is shared: it is not done here.

**Migrations** are forward-only and written to be additive: a column is added in one release and
dropped in a later one, after the code stopped reading it. That is what lets `rollback.sh` put old
code on the newer schema. A release that cannot honour this says so in its migration's header, and
for that one the dump `upgrade.sh` printed (also recorded in `deploy/versions.env`) is the way back:
`./deploy/rollback.sh`, then `./deploy/restore.sh <that dump> --force`. The three ways an upgrade's
migration can fail, and what to do in each, are in
[OPERATIONS.md](OPERATIONS.md#migratefailed).

## Reading the logs

```bash
dc logs -f                       # everything, live
dc logs -f api                   # one service
dc logs --since 1h api worker    # a window
dc logs api | grep -i error
```

The API and worker log structured JSON (pino). For readable output, pipe through `jq`:

```bash
dc logs --no-log-prefix api | grep '^{' | jq -c '{t:.time, lvl:.level, msg:.msg, req:.reqId}'
```

Caddy logs access in JSON on stderr; `dc logs caddy` shows every request with status and duration.
Link tokens in the path and the secret keys of a query string are filtered out of it.

Every API and worker line carries `tenantId` (and `sessionId`, `userId`, `jobId`, `traceId` where
they apply), and none carries a token, message text, an address, a key or a filename: the list is
in [OPERATIONS.md](OPERATIONS.md#what-is-never-logged).

```bash
dc logs --no-log-prefix api | grep '^{' | jq -c 'select(.tenantId == "<company id>")'
```

Every service uses the `json-file` driver capped at **3 files of 10 MB**, so container logs can
never consume more than about 180 MB across the stack. This is the single most boring way to lose a
pilot and it is the reason the cap is there.

## When the disk fills

Symptoms: Postgres refuses writes, the API returns 500s, `dc ps` looks fine. You are warned well
before this: the worker's sweep alerts at 80 percent (warning) and 90 (critical), and the sidecar
takes over if the worker is down. The runbook is in [OPERATIONS.md](OPERATIONS.md#diskhigh).

```bash
df -h /                                  # how bad
docker system df                         # what Docker is holding
dc exec -T backup du -sh /backups        # how much is backups
```

In order of what to try:

```bash
docker image prune -a -f                 # old images from previous builds; usually the biggest win
docker builder prune -f                  # BuildKit cache
```

`docker image prune -a` also removes the previous version's images, which `rollback.sh` needs; it
only does so for images no container uses, so run it after you have decided not to roll back.
Then lower `BACKUP_RETENTION_DAYS` in `deploy/.env` and `dc up -d backup`. If the database itself is
the size, that is a capacity decision, not a cleanup: grow the volume or move to a bigger host.
Check `dc exec -T postgres psql -U app -d ai_discovery -c "\l+"` for the real figure.

## Testing without a public domain

You cannot get a real certificate without a domain that resolves to the host, so Caddy is told to
issue from its own CA instead. Three variables in `deploy/.env`:

```bash
PUBLIC_HOSTNAME=localhost
CADDY_LOCAL_CERTS=1               # Caddy's internal CA instead of Let's Encrypt
HTTP_PORT=5580                    # optional: only if 80/443 are taken
HTTPS_PORT=5543
```

Then the ordinary commands work, with `curl -k` to accept the self-signed certificate:

```bash
./deploy/upgrade.sh                   # or, to change only deploy/.env: dc up -d
curl -k -o /dev/null -w '%{http_code}\n' https://localhost:5543/auth/signin     # 200
```

**For a real domain, change exactly this and nothing else:** set `PUBLIC_HOSTNAME` to the hostname,
leave `CADDY_LOCAL_CERTS` empty, remove `HTTP_PORT`/`HTTPS_PORT` so Caddy binds 80 and 443, and put
a real address in `ACME_EMAIL` (Let's Encrypt sends expiry warnings there). Caddy then obtains a
certificate on first request and renews it on its own. Everything else — the proxying, the headers,
`WEB_ORIGIN`, `AUTH_URL`, `PUBLIC_WEB_URL` — is derived from `PUBLIC_HOSTNAME` and needs no edit.

If the certificate does not appear, the cause is almost always DNS or port 80:

```bash
dig +short pilot.example.com            # must be this host's IP
dc logs caddy | grep -i acme
```

## Rehearsing a deployment

Everything above has also been run, end to end, on one machine with throwaway secrets, a scripted
model and a mail catcher, so that a script change can be tried before it meets a pilot's data. The
rehearsal is test-only and never touches `deploy/.env`:

```bash
deploy/drill/stack.sh up            # generate a scratch env outside the repo, then upgrade.sh
deploy/drill/stack.sh configure     # point the platform at the fake provider, open a campaign
deploy/drill/stack.sh run node deploy/drill/journey.mjs all     # interviews, analysis, specification, PDF
deploy/drill/stack.sh run node deploy/drill/voice.mjs 3         # the live voice socket through Caddy
load/run.sh smoke                   # k6, from inside the stack's network (full: `load/run.sh full`)
deploy/chaos/run.sh                 # provider 5xx and hang, Postgres restart, kills, Caddy, full disks
deploy/drill/stack.sh down          # containers, volumes and images; the scratch directory stays
```

What it is made of: [`deploy/compose.fake.yml`](../deploy/compose.fake.yml) adds the fake provider
(`tools/fake-provider`, an OpenAI-compatible server with scripted interviews and a control endpoint
for latency and failure injection) and a mail catcher to the production file; nothing in
`compose.prod.yml` knows about them. The scratch directory (`$TMPDIR/aidpfull`, mode 700) holds the
generated env, the version record and the results; the project is `aidpfull`, the ports 18080 and
18443, the hostname `aidp.localhost`, Caddy's own CA.

Things this taught, which are why the rehearsal exists (dated records:
[`docs/team/drills/2026-10-14-full-stack.md`](team/drills/2026-10-14-full-stack.md) and
[`-chaos.md`](team/drills/2026-10-14-chaos.md)):

- A sign-in link in a test install points at `https://<host>` without the port. With `HTTPS_PORT`
  set, `PUBLIC_WEB_URL`, `WEB_ORIGIN` and `AUTH_URL` now carry it too.
- `docker kill` is a manual stop, and a manual stop switches the restart policy off. A crash is a
  signal from outside the container's PID namespace; `deploy/chaos/lib.mjs` (`crash`) does that.
- A Docker host that has run many Compose projects can be out of address pools
  ("all predefined address pools have been fully subnetted"): the overlay gives the diagram network
  a fixed subnet for that reason. A VPS running only this stack does not need it.

## Capacity and load

Measured on 2026-10-14 with `load/run.sh full` against the rehearsal stack (an 8 GB Docker VM with
14 CPUs, shared with other work; version `ffd17ea6ce11`; fake provider at 400 ms plus up to 100 ms
of jitter, 400 characters a second, so the numbers are the platform's own overhead on top of a
provider with that latency):

| Scenario (all at once)                                           | Result                                                    |
| ---------------------------------------------------------------- | --------------------------------------------------------- |
| 40 concurrent interviews of 20 turns, think time 3 to 8 s        | 1 600 turns, 0 errors, 0 5xx                              |
| First token (response headers of the SSE turn, through Caddy)    | p50 481 ms, p95 532 ms, p99 608 ms, max 1.03 s            |
| Whole turn                                                       | p50 1.05 s, p95 1.13 s                                    |
| 5 live voice sessions, 4 exchanges each, 316 exchanges in all    | 0 errors; first word p95 1.44 s (target 1.5 s, see below) |
| Campaign launch: 100 link opens in a minute from 100 addresses   | 0 errors, 0 rate-limited, open p95 61 ms                  |
| The same opens from one address (the limiter's negative control) | 30 accepted, 30 answered 429                              |
| Admin reading dashboards (2 readers, 180 reads)                  | 0 errors                                                  |

Peak use per container during that run (`docker stats` every 5 s) against the limit it has:

| Service       | Peak memory                       | Limit | Peak CPU (of one core) |
| ------------- | --------------------------------- | ----- | ---------------------- |
| postgres      | 199 MiB                           | 1536M | 28 %                   |
| api           | 182 MiB                           | 2560M | 71 %                   |
| web           | 128 MiB                           | 768M  | 19 %                   |
| worker        | 121 MiB                           | 1024M | 39 %                   |
| kroki         | 113 MiB                           | 320M  | 2 %                    |
| kroki-mermaid | 104 MiB (about 300 while drawing) | 512M  | 21 %                   |
| caddy         | 45 MiB                            | 256M  | 3 %                    |
| backup        | 1 MiB (a dump adds a few)         | 512M  | 9 %                    |
| ops-notify    | 2 MiB                             | 32M   | 0 %                    |

About 0.9 GB in total at that load. The limits are ceilings that keep one runaway process from
taking the host, and the API's is large because the on-host Whisper model needs about 2 GB while it
transcribes; with transcription routed to a provider 1024M is plenty. They are variables
(`API_MEMORY_LIMIT`, `POSTGRES_MEMORY_LIMIT`, and so on, in `deploy/.env`), with two presets:
`deploy/sizes/4gb.env` (about 3.7 GB of limits) and `deploy/sizes/8gb.env` (the defaults).
**The 4 GB preset was run, not assumed**: the same full run with `deploy/sizes/4gb.env` applied
(api 1024M, postgres 768M with 192 MB of buffers, worker 512M, web 384M, caddy 128M, backup 256M,
kroki 256M, kroki-mermaid 384M) finished with 0 errors and 0 5xx, first token p95 519 ms, voice first
word p95 1.42 s, and no container killed for memory or restarted (kroki-mermaid peaked at 236 MiB
of its 384M, the largest share of any limit; the rest used a fifth or less). The sum of those limits
is 3.7 GB, so a 4 GB host runs this stack with the OS in what is left only if nothing else shares it
and the build is not run on top of it.

**A launch is counted in sessions the moment the link is opened.** Each open creates a session, and
`ceiling.maxSessionsPerMonth` (default 1000) counts it whether or not the person ever answers. The
rehearsal's own load runs (about 300 interviews each) used a tenant's month up in four runs, and the
product answered every further open with `403 limit_reached`, as designed. The abuse limits on open
links (D-261) sit in front of that. The first drill's numbers above predate them; the second drill
(2026-10-14, [full-stack-2](team/drills/2026-10-14-full-stack-2.md), version `59e30a812e31`) ran the
load against the **defaults**, with the traffic spread over three campaigns and over 150 source
addresses, and asked whether legitimate people were turned away:

| Profile (defaults as they were)                                         | People turned away                                                                               |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Full run, one campaign took the burst (120 an hour per campaign)        | 311 of 499 open attempts (the cap of one campaign, reached inside five minutes; retries counted) |
| Full run over three campaigns                                           | 0 of 277 (113, 85 and 79 of 120 used: no refusal, and no margin)                                 |
| 40 colleagues behind one address in two minutes (30 a minute per route) | 0                                                                                                |
| 90 colleagues behind one address in one minute (30 a minute per route)  | 60 of 90                                                                                         |

So two defaults were wrong for a real launch and were changed (D-310, D-311): the per-address bucket
on the link routes is `RATE_LIMIT_PUBLIC_MAX`, **120** a minute (was 30), and `abuse.campaignSessionsPerHour`
is **300** (was 120), `abuse.tenantSessionsPerHour` **1000** (was 500). With them: 90 colleagues from
one address in a minute, 0 turned away; the same full run with every arrival on one campaign (279 opens
in five minutes), 0 turned away; 200 opens from one address are still cut at 120. `abuse.campaignSessionsTotal`
stays 2000: it is the cost ceiling for a leaked link, and a campaign inviting more people sets it
higher at campaign scope. The limits are counted in Postgres and so survive a restart; a refused
attempt is counted too, so a person who keeps retrying keeps the window shut until the hour ends.
`configure.mjs` no longer raises the limits (`AIDP_DRILL_RAISE_ABUSE=1` does, for a pure capacity run).

**What the numbers do not say**: they are one tenant, a fake provider, a 40 MB database and a
machine with plenty of CPU. A pilot's own data (transcripts of real length, a real model's
streaming speed, a real embedding route) is the next measurement; run `load/run.sh full` on the
host before the pilot, in a quiet hour, with `FAKE_*` set to the latency of the provider you chose.

**Voice first word is bounded by the whole reply, not by its first sentence.** The live call speaks
a turn only when the model's reply, metadata included, has arrived and been stored
(`apps/api/src/modules/participant/voice-live/turn.ts`): the streamed text is not used for speech.
With a provider that has no latency at all the platform's own overhead is 55 ms median (p95 90 ms).
With the fake at 400 ms to first byte, 250 ms to the first audio byte and 400 characters a second,
the first word is 1.35 s; at 250 characters a second (about 60 tokens a second) it is 1.67 s, past
the 1.5 s target. A model that streams slowly, or a long metadata block, moves it one for one.
Speaking the first complete sentence while the metadata finishes is the change that would decouple
the two; it is an engine change and is not made here (docs/team/drills/2026-10-14-full-stack.md).

**One harness caveat.** The launch burst opens 100 connections from 100 source addresses added to
the load generator's container. The first connection from each new address to Caddy took about 20 s
in that Docker network (ARP resolution for new neighbours on the bridge), and 0.1 ms afterwards, so
`load/run.sh` warms the addresses first. That is the test network, not the product, and a real
campaign arrives from routed addresses.

## Before you go live

- [ ] DNS resolves to this host; `https://<hostname>/auth/signin` returns 200 with a certificate
      your browser trusts, and `dc logs caddy | grep -i "certificate obtained"` confirms it.
- [ ] `CADDY_LOCAL_CERTS` is empty and `HTTP_PORT`/`HTTPS_PORT` are unset.
- [ ] `dc logs preflight` says `ok`, and `pg_stat_activity` shows the app on `app_api`.
- [ ] A magic link actually arrives in a real inbox, from a real relay, and signs you in.
- [ ] A provider is configured and `interview_turn` has a route — take one interview end to end.
- [ ] If you want voice or semantic clustering, `OPENAI_API_KEY` is set and Admin → Routing shows
      `transcription`, `tts` and `embedding` bound to it. Without them voice degrades and analysis
      clusters on keywords; both are silent, so check rather than assume.
- [ ] If live voice is on, hold one real conversation on a phone, on mobile data, and interrupt the
      interviewer mid-sentence. Latency and barge-in are the two things a desk test will not show.
- [ ] Attach a document during an interview and confirm it reaches `Ready`, not `Failed`.
- [ ] `curl -s -o /dev/null -w "%{http_code}" -X POST --data-binary @<a 3 MB file> https://<hostname>/api/staff/campaigns`
      answers `413` from Caddy, and `TRUST_PROXY_HOPS` still matches the proxies you run.
- [ ] `pnpm audit --prod --audit-level=high` is clean on the commit you deployed.
- [ ] `dc exec -T backup cat /ops-state/status/backup.json` says `lastResult: ok`, and you have
      restored that dump into `ai_discovery_check` and compared the row counts with its `counts`.
- [ ] `deploy/.env` is copied somewhere off this host, and you know it contains
      `PLATFORM_ENCRYPTION_KEY` and `BACKUP_AGE_IDENTITY`: the backups are unreadable without them.
- [ ] `RCLONE_REMOTE` is set and `offsite` in the status file is `ok`, or you have written down
      that it is not and accepted that.
- [ ] An alert reaches you: set `ALERT_WEBHOOK_URL` or `ALERT_EMAIL`, then
      `dc exec -T ops-notify sh -c 'echo "{\"kind\":\"alerts.storm\",\"severity\":\"critical\",\"key\":\"test\",\"title\":\"Test alert\",\"message\":\"If you can read this, alerts work.\"}" > /ops-state/alerts/test.json'`
      and see it arrive within a minute.
- [ ] `ufw status` (or your provider's firewall) allows only 22, 80 and 443. Nothing but Caddy
      publishes a port, but a firewall is the fence you get to keep when compose changes.
- [ ] Unattended security upgrades are on for the host OS.
- [ ] `df -h` shows room; the disk alert is the thing that tells you when it does not.
- [ ] Someone other than you knows this document, and [OPERATIONS.md](OPERATIONS.md), exist.

## What this deliberately does not cover

- **Dashboards on a 4 GB host.** First-token and voice p95s, queue age and the platform signals are
  on Operator → Platform health and in `/stats` with nothing extra running. Grafana, Prometheus and
  Tempo are an optional profile (`infra/observability`): Prometheus and Grafana add 416 MB of
  limits, which fits the 4 GB preset with about 450 MB left for the OS; Tempo adds 192 MB and
  belongs on 8 GB, or point `OTEL_EXPORTER_OTLP_ENDPOINT` at a hosted OTLP receiver. How to start
  it is in [infra/observability/README.md](../infra/observability/README.md). Both the API and the
  worker export spans when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
- **Multi-host, high availability, zero-downtime deploys.** One host, one replica of each service,
  a few seconds of downtime per upgrade behind a maintenance page. Blue-green (`12-operations.md`)
  needs somewhere to be green.
- **An offsite copy you did not configure.** Backups leave the host only when `RCLONE_REMOTE` is
  set, and the account at the other end is yours to create.
- **Object storage.** Uploads are a volume on this host, backed up with the dump. MinIO is in the
  development stack under the `extras` profile, as a stand-in for the `StoragePort` S3 adapter; it
  is not part of the production stack.
- **Host hardening.** SSH keys, fail2ban, unattended-upgrades, kernel tuning — standard VPS work,
  no different here.
- **Database tuning.** `shared_buffers=512MB` and `max_connections=100` are defensible defaults for
  4 GB of RAM and no more than that.
