# Zoho streaming starter

A copy-and-run **starter project** for the Zoho streaming frontend and Phase 3 API foundation. It is Netflix-inspired in layout, but uses an original brand, fictional sample titles, and original vector artwork.

## What is included

- `index.html` — responsive streaming-style homepage with search, rails, filters, details, local watchlist/continue-watching, title-request form, and admin preview.
- `backend/` — Fastify + PostgreSQL API foundation: public catalog routes, admin login, secure HttpOnly session cookie, Owner/Admin/Editor role checks, audit log, rights metadata, and draft title endpoints.
- `compose.yaml` — production-oriented Docker Compose services.
- `compose.local.yaml` — local HTTP preview on port 8080.
- `Caddyfile` — HTTPS reverse proxy for a real domain.
- `nginx.conf` — serves the frontend and proxies API requests in the local setup.
- `.env.example` — environment-variable template. It contains placeholders, not working production secrets.

## Run locally

You need Docker Desktop, or Docker Engine plus the Docker Compose plugin. From the extracted project folder:

1. Make a private local environment file:

```bash
cp .env.example .env
```

2. Edit `.env`. For local use set `SITE_DOMAIN=localhost`. Replace all secret placeholders. Generate random values with:

```bash
openssl rand -hex 24
openssl rand -hex 32
```

Use the first output for `POSTGRES_PASSWORD`, the second for `JWT_SECRET`, and a separate long password of at least 16 characters for `BOOTSTRAP_OWNER_PASSWORD`. Set `BOOTSTRAP_OWNER_EMAIL` to your own email. Do not publish `.env` or send its contents to anyone.

3. Start the app:

```bash
docker compose -f compose.yaml -f compose.local.yaml up --build -d
```

4. Open **http://localhost:8080**. Check the API with:

```bash
curl http://localhost:8080/api/health
```

Stop it with:

```bash
docker compose -f compose.yaml -f compose.local.yaml down
```

This keeps the database volume. To permanently delete the local database too, use `down -v` (that deletes data).

## Connect it to your server

1. Point your domain’s DNS `A` record to the server’s public IP. Open TCP ports 80 and 443; keep SSH restricted and confirm it works before changing firewall rules.
2. Copy `.env.example` to `.env` on the server. Set `SITE_DOMAIN=your-domain`, `APP_ORIGIN=https://your-domain`, strong unique secrets, and your bootstrap Owner email/password.
3. Start the production profile:

```bash
docker compose --profile production up --build -d
```

4. Visit `https://your-domain`. Caddy obtains and renews the HTTPS certificate once DNS and ports are correct.
5. After the first Owner account is created, remove `BOOTSTRAP_OWNER_EMAIL` and `BOOTSTRAP_OWNER_PASSWORD` from the server environment and redeploy. Keep database and admin secrets private.

The API runs on the private Docker network; Postgres is not published on a public port. Back up the database volume before updates.

## API foundation

- `GET /api/health` — service health
- `GET /api/catalog` — published, worldwide-streaming-cleared titles only
- `POST /api/admin/login` — admin sign-in; accepts JSON `{ "email": "…", "password": "…" }`
- `POST /api/admin/logout` and `GET /api/admin/me`
- `/api/admin/titles` — list and create draft titles, edit title metadata, set rights, and rights-check publishing
- `/api/admin/users` — Owner-only user/role management

The starter database seeds nine **draft** fictional titles. The public API intentionally does not publish them without current worldwide streaming rights. Add rights through the admin API, then use the publish action.

## Not connected yet

This package is runnable, but it is not a finished streaming service. The homepage’s sample controls are frontend demos; the admin-preview form is not yet wired to the API. Phase 4 still needs authenticated resumable uploads, private media storage, FFmpeg processing, HLS playback, download profiles, and CDN delivery. No actual films or series files are included.

Only distribute content you own or have permission to stream/download in the relevant territories. Free access does not remove licensing requirements. The fictional sample titles and illustrations are for development only.
