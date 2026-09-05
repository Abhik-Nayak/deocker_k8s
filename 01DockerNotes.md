# ShortenURL — Architecture & Docker Notes

Notes on how this app is put together, and how the same thing looks once it runs
in Docker: images, containers, networks, DNS, ports and env vars.

---

## 1. The app: three services + one database

| Service        | Stack                              | Listens on | Owns table |
| -------------- | ---------------------------------- | ---------- | ---------- |
| `ui`           | React + Vite                       | 3000       | —          |
| `auth-server`  | Python FastAPI + `psycopg`         | 4000       | `users`    |
| `short-server` | Node + Express + TypeScript + `pg` | 5000       | `links`    |
| Postgres       | Supabase (managed, external)       | 5432       | both       |

```
                        ┌─────────────────────────────┐
        browser ───────▶│  ui  (React, port 3000)     │
                        └──────────┬──────────┬───────┘
                                   │          │
              login / register     │          │   shorten / history
                                   ▼          ▼
                   ┌───────────────────┐   ┌────────────────────┐
                   │   auth-server     │   │   short-server     │
                   │  FastAPI  :4000   │   │  Express   :5000   │
                   │  issues JWT ──────┼──▶│  verifies JWT      │
                   └─────────┬─────────┘   └─────────┬──────────┘
                             │  psycopg              │  pg
                             ▼                       ▼
                   ┌──────────────────────────────────────────┐
                   │        Postgres  (Supabase :5432)        │
                   │   users  ◀── auth      links ◀── short   │
                   └──────────────────────────────────────────┘
```

**The two servers never call each other.** `auth-server` signs a JWT with
`JWT_SECRET`; `short-server` verifies that same signature locally using the
identical secret. That is the whole integration — no service discovery, no
shared session store, no network hop between them.

> Consequence: if the two `JWT_SECRET` values drift apart, login "works" but
> the shortener silently treats every user as anonymous.

### Request flows

| Flow                 | Path                                                                    |
| -------------------- | ----------------------------------------------------------------------- |
| Shorten, logged out  | `ui` → `POST /api/shorten` (no token) → row with `user_id = NULL`        |
| Register / log in    | `ui` → `POST /auth/login` → JWT stored in localStorage                   |
| Shorten, logged in   | `ui` → `POST /api/shorten` + `Bearer` → row with `user_id`               |
| History              | `ui` → `GET /api/links` + `Bearer` → that user's rows, newest first      |
| Someone opens a link | `GET /:code` → `UPDATE links SET clicks = clicks + 1 ... RETURNING` → 302 |

STEP 1
Create Docker Image for each service
docker build -t shorten-ui ./ui
docker build -t shorten-auth ./auth-server
docker build -t shorten-server ./short-server
docker images
        ↓
STEP 2
Run each Image as a Container
docker run -d --name shorten-ui-container -p 80:3000 shorten-ui
docker run -d --name shorten-auth-container -p 4000:4000 --env-file .\auth-server\.env shorten-auth    
docker run -d --name shorten-server-container -p 5000:5000 --env-file .\short-server\.env shorten-server

docker logs shorten-ui-container
        ↓
STEP 3
Connect Containers using Docker Network
docker network create shorten-network
docker network connect shorten-network shorten-ui-container 
docker network connect shorten-network shorten-auth-container 
docker network connect shorten-network shorten-server-container 

docker network ls
docker network rm ---------
        ↓
STEP 4
Apply Docker Compose

Instead of running:
docker build
docker run
docker network create
docker network connect

manually, Compose will manage:
3 services
   +
3 containers
   +
1 network
   +
ports
   +
environment files
        ↓
STEP 5
Verify complete applicationl