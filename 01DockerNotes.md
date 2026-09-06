# ShortenURL — Architecture & Docker Notes

How this app is put together, and how the same thing looks once it runs in
Docker: images, containers, networks, DNS, ports and env vars.

---

## 1. The app: three services + one database

| Service        | Stack                              | Listens on | Owns table |
| -------------- | ---------------------------------- | ---------- | ---------- |
| `ui`           | React + Vite (built → nginx)       | 3000       | —          |
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

---

# PART 2 — Dockerizing the app

The path taken, in order. Each step exists to expose the limitation that the
next step solves.

```
STEP 1  build images
   ↓
STEP 2  run containers (isolated — they can't see each other)
   ↓
STEP 3  create a network (now they can, by name)
   ↓
STEP 4  replace all of the above with one Compose file
   ↓
STEP 5  verify  ✅ DONE
```

---

## STEP 1 — Build an image for each service

```bash
docker build -t shorten-ui ./ui
docker build -t shorten-auth ./auth-server
docker build -t shorten-server ./short-server

docker images
```

`-t` = tag (the name). The final argument is the **build context** — the folder
Docker uploads to the daemon. Everything in `.dockerignore` is excluded from
that upload, which is why `node_modules` and `.venv` never bloat the build.

### What each Dockerfile does

**`ui/Dockerfile` — two stages, because React output is just static files**

```dockerfile
FROM node:20-alpine AS build        # stage 1: needs node, npm, source
WORKDIR /app
COPY package*.json ./
RUN npm ci --legacy-peer-deps
COPY . .
RUN npm run build                   # produces /app/dist

FROM nginx:alpine                   # stage 2: needs neither
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 3000
CMD ["nginx", "-g", "daemon off;"]
```

Stage 2 starts from a clean `nginx:alpine` and copies **only** `dist/` across.
Node, npm and `node_modules` are left behind in stage 1 and never ship.

> ⚠️ `nginx.conf` is not optional here. Stock nginx listens on **80**. The
> custom conf makes it listen on **3000** so it matches `EXPOSE 3000` and the
> Compose port mapping. Remove the conf and you must remove the 3000 mapping
> too, or the container will be unreachable.

**`short-server/Dockerfile` — two stages, TypeScript needs compiling**

```dockerfile
FROM node:20-alpine AS builder
...
RUN npm run build                   # tsc → /app/dist

FROM node:20-alpine
RUN npm ci --omit=dev               # prod deps only, no typescript
COPY --from=builder /app/dist ./dist
CMD ["node", "dist/index.js"]
```

`--omit=dev` in stage 2 is the payoff — TypeScript and the type packages exist
only in the builder.

**`auth-server/Dockerfile` — single stage; Python has no build artifact**

```dockerfile
FROM python:3.9-slim AS builder
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 4000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "4000"]
```

> ⚠️ `AS builder` here is a leftover label — there is no second stage and no
> `COPY --from`. Harmless, but it is a single-stage build wearing a multi-stage
> name. Either drop `AS builder` or finish the split.

> `--host 0.0.0.0` is **required**. Bound to `127.0.0.1` the server would only
> accept connections from inside its own container, and the published port
> would appear dead from the host.

---

## STEP 2 — Run each image as a container

```bash
docker run -d --name shorten-ui-container     -p 80:3000   shorten-ui
docker run -d --name shorten-auth-container   -p 4000:4000 --env-file ./auth-server/.env shorten-auth
docker run -d --name shorten-server-container -p 5000:5000 --env-file ./short-server/.env shorten-server

docker ps
docker logs shorten-ui-container
```

| Flag         | Meaning                                                  |
| ------------ | -------------------------------------------------------- |
| `-d`         | detached — run in background                             |
| `--name`     | stable name, so you do not chase container IDs           |
| `-p 80:3000` | **host port 80** → **container port 3000**               |
| `--env-file` | inject secrets at run time (never bake them into images) |

**Port direction is the thing people get backwards.** `-p HOST:CONTAINER`.
`80:3000` means: browse to `localhost:80`, Docker forwards to nginx on 3000
inside. The container port must match what the process actually listens on.

**The limitation this step exposes:** these three containers sit on the default
bridge network with no name resolution between them. `shorten-server-container`
cannot resolve `auth-server`. They are isolated.

---

## STEP 3 — Connect them with a user-defined network

```bash
docker network create shorten-network

docker network connect shorten-network shorten-ui-container
docker network connect shorten-network shorten-auth-container
docker network connect shorten-network shorten-server-container

docker network ls
docker network inspect shorten-network
```

A **user-defined bridge network** gives you an embedded DNS server. Containers
on it resolve each other **by container name** — `auth-server` becomes a real
hostname, no IPs, no `--link`. The default `bridge` network does *not* do this;
that is the whole reason to create your own.

### The part that surprises people in this app

The `ui` container gains DNS on this network — **and never uses it.**

```js
// ui/src/lib/api.js
const AUTH_URL  = import.meta.env.VITE_AUTH_URL  ?? "http://localhost:4000";
const SHORT_URL = import.meta.env.VITE_SHORT_URL ?? "http://localhost:5000";
```

The UI is a **static bundle executing in your browser**, not in the container.
nginx only hands the files over. So `localhost:4000` resolves on **your
laptop**, and the request reaches `auth-server` through the published port
`-p 4000:4000` — never through `shorten-network`.

Container DNS only matters for **server-to-server** calls. This app has none
(the JWT is verified locally), so the network here is real but effectively
unused. Worth knowing exactly why — it is a favourite interview trap.

---

## STEP 4 — Replace all of it with Docker Compose

Steps 1–3 were four command types run nine times, in the right order, by hand.
Compose declares the same thing once.

```
docker build          ─┐
docker run             ├──▶  one docker-compose.yaml
docker network create  │
docker network connect ─┘
```

Compose manages: **3 services + 3 containers + 1 network + ports + env files**.

### First, tear down the manual containers

```bash
docker stop shorten-ui-container shorten-auth-container shorten-server-container
docker rm   shorten-ui-container shorten-auth-container shorten-server-container
docker network rm shorten-network

# verify it is clean
docker ps -a
docker network ls
```

Nothing may hold ports 80 / 4000 / 5000 or Compose will fail to bind.

### `docker-compose.yaml`

```yaml
services:

  ui:
    build:
      context: ./ui
    container_name: shortener-ui-container
    ports:
      - "80:3000"
    depends_on:
      - auth-server
      - short-server
    networks:
      - shorten-network

  auth-server:
    build:
      context: ./auth-server
    container_name: shortener-auth-container
    ports:
      - "4000:4000"
    env_file:
      - ./auth-server/.env
    networks:
      - shorten-network

  short-server:
    build:
      context: ./short-server
    container_name: shortener-short-container
    ports:
      - "5000:5000"
    env_file:
      - ./short-server/.env
    networks:
      - shorten-network

networks:
  shorten-network:
    driver: bridge
```

### How the YAML maps back to the manual commands

| Compose key       | Replaces                             |
| ----------------- | ------------------------------------ |
| `build.context`   | `docker build -t <name> ./dir`       |
| `container_name`  | `--name`                             |
| `ports`           | `-p HOST:CONTAINER`                  |
| `env_file`        | `--env-file`                         |
| `networks`        | `network create` + `network connect` |
| `depends_on`      | doing it in the right order manually |

**The service key is the DNS name.** `auth-server`, `short-server` and `ui` are
resolvable hostnames on `shorten-network` regardless of `container_name`.

> ⚠️ `depends_on` controls **start order only** — not readiness. It waits for
> the container to *start*, not for uvicorn to accept connections. For real
> ordering you need `healthcheck` + `depends_on: condition: service_healthy`.
> It is tolerable here only because the UI is static and nothing calls the APIs
> at boot.

### Run it

```bash
docker compose up -d --build     # build + create network + start all three
docker compose ps
docker compose logs -f
docker compose logs -f auth-server
docker compose down              # stop + remove containers AND the network
```

`--build` matters — without it Compose reuses whatever image already exists and
your code changes silently do not ship.

---

## STEP 5 — Verify the full application ✅

```bash
docker compose ps
```

```
NAME                        IMAGE                     STATUS         PORTS
shortener-ui-container      deocker_k8s-ui            Up 3 minutes   0.0.0.0:80->3000/tcp
shortener-auth-container    deocker_k8s-auth-server   Up 3 minutes   0.0.0.0:4000->4000/tcp
shortener-short-container   deocker_k8s-short-server  Up 3 minutes   0.0.0.0:5000->5000/tcp
```

Compose auto-named the images `<project>-<service>` from the folder name
(`deocker_k8s`), because no `image:` key was set.

### Functional checklist

| # | Check                | How                                             | Expected                    |
| - | -------------------- | ----------------------------------------------- | --------------------------- |
| 1 | UI loads             | open `http://localhost`                         | React app renders           |
| 2 | Auth is up           | `curl http://localhost:4000/docs`               | FastAPI Swagger page        |
| 3 | Shortener is up      | `curl http://localhost:5000/`                   | Express responds            |
| 4 | Shorten, logged out  | paste a URL, submit                             | short code returned         |
| 5 | Redirect works       | open the short link                             | 302 → original, clicks +1   |
| 6 | Register / log in    | sign up in the UI                               | JWT in localStorage         |
| 7 | **JWT crosses**      | shorten while logged in, then open History      | link appears ← *key test*   |
| 8 | DB persists          | `docker compose restart`, reload History        | rows still there (Supabase) |

**Check 7 is the one that matters.** It proves `auth-server` signed a token that
`short-server` independently verified — i.e. both `JWT_SECRET` values match. If
History comes back empty while shortening still works, the secrets have drifted.

### Container-level verification

```bash
docker compose ps                                   # all three Up
docker network inspect deocker_k8s_shorten-network  # all three attached
docker compose exec auth-server env | grep JWT      # secret actually injected
docker compose logs --tail=50 short-server          # no crash loops
```

> Compose prefixes the network with the project name → `deocker_k8s_shorten-network`.

**Status: verified ✅ — all three services build, start, network and reach Supabase.**

---
---

# PART 3 — Docker interview prep (the 80/20)

Everything below is the ~20% of Docker that answers ~80% of interview questions.

---

## A. Mental model — answer these in one line each

| Question                     | Answer                                                                     |
| ---------------------------- | -------------------------------------------------------------------------- |
| Image vs container?          | Image = read-only template. Container = running instance + writable layer.  |
| Why are images layered?      | Each instruction = one cached, shareable layer. Cache = build speed.        |
| Docker vs VM?                | Containers share the host kernel; VMs each boot their own. MBs vs GBs.      |
| `CMD` vs `ENTRYPOINT`?       | ENTRYPOINT = the binary. CMD = default args, overridable at `docker run`.   |
| `COPY` vs `ADD`?             | Use `COPY`. `ADD` also untars and fetches URLs — implicit, avoid it.        |
| `EXPOSE` vs `-p`?            | EXPOSE = documentation. `-p` actually publishes the port. **Only -p works.**|
| Why multi-stage?             | Build tools stay in the builder; the final image ships only the artifact.   |
| Why does a container exit?   | PID 1 finished. Containers live exactly as long as their foreground process.|
| `docker stop` vs `kill`?     | stop = SIGTERM then SIGKILL after 10s (graceful). kill = SIGKILL now.       |
| Where does data go on `rm`?  | Gone — the writable layer dies with the container. Use volumes to persist.  |

---

## B. Commands that actually come up

### Images

```bash
docker build -t app:v1 .              # build (tag it — never rely on :latest)
docker build --no-cache -t app:v1 .   # ignore layer cache
docker images                         # list
docker rmi <image>                    # remove
docker history <image>                # per-layer size — find the fat layer
docker tag app:v1 repo/app:v1         # retag before push
docker push repo/app:v1
docker pull python:3.9-slim
docker save -o app.tar app:v1         # export (airgapped transfer)
docker load -i app.tar
```

### Containers

```bash
docker run -d --name api -p 8080:80 app:v1
docker run -it --rm alpine sh          # throwaway interactive shell
docker ps                              # running
docker ps -a                           # including dead ones ← for exit codes
docker logs -f --tail=100 api          # THE first debug command
docker exec -it api sh                 # shell into a RUNNING container
docker inspect api                     # full JSON: mounts, env, IP, exit code
docker stats                           # live CPU / memory
docker top api                         # processes inside
docker port api                        # actual port mappings
docker cp api:/app/log.txt ./          # pull a file out
docker stop api && docker rm api
docker restart api
docker diff api                        # what changed vs the image
```

### Compose

```bash
docker compose up -d --build
docker compose down                    # containers + network
docker compose down -v                 # ...AND volumes (destroys data)
docker compose ps
docker compose logs -f <service>
docker compose exec <service> sh
docker compose restart <service>
docker compose build --no-cache <service>
docker compose config                  # render merged YAML — validates syntax
docker compose up -d --scale worker=3
```

### Networks & volumes

```bash
docker network ls
docker network create mynet
docker network inspect mynet           # who is attached, what IPs
docker network connect mynet api

docker volume ls
docker volume create pgdata
docker volume inspect pgdata
docker run -v pgdata:/var/lib/postgresql/data postgres   # named volume
docker run -v $(pwd):/app node                           # bind mount (dev)
```

### Cleanup (the disk-full answer)

```bash
docker system df                       # what is eating disk
docker system prune                    # dangling images, stopped containers
docker system prune -a --volumes       # ☠️ everything unused, volumes too
docker builder prune                   # BuildKit cache — usually the real hog
```

---

## C. Debugging: the 80/20 flowchart

> **Order of operations, always:**
> `docker ps -a` → `docker logs` → `docker inspect` → `docker exec`

### Symptom 1 — container exits immediately

```bash
docker ps -a                    # read the exit code
docker logs <container>         # read the actual error
```

| Exit code | Meaning                                                       |
| --------- | ------------------------------------------------------------- |
| `0`       | Process finished normally — your CMD was not long-running      |
| `1`       | App error — the reason is in the logs                          |
| `125`     | Docker daemon itself rejected the run (bad flag)               |
| `126`     | Command found but not executable (missing `chmod +x`)          |
| `127`     | Command **not found** — wrong path, or missing in a slim image |
| `137`     | **SIGKILL — almost always OOM.** Raise the memory limit        |
| `143`     | SIGTERM — stopped normally                                     |

Causes, most common first:

1. **CMD is not a foreground process.** `nginx` daemonizes and exits → you need
   `nginx -g "daemon off;"`. Same class of bug as `CMD ["npm","run","build"]`.
2. Crash on boot — missing env var, DB unreachable.
3. `137` → memory limit.

**Cannot read logs because it dies too fast?** Override the entrypoint and look
around by hand:

```bash
docker run -it --rm --entrypoint sh app:v1
ls -la /app          # is the artifact even there?
```

### Symptom 2 — running, but I cannot reach it

Check in this order:

1. **Is the port published?** `docker ps` — no `0.0.0.0:X->Y` means no `-p`.
2. **Is the app bound to `0.0.0.0`?** ← *the #1 cause.* Bound to `127.0.0.1`
   it only accepts traffic from inside its own container. This is why
   `auth-server` runs `uvicorn --host 0.0.0.0`.
3. **Do the ports line up?** `-p 80:3000` requires the process to listen on
   3000. Ours does — via `nginx.conf`.
4. **Prove it from inside:** `docker exec -it api sh` → `wget -qO- localhost:3000`.
   Works inside but not outside ⇒ mapping/binding problem. Fails inside too ⇒
   the app is broken, not Docker.

### Symptom 3 — container A cannot reach container B

1. **Same network?** `docker network inspect <net>` — both listed?
2. **Using the service name, not `localhost`?** Inside a container `localhost`
   is *that container*. Use `http://auth-server:4000`.
3. **Container port, not host port.** Inside the network you talk to 4000
   directly; the host mapping is irrelevant.
4. Test it: `docker compose exec ui ping auth-server`.
5. **Default bridge has no DNS.** Name resolution only works on user-defined
   networks — that is why we created `shorten-network`.

### Symptom 4 — my code change did not appear

- Forgot `--build`: `docker compose up -d --build`.
- Layer cache served a stale `COPY`: `docker compose build --no-cache <svc>`.
- `.dockerignore` is excluding the file you changed.
- You rebuilt the image but never recreated the container.

### Symptom 5 — build fails pulling the base image

```
dial tcp: lookup registry-1.docker.io: no such host
```

That is **DNS**, not your Dockerfile. Restart Docker Desktop (re-syncs DNS from
the host — fixes most cases, common after a VPN connect/disconnect). If it
recurs, pin resolvers in `daemon.json`:

```json
{ "dns": ["8.8.8.8", "1.1.1.1"] }
```

*(Hit exactly this on this project. The Dockerfile was fine.)*

### Symptom 6 — image is enormous

```bash
docker history <image>     # find the fat layer
```

- Use `-slim` / `-alpine` bases.
- Multi-stage: ship the artifact, not the toolchain.
- `npm ci --omit=dev` in the final stage.
- One `RUN` chain, cleaning up in the same layer — deleting a file in a *later*
  layer does not shrink the image; the bytes are already committed.
- A real `.dockerignore`.

### Symptom 7 — data vanished after restart

The writable layer is destroyed with the container. Named volume or bind mount,
or it is not persistent. *(Not an issue here — Supabase is external, which is
itself the cleanest answer to "how do you handle state?")*

---

## D. Scenario questions — answered from this project

**"Walk me through a Dockerfile you wrote."**
> `short-server` is multi-stage. Stage 1 on `node:20-alpine` installs all deps
> and runs `tsc`. Stage 2 starts clean, runs `npm ci --omit=dev`, and copies
> only `dist/` from the builder. TypeScript never ships. I copy `package*.json`
> before the source so the dependency layer stays cached when only code changes.

**"Why is `COPY package.json` before `COPY . .`?"**
> Layer caching. Dependencies change rarely, source changes constantly. In that
> order, a code edit invalidates only the last layers and `npm ci` is reused.
> Reversed, every one-character change reinstalls everything.

**"Your container is running but the site will not load. Debug it."**
> `docker ps` for the port mapping, `docker logs` for a crash, then
> `docker exec` in and curl `localhost:<container-port>`. If it answers inside
> but not outside, it is the mapping or the app is bound to `127.0.0.1` instead
> of `0.0.0.0`. That last one is the most common.

**"How do services find each other?"**
> User-defined bridge network — Compose's embedded DNS resolves service names.
> `short-server` would reach auth at `http://auth-server:4000`. Notably my UI
> *does not* use it: it is a static bundle running in the browser, so its
> `localhost:4000` resolves on the host and arrives via the published port.

**"How do you handle secrets?"**
> `env_file` at runtime, never `ENV` in the Dockerfile — anything baked in is
> visible forever via `docker history`. `.env` is gitignored. For production:
> Docker/Kubernetes secrets or a vault, injected at deploy time.

**"`depends_on` guarantees my DB is ready, right?"**
> No — it only orders *starting*. The DB container can be up while Postgres is
> still initialising. You need a `healthcheck` plus
> `depends_on: condition: service_healthy`, and the app should retry anyway.

**"Container gets killed under load. Why?"**
> Exit 137 = SIGKILL, effectively always OOM. Confirm with
> `docker inspect <c> | grep OOMKilled`. Raise the limit or fix the leak;
> `docker stats` shows the trend.

**"How would you take this to production?"**
> Pin base images by digest, not `:latest`. Add `HEALTHCHECK` to each service.
> Run as a non-root `USER`. Real tags (`app:1.4.2`) so rollback is possible.
> Push to a registry and build in CI, not on a laptop. Then Compose stops being
> enough — no self-healing, no rolling updates, single host — which is the
> argument for Kubernetes.

**"What is wrong with `:latest`?"**
> It is not a version, it is a moving pointer. Two machines pulling `:latest` a
> week apart get different code, and you cannot roll back to a tag that means
> something different now.

---

## E. Five-second recall list

```
docker ps -a            # what is dead, and its exit code
docker logs -f <c>      # why it died
docker exec -it <c> sh  # get inside and look
docker inspect <c>      # env, mounts, IP, OOMKilled
docker compose up -d --build
docker compose down
docker system prune -a
```

**137 = OOM · 127 = command not found · 0 = your CMD was not long-running**

**Bind to `0.0.0.0`, never `127.0.0.1` · `-p HOST:CONTAINER` · service name, not `localhost`**
