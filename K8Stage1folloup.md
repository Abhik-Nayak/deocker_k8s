# Stage 1 Follow-up — ShortenURL on local Kubernetes (kind)

Companion to [K8S_ROADMAP.md](K8S_ROADMAP.md) §1. The roadmap says *what* Stage 1
means; this file is the ordered list of things to actually do on this laptop,
with the repo-specific traps already identified.

Work top to bottom. Tick a box only when its **Done when** is true. Keep
[progress.md](progress.md) updated as you go — one concept per commit.

---

## 0. Before you start

### 0.1 Tooling — already verified on this machine

| Tool | Status |
| --- | --- |
| Docker | 29.7.2 |
| kind | 0.32.0 |
| kubectl | v1.36.1 (bundles Kustomize v5.8.1 — `kubectl apply -k` works, no separate binary) |
| Helm | v4.2.3 |
| minikube | not installed — **so this plan is kind-only**, as intended |

Nothing else to install yet. Calico *may* be needed at step 8.3 — see the
NetworkPolicy warning there.

### 0.2 Stage 0 gate

Do not start until you can draw the three request paths (register, shorten,
follow a short link) and say which service touches the database. Stage 1 is
mostly re-typing what you already understand; if you do not understand it yet,
you will be debugging two things at once.

The RDS instance is back (`shorten-url-db`, ap-south-1) and both `.env` files
point at it, so Stage 0 can be finished right now with `npm run dev`.

> **Cost note:** Stage 1 runs Postgres *in-cluster* and does not need RDS at all.
> Stop the instance while you work through this file — storage still bills, but
> the instance-hours stop. RDS auto-starts again after 7 days.

---

## 1. Fix the three blockers in the app code first

Do this **before** writing a single manifest. Every one of these will otherwise
be discovered halfway through step 7, when you have manifests to unpick as well.
Each is a small, self-contained commit.

### 1.1 Decision A — make the UI call relative paths

[ui/src/lib/api.js:1-2](ui/src/lib/api.js#L1-L2) reads `VITE_AUTH_URL` and
`VITE_SHORT_URL`, and Vite inlines them into the bundle at build time. That means
one image cannot serve two environments, and the browser talks to both backends
directly — which is why CORS is wide open on both.

Change both base URLs to `""` so every call is same-origin, and let the Ingress
route by path. The route prefixes already line up perfectly:

| Browser calls | Ingress sends to | Already the server's own prefix? |
| --- | --- | --- |
| `/auth/*` | `auth-server:4000` | yes — `APIRouter(prefix="/auth")` |
| `/api/*` | `short-server:5000` | yes — `app.use("/api", linksRouter)` |
| `/` | `ui:3000` | yes — nginx SPA root |

Because the prefixes already match, **you need no rewrite annotation** for these
three rules. Delete the two vars from `ui/.env.example`, or leave them documented
as dev-server-only.

- [ ] `api.js` uses relative paths; `npm run dev` still works end-to-end
  (add a Vite dev proxy in [ui/vite.config.js](ui/vite.config.js) so local dev
  keeps working without the Ingress)

### 1.2 Decision B — get `short-server` off the root path

[short-server/src/index.ts:22](short-server/src/index.ts#L22) mounts the redirect
router at `/`, so it answers `GET /:code` and collides with the UI under one
hostname.

Take the simple option: mount it at `/r`, so redirects become `GET /r/:code`.

Then `PUBLIC_BASE_URL` must match, because
[short-server/src/routes/links.ts](short-server/src/routes/links.ts) builds the
returned `shortUrl` as `${config.publicBaseUrl}/${link.code}`. In-cluster that
becomes `http://shorten.local/r`.

- [ ] redirect router mounted at `/r`; `PUBLIC_BASE_URL` updated in `.env` and
  `.env.example`; a shortened link still resolves locally

### 1.3 The TLS trap in `short-server` — you *will* hit this

[short-server/src/db/pool.ts:8-16](short-server/src/db/pool.ts#L8-L16) decides
TLS from the hostname:

```ts
const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
ssl: isLocal ? undefined : { rejectUnauthorized: false }
```

In-cluster the host is `postgres`, which is **not** `localhost`, so the client
demands TLS from a stock `postgres:17-alpine` that does not offer it. The
connection dies with *"The server does not support SSL connections"* — which
reaches you as a `CrashLoopBackOff` with a misleading message.

Drive it from the connection string instead:

```ts
const sslDisabled = url.searchParams.get("sslmode") === "disable";
ssl: sslDisabled ? undefined : { rejectUnauthorized: false }
```

Then in-cluster use `...@postgres:5432/shortenurl?sslmode=disable`, while the RDS
URL (no `sslmode`) keeps its TLS. `auth-server` needs no code change — psycopg
defaults to `sslmode=prefer` and falls back cleanly — just **drop the
`?sslmode=require`** from its in-cluster URL.

- [ ] `pool.ts` decides TLS from `sslmode`, not from the hostname

---

## 2. Cluster and images (roadmap 1.1)

### 2.1 Create the cluster

`k8s/kind-cluster.yaml` — the port mappings and the `ingress-ready` label must be
set at creation time; you cannot add them to a running cluster.

```yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
name: shorten
nodes:
  - role: control-plane
    kubeadmConfigPatches:
      - |
        kind: InitConfiguration
        nodeRegistration:
          kubeletExtraArgs:
            node-labels: "ingress-ready=true"
    extraPortMappings:
      - { containerPort: 80,  hostPort: 80,  protocol: TCP }
      - { containerPort: 443, hostPort: 443, protocol: TCP }
  - role: worker
  - role: worker
```

```bash
kind create cluster --config k8s/kind-cluster.yaml
kubectl config current-context      # expect kind-shorten
```

Two workers, so "which node did this Pod land on" becomes a real question later.
If port 80 is already taken on Windows, map `8080:80` / `8443:443` and use
`http://shorten.local:8080` throughout.

### 2.2 Build and load images

`:latest` plus `imagePullPolicy: IfNotPresent` means a rebuilt image is silently
*not* picked up — the node already has something called `:latest`. Tag by git SHA
from the start, so a rollout is a real change:

```bash
SHA=$(git rev-parse --short HEAD)
for s in ui auth-server short-server; do
  docker build -t shorten/$s:$SHA ./$s
  kind load docker-image shorten/$s:$SHA --name shorten
done
docker exec -it shorten-worker crictl images | grep shorten   # prove they landed
```

- [ ] one bare Pod created with `kubectl run`, inspected, deleted — then never again
- [ ] a Deployment per service, all three Running
- [ ] you have deliberately caused and recognised `ImagePullBackOff`,
  `CrashLoopBackOff`, `Pending` (unschedulable), and `OOMKilled`
- [ ] the debug loop is muscle memory: `describe`, `logs`, `logs --previous`,
  `exec -it`, `get events --sort-by=.lastTimestamp`

**Done when:** you can rebuild one service, load it, bump the tag, and watch only
that Deployment roll.

---

## 3. Services and cluster DNS (roadmap 1.2)

Names matter — they are what the Ingress and the ConfigMap will reference.

| Service | Port | Targets |
| --- | --- | --- |
| `ui` | 3000 | nginx — see [ui/nginx.conf](ui/nginx.conf), it listens on **3000**, not 80 |
| `auth-server` | 4000 | uvicorn |
| `short-server` | 5000 | express |
| `postgres` | 5432 | headless, from step 5 |

```bash
kubectl -n shorten-dev run tmp --rm -it --image=curlimages/curl --restart=Never -- \
  curl -s http://auth-server:4000/health
```

- [ ] ClusterIP per service; `/health` reachable by DNS name from another Pod
- [ ] NodePort tried once, `port-forward` tried once, and you can say why neither
  is the answer for real traffic

---

## 4. Config and Secrets (roadmap 1.3)

The shared-secret coupling is the whole point of this step. `auth-server` signs
the JWT and `short-server` verifies it locally — there is no service-to-service
call, so a mismatch fails *silently* on every logged-in request.

- **ConfigMap** `shorten-config`: `PORT`, `PUBLIC_BASE_URL`
  (`http://shorten.local/r`), `JWT_EXPIRES_MINUTES`.
- **Secret** `shorten-secrets`: **one** `JWT_SECRET` consumed by *both* backends,
  plus `DATABASE_URL`. Remember the two URLs differ by the `sslmode` param from
  step 1.3.

Prefer `envFrom` with `configMapRef` / `secretRef` over listing every key by hand.

- [ ] both backends read `JWT_SECRET` from the same Secret key
- [ ] `kubectl get secret shorten-secrets -o jsonpath='{.data.JWT_SECRET}' | base64 -d`
  — you have seen for yourself that a Secret is encoding, not encryption
- [ ] you have written down where that gets solved in Stage 2 (Secrets Manager /
  External Secrets / IRSA)

---

## 5. Postgres StatefulSet and storage (roadmap 1.4)

Headless Service + `volumeClaimTemplate`. Stable network identity means the Pod is
reachable as `postgres-0.postgres`, though the plain `postgres` Service name is
fine for a single replica.

Two things to get right:

1. Set `PGDATA=/var/lib/postgresql/data/pgdata` — a subdirectory of the mount, not
   the mount itself. On other volume types `initdb` refuses a non-empty directory,
   and the habit costs you nothing here.
2. Set `POSTGRES_DB=shortenurl` so the database matches the `DATABASE_URL` from
   step 4.

No migration step is needed: both services run `CREATE TABLE IF NOT EXISTS` from
their own `schema.sql` at startup (`links` for short, `users` for auth).

kind's default StorageClass is `standard` (rancher local-path) with
`WaitForFirstConsumer`, so the PV is created on **one specific node**. Delete that
node and the data is gone — worth noticing, because it is exactly the property
that makes RDS the Stage 2 answer.

```bash
kubectl -n shorten-dev delete pod postgres-0                       # data survives
kubectl -n shorten-dev delete pvc data-postgres-0                  # it does not
```

- [ ] Postgres runs as a StatefulSet with a PVC from a `volumeClaimTemplate`
- [ ] data survives Pod deletion; you have watched it *not* survive PVC deletion
- [ ] you can explain why a Deployment is the wrong shape for a database

---

## 6. Health, resources, self-healing (roadmap 1.5)

Both backends **exit when the database is unreachable** — `short-server` calls
`process.exit(1)` after 3 retries, and `auth-server`'s lifespan `pool.open()`
raises and kills uvicorn. So on a fresh apply they crash-loop until Postgres is
Ready. That is the lesson, not a bug.

- Probe `/health` on both backends; probe `/` on the UI (nginx has no health
  endpoint — either accept `/` or add one).
- Add a `startupProbe` so a slow first DB connect does not trip the liveness probe
  and restart a Pod that was merely still starting.
- Try both answers to the crash-loop and compare: an `initContainer` that waits for
  Postgres, versus letting Kubernetes restart until it settles.

- [ ] readiness + liveness on all three; startupProbe where the DB connect is slow
- [ ] `requests` and `limits` everywhere; one limit set too low on purpose and
  `OOMKilled` observed
- [ ] `short-server` scaled to 3 replicas, redirects still correct — it is
  stateless, since click counts go to the DB, not to memory
- [ ] HPA on CPU, load generated, scale-up watched
- [ ] `RollingUpdate` with `maxUnavailable: 0` plus a PodDisruptionBudget; a bad
  image rolled out, the rollout observed stalling, then `kubectl rollout undo`

---

## 7. Ingress and TLS (roadmap 1.6)

Steps 1.1 and 1.2 already made this easy — one host, four rules, no rewrites.

```bash
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml
kubectl -n ingress-nginx wait --for=condition=Ready pod \
  -l app.kubernetes.io/component=controller --timeout=180s
```

Pin that URL to a release tag rather than `main` once it works, so a re-create is
reproducible.

Add to `C:\Windows\System32\drivers\etc\hosts` (as Administrator):

```
127.0.0.1 shorten.local
```

Routing table for the single Ingress on `shorten.local`:

| Path | pathType | Backend |
| --- | --- | --- |
| `/auth` | Prefix | `auth-server:4000` |
| `/api` | Prefix | `short-server:5000` |
| `/r` | Prefix | `short-server:5000` |
| `/` | Prefix | `ui:3000` |

- [ ] all four rules work from the browser: register → shorten → history →
  follow the short link, all on `http://shorten.local`
- [ ] you can state the difference between `Prefix` and `ImplementationSpecific`
- [ ] one `rewrite-target` annotation tried and understood — then removed, because
  this layout does not need it
- [ ] a self-signed cert in a `tls` Secret; `https://shorten.local` serves it
- [ ] CORS tightened now that everything is same-origin (`allow_origins=["*"]` in
  [auth-server/app/main.py](auth-server/app/main.py) and the bare `cors()` in
  [short-server/src/index.ts](short-server/src/index.ts) are no longer needed)

---

## 8. Security and isolation (roadmap 1.7)

### 8.1 Namespace and quota

- [ ] everything in `shorten-dev`, nothing in `default`
- [ ] a `ResourceQuota` and a `LimitRange` that actually reject an over-large Pod

### 8.2 Non-root containers

All three images run as root today. Expect roughly two lines per Dockerfile, plus a
`securityContext` with `runAsNonRoot: true`, `readOnlyRootFilesystem: true`,
`allowPrivilegeEscalation: false`, and `capabilities: { drop: [ALL] }`.

- `short-server` — `node:20-alpine` already ships a `node` user; add `USER node`
  and make sure `/app` is owned by it.
- `auth-server` — add a user in the Dockerfile and `USER` it. Note this image is
  `python:3.9-slim` while the requirements are modern; bumping it is a fair
  side-quest, not a requirement.
- `ui` — the hard one. Stock `nginx:alpine` wants to write to `/var/cache/nginx`
  and `/var/run`. Either switch to `nginxinc/nginx-unprivileged` (adjust
  [ui/nginx.conf](ui/nginx.conf) — it defaults to 8080) or mount `emptyDir`s over
  those two paths. Port 3000 is above 1024, so binding is not the problem;
  writable paths are.

- [ ] all three run as non-root with a read-only root filesystem

### 8.3 NetworkPolicy — verify enforcement before you trust it

Default-deny in the namespace, then allow exactly:
`ingress-nginx → ui/auth/short`, and `auth/short → postgres:5432`.

**Check that your CNI actually enforces policy.** A policy that is accepted but
ignored is worse than no policy — you would "prove" an isolation that does not
exist. Apply default-deny, then:

```bash
kubectl -n shorten-dev exec -it deploy/ui -- nc -zv postgres 5432   # must FAIL
```

If it still connects, kindnet is not enforcing. Recreate the cluster with
`networking.disableDefaultCNI: true` in `kind-cluster.yaml`, install Calico, and
re-test.

- [ ] default-deny in force **and empirically verified** from the UI Pod
- [ ] auth and short can still reach Postgres; the UI cannot

### 8.4 RBAC

- [ ] a dedicated ServiceAccount per service with
  `automountServiceAccountToken: false`
- [ ] one small Role / RoleBinding exercise, so RBAC is not a mystery in Stage 2

---

## 9. Package it (roadmap 1.8)

Use **Kustomize** — `kubectl` already bundles v5.8.1, so `kubectl apply -k` needs
no new binary, and overlays map cleanly onto the four things that vary. Helm stays
in the picture for Stage 3, where you *install* third-party charts
(kube-prometheus-stack) rather than author your own.

```
k8s/
  kind-cluster.yaml
  base/           namespace, configmap, secret, deployments, services,
                  ingress, postgres statefulset, networkpolicies, rbac
  overlays/dev/   local image tags, 1 replica, in-cluster postgres
  overlays/prod/  ECR images, HPA, RDS endpoint, real TLS   # Stage 2 consumes this
```

The four values that differ per environment: **image tag, replica count, hostname,
and whether Postgres is in-cluster or external.**

- [ ] `kubectl apply -k k8s/overlays/dev` brings up everything
- [ ] `kubectl kustomize k8s/overlays/prod` renders sensibly, even though nothing
  runs it yet

---

## 10. Stage 1 definition of done

Delete the cluster and rebuild from scratch. If that does not work, the repo is
incomplete — which is the actual point of the exercise.

```bash
kind delete cluster --name shorten
kind create cluster --config k8s/kind-cluster.yaml
# reinstall ingress-nginx, reload images, apply -k
```

- [ ] one apply against a fresh cluster brings the whole app up healthy
- [ ] a single hostname serves UI, API and redirects
- [ ] deleting any application Pod is invisible to the user
- [ ] a default-deny NetworkPolicy is in force **and proven**
- [ ] you can explain every field you typed

---

## Repo-specific traps, in one place

| # | Trap | Where | Fix |
| --- | --- | --- | --- |
| 1 | UI API URLs baked in at build time | [ui/src/lib/api.js:1-2](ui/src/lib/api.js#L1-L2) | relative paths (step 1.1) |
| 2 | `short-server` owns `/`, collides with the UI | [short-server/src/index.ts:22](short-server/src/index.ts#L22) | mount at `/r` (step 1.2) |
| 3 | TLS forced for any non-`localhost` host | [short-server/src/db/pool.ts:8-16](short-server/src/db/pool.ts#L8-L16) | drive it from `sslmode` (step 1.3) |
| 4 | `JWT_SECRET` mismatch fails silently | both backends | one Secret, both Pods (step 4) |
| 5 | Both backends exit if the DB is down at boot | `index.ts`, `main.py` | startupProbe / initContainer (step 6) |
| 6 | nginx listens on **3000**, not 80 | [ui/nginx.conf](ui/nginx.conf) | Service `targetPort: 3000` |
| 7 | All three images run as root | all three Dockerfiles | step 8.2 |
| 8 | kindnet may ignore NetworkPolicy | cluster | verify, else Calico (step 8.3) |
