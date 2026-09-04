# ShortenURL

A small URL shortener split into three services.

| Service        | Stack                              | Port | Owns table |
| -------------- | ---------------------------------- | ---- | ---------- |
| `ui`           | React + Vite                       | 3000 | —          |
| `auth-server`  | Python FastAPI + `psycopg` (pg)    | 4000 | `users`    |
| `short-server` | Node + Express + TypeScript + `pg` | 5000 | `links`    |

No ORM — both services talk to Postgres with the plain driver and hand-written
SQL, kept in a `repositories/` folder per service.

## Features

- Shorten a URL without an account.
- Register / log in, then every link you shorten is saved to your history.
- History table shows the click count per link, updated on every redirect.

## How the services talk

`auth-server` signs a JWT (HS256) with `JWT_SECRET`; `short-server` verifies that
same token locally. No service-to-service call is needed.

**The `JWT_SECRET` in both `.env` files must be identical** or a login will not
be recognised by the shortener.

## Database

Both services point at the same Supabase database and each creates its own table
on startup (`CREATE TABLE IF NOT EXISTS`, from `schema.sql`) — there is no
migration step to run.

- [auth-server/app/db/schema.sql](auth-server/app/db/schema.sql) → `users`
- [short-server/src/db/schema.sql](short-server/src/db/schema.sql) → `links`

Connection string (already in both `.env.example` files — fill in the password):

```
postgresql://postgres:[YOUR-PASSWORD]@db.mgrekulpuebuyrvtvgpu.supabase.co:5432/postgres
```

> If that host does not resolve, your network is likely IPv4-only while the
> Supabase direct connection is IPv6. Use the connection **pooler** string from
> the Supabase dashboard (`...pooler.supabase.com:6543`) instead.

## Prerequisites

- Node.js 20+
- Python 3.10+

## Run it (one command)

From the repo root:

```powershell
npm run setup:venv   # once - creates auth-server/.venv
npm install          # once - installs concurrently
npm run setup        # once - pip install + npm install for all three services
npm run dev          # starts ui, auth-server and short-server together
```

Copy the two `.env.example` files to `.env` first (see below), then open
http://localhost:3000. `Ctrl+C` stops all three at once.

| Script          | Does                                              |
| --------------- | ------------------------------------------------- |
| `npm run dev`   | all three in watch mode (`:3000`, `:4000`, `:5000`) |
| `npm run build` | `tsc` for short-server, `vite build` for ui        |
| `npm start`     | all three from the built output                    |

Each service can still be run on its own: `npm run dev:ui`, `npm run dev:auth`,
`npm run dev:short`.

## Run it (three terminals)

### 1. auth-server → http://localhost:4000

```powershell
cd auth-server
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env      # then put your Supabase password in DATABASE_URL
uvicorn app.main:app --reload --port 4000
```

Interactive API docs: http://localhost:4000/docs

### 2. short-server → http://localhost:5000

```powershell
cd short-server
npm install
copy .env.example .env      # same password, same JWT_SECRET as auth-server
npm run dev
```

### 3. ui → http://localhost:3000

```powershell
cd ui
npm install
npm run dev
```

Open http://localhost:3000.

## Dependencies

`auth-server` — each line in
[requirements.txt](auth-server/requirements.txt) carries a comment explaining
what it is for:

| Package          | Used for                                             |
| ---------------- | ---------------------------------------------------- |
| `fastapi`        | routing, validation, **OpenAPI spec + `/docs` UI**   |
| `uvicorn`        | the ASGI server that runs the app                    |
| `psycopg`        | Postgres driver                                      |
| `psycopg-pool`   | async connection pool                                |
| `pydantic`       | request/response models (`EmailStr` needs `[email]`) |
| `PyJWT`          | **creating and verifying the access token**          |
| `bcrypt`         | password hashing                                     |
| `python-dotenv`  | loads `.env` into the environment                    |

`short-server` — JSON allows no comments, so the same notes live here:

| Package        | Used for                                        |
| -------------- | ----------------------------------------------- |
| `express`      | HTTP routing                                    |
| `pg`           | Postgres driver + connection pool                |
| `jsonwebtoken` | **verifying the token issued by `auth-server`** |
| `cors`         | lets the browser UI on :3000 call this service  |
| `dotenv`       | loads `.env` into `process.env`                 |
| `typescript`   | build (`tsc`); `ts-node-dev` runs it in dev     |

`ui` — `react` / `react-dom`, built and served by `vite`. No HTTP client
library: it uses the browser's `fetch` in
[ui/src/lib/api.js](ui/src/lib/api.js).

## API

### auth-server (`:4000`)

| Method | Path             | Auth   | Body / Result                                |
| ------ | ---------------- | ------ | -------------------------------------------- |
| POST   | `/auth/register` | —      | `{email, password}` → `{access_token, user}` |
| POST   | `/auth/login`    | —      | `{email, password}` → `{access_token, user}` |
| GET    | `/auth/me`       | Bearer | → `{id, email}`                              |

### short-server (`:5000`)

| Method | Path           | Auth     | Body / Result                                   |
| ------ | -------------- | -------- | ----------------------------------------------- |
| POST   | `/api/shorten` | optional | `{url}` → `{code, shortUrl, targetUrl, clicks}` |
| GET    | `/api/links`   | Bearer   | → the caller's links, newest first              |
| GET    | `/:code`       | —        | 302 to the original URL, increments `clicks`    |

Links created without a token have `user_id = NULL`, so they work but never
appear in a history.

## Environment variables

`auth-server/.env`

```
DATABASE_URL=postgresql://postgres:[YOUR-PASSWORD]@db.mgrekulpuebuyrvtvgpu.supabase.co:5432/postgres?sslmode=require
JWT_SECRET=super-secret-change-me
JWT_EXPIRES_MINUTES=1440
```

`short-server/.env`

```
DATABASE_URL=postgresql://postgres:[YOUR-PASSWORD]@db.mgrekulpuebuyrvtvgpu.supabase.co:5432/postgres
JWT_SECRET=super-secret-change-me
PORT=5000
PUBLIC_BASE_URL=http://localhost:5000
```

`ui/.env` (optional — these are the defaults)

```
VITE_AUTH_URL=http://localhost:4000
VITE_SHORT_URL=http://localhost:5000
```

TLS: `psycopg` gets `?sslmode=require` in the URL; the Node pool enables TLS
automatically for any non-localhost host in
[short-server/src/db/pool.ts](short-server/src/db/pool.ts).
