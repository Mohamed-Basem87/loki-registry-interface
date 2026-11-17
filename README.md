# Loki Registry Interface

Standalone admin UI for registering source IDs and scaffolding categories. It
does not implement or configure ingestion adapters.

## What it changes

- **Source:** adds `{ id, display_name, aliases }` to `sources` in Loki's
  `config/project.json`, registers `{ id, name }` through the sender's
  `POST /sources`, then commits directly to the configured GitHub branch.
  It does not change `job_sources`, scraper code, Telegram channel settings,
  or credentials.
- **Category:** creates a base package under
  `app/domain/categories/<id>/` and registers `{ id, name }` through the
  sender's `POST /categories`, then commits the package directly to GitHub.
  Classification keywords and category-specific prompt guidance are
  intentionally left for a developer to fill in.

The sender catalog write happens before the GitHub commit so the sender knows
the ID before a deployed Loki image can emit it. If the sender write succeeds
but the GitHub commit fails, the UI reports that partial result explicitly.
Retrying is safe when the ID/name already match on the sender.

The source registry is metadata only. An ID in `sources` does not start a
worker. The Loki code that later implements an adapter must use that same ID.
If `FREEHUB_SOURCES` is set in Loki's runtime environment, its current
allow-list behavior still applies; this interface deliberately does not edit
runtime environment variables.

## GitHub setup

Create and install a GitHub App on only the Loki repository. Grant it
**Contents: Read and write** permission. Configure its App ID, installation
ID, private key, repository, and target branch below. The app creates one
commit per registration directly on `main`, which triggers the existing Loki
workflow. Branch protection must permit that app to update the branch.

The private key is read from `GITHUB_APP_PRIVATE_KEY_FILE`; do not commit it
or put it in browser-visible configuration.

## Sender setup

Set `SENDER_API_BASE_URL` to the sender's private Tailscale address using the
**host port its compose file publishes**, for example
`http://sender-name:4090`. That is not necessarily the port the sender process
listens on inside its container: a mapping such as `'${PORT:-3000}:3000'`
publishes a different port when `PORT` is set, and a mismatch only shows up as
connection refused.

Verify it from inside this container before relying on it:

```powershell
docker compose exec registry-interface node -e "fetch(process.env.SENDER_API_BASE_URL + '/sources').then(r => console.log(r.status))"
```

A `200` with a JSON array means the URL is correct. The value is read at
container creation, so changing it in `.env` needs
`docker compose up -d --force-recreate`.

Registering writes one row into the sender's `categories` or `sources` table and
takes effect immediately: its pickers query those tables on every render, so no
restart, deploy, or image rebuild is involved. The API is insert-only — there is
no endpoint to rename, disable, or delete an entry, and an existing row with
`enabled = false` is hidden from `GET` while still returning `409` on `POST`,
which only direct database access can resolve.

The sender's current category/source endpoints do not authenticate requests.
Keep the sender and this interface reachable only over a restricted tailnet,
with an ACL that allows this interface host to reach the sender API. The
optional bearer token is sent if configured, but the current sender code does
not enforce it.

## Runtime configuration

Required secrets:

- `ADMIN_USERNAME`
- `ADMIN_PASSWORD` or `ADMIN_PASSWORD_FILE`
- `SESSION_SECRET` or `SESSION_SECRET_FILE` (at least 32 characters)
- `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`,
  `GITHUB_APP_PRIVATE_KEY_FILE`, `GITHUB_OWNER`, and `GITHUB_REPO`
- `SENDER_API_BASE_URL`

`COOKIE_SECURE=true` is required when serving the UI over HTTPS. Leave it
`false` when using the default compose setup, which serves plain HTTP on
`http://<host-ip>:<PORT>`.

The container listens on port `8080`. It has no third-party runtime
dependencies and can be tested with `npm test`.

## Publishing the image

The GitHub Actions workflow runs tests, then publishes `latest` and the commit
SHA to `mohamedbasem2/loki-registry-interface` on Docker Hub. Add these GitHub
Actions repository secrets before pushing to `main`:

- `DOCKERHUB_USERNAME`
- `DOCKERHUB_TOKEN` (a Docker Hub access token with write access)

Create the Docker Hub repository under that namespace first. If either secret
is missing, tests still run but image publishing is skipped. The workflow
cannot publish until both secrets are configured.

## Running on the server

Copy `docker-compose.yml` and `.env.example` to the server, create `.env`, and
create the three secret files under `secrets/`. Do not put secret values in
Git. Set `SENDER_API_BASE_URL` to the sender's Tailscale DNS name or address and
its published host port.

The compose file publishes the UI on `${PORT:-8080}` on all host interfaces, so
it is reachable at `http://<host-ip>:<PORT>` over the LAN or Tailscale. The only
access control is the admin login, so do not port-forward it to the public
internet; keep it on the LAN/tailnet or put an authenticating reverse proxy in
front of it.

After the image has been published:

```powershell
docker compose pull
docker compose up -d
docker compose ps
docker compose logs --tail 100 registry-interface
```
