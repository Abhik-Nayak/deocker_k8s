# Stage 1 Follow-up — ShortenURL on local Kubernetes (kind)

A do-it-yourself walkthrough of [K8S_ROADMAP.md](K8S_ROADMAP.md) §1, written for
someone meeting most of these objects for the first time.

The roadmap says *what* Stage 1 means. This file is the ordered list of things to
actually type on this laptop, **plus the concept behind each one**, plus the
traps that are specific to this repo.

---

## How to use this document

- **Work top to bottom.** Later parts assume the earlier ones are done.
- **Read the "Concept" box before running the commands in a part.** The commands
  will make sense; without it you are copy-pasting.
- **Tick a box only when its check actually passes.** Not when you ran the command.
- **Type the YAML by hand at least once.** Generated YAML you did not type is
  YAML you cannot debug. This is the roadmap's ground rule and it is the single
  highest-value habit in Stage 1.
- **One concept per commit.** Update [progress.md](progress.md) as you go.

### Shell note — you are on PowerShell

All `kubectl`, `docker`, `kind` and `helm` commands are identical in every shell.
Only the shell *plumbing* differs. Commands in this document are written for
**PowerShell**.

| Task | PowerShell | Git Bash |
| --- | --- | --- |
| Set a variable | `$SHA = git rev-parse --short HEAD` | `SHA=$(git rev-parse --short HEAD)` |
| Use a variable | `"shorten/ui:$SHA"` | `shorten/ui:$SHA` |
| Filter output | `... \| Select-String shorten` | `... \| grep shorten` |
| Last 20 lines | `... \| Select-Object -Last 20` | `... \| tail -20` |
| Line continuation | backtick `` ` `` | backslash `\` |

A variable like `$SHA` only exists in the terminal window where you set it.
Open a new terminal and you must set it again.

> **Tip:** VS Code can open a Git Bash terminal (`Ctrl+Shift+ö` → dropdown → Git
> Bash). If you prefer bash, everything still works — just use the right column.

---

## Where you are right now

| | Status |
| --- | --- |
| Part 1 — three app code fixes | ✅ done, committed (`630f962`, `feddc9b`, `2709732`) |
| Part 2.1 — kind cluster `shorten` | ✅ 3 nodes Ready, Kubernetes v1.36.1 |
| Part 2.2 — namespace `shorten-dev` | ✅ created, set as context default |
| Part 2.3 — images built and loaded | ✅ all three at `2709732`, on both workers |
| Part 2.4 — one bare Pod | ✅ created, deleted, stayed dead |
| Part 2.5 — `ui` Deployment | ✅ pod deleted, replacement appeared |
| Part 2.6 — backends crash on purpose | ✅ `CrashLoopBackOff` caused and diagnosed |
| Part 2.7 — Secret wiring | ✅ all four Pods Running, DB connected |
| Part 2.8 — other three failure modes | ✅ all four signatures caused and read |
| Part 2.9 — debug loop | ✅ used to diagnose a real failure end to end |
| Part 3 — Services and cluster DNS | ✅ three ClusterIP Services, DNS verified |
| Part 4 — ConfigMap + Secret properly | ✅ all five env vars injected |
| Part 5 — Postgres StatefulSet | ✅ done early, out of order — see 2.7 |
| Part 6 — probes, resources, scaling | ✅ bad deploy stalled, site stayed up |
| Part 7 — Ingress and TLS | ✅ HTTPS, auto 308 redirect from HTTP |
| Part 8 — security and isolation | ✅ non-root, default-deny, RBAC — all verified |
| Part 9 — Kustomize | ✅ base + components + dev/prod overlays |
| Part 10 — rebuild from repo | ✅ cluster destroyed and rebuilt, all checks pass |
| **Stage 1** | ✅ **COMPLETE — nothing committed yet** |

> Part 2 was reset and redone from scratch on 2026-09-12.
>
> **RDS is gone.** The instance `shorten-url-db` and its security group
> `sg-012bbd17304a994bf` were deleted on 2026-09-12, no final snapshot. The app
> now runs entirely on in-cluster Postgres. Stage 2 will create a fresh RDS
> inside a VPC, where home-IP whitelisting does not apply.

---

# Part 0 — Orientation

Skip nothing here. Ten minutes now saves hours of confused debugging later.

## 0.1 What Kubernetes actually is

One idea, repeated everywhere:

> **You write down the state you want. Controllers keep comparing reality to that
> and fixing the difference. Forever.**

That is it. That is the whole system.

When you run `kubectl apply -f deployment.yaml`, you are **not** telling
Kubernetes "start a container". You are telling it *"from now on, 3 copies of this
should exist"* and then leaving. A controller notices there are 0, creates 3, and
keeps checking. Kill one and it makes another — not because you asked, but
because reality stopped matching your declaration.

This is why:

- `kubectl delete pod` on a Deployment-managed Pod does not delete anything
  permanently. The controller notices and recreates.
- There is no "restart" command. You change the desired state and the system
  converges.
- Almost every problem is answered by **"what is the desired state, what is the
  actual state, and what is the controller complaining about?"**

## 0.2 The objects, in the order you will meet them

```
        ┌──────────── Ingress ────────────┐        HTTP router at the edge
        │  /  /auth  /api  /r             │        (needs an Ingress Controller)
        └───┬──────┬───────┬──────────────┘
            │      │       │
        ┌───▼──┐┌──▼───┐┌──▼────┐                  stable name + IP
        │ Svc  ││ Svc  ││ Svc   │   Service        selects Pods BY LABEL
        │  ui  ││ auth ││ short │
        └───┬──┘└──┬───┘└──┬────┘
            │      │       │
        ┌───▼──┐┌──▼───┐┌──▼────┐
        │Deploy││Deploy││Deploy │   Deployment     rolling updates + rollback
        └───┬──┘└──┬───┘└──┬────┘        │
            │      │       │             └── creates ReplicaSet ── keeps N Pods alive
        ┌───▼──┐┌──▼───┐┌──▼────┐
        │ Pod  ││ Pod  ││ Pod   │   Pod            the actual running container(s)
        └──────┘└──┬───┘└──┬────┘
                   │       │
                   └───┬───┘
                  ┌────▼─────┐
                  │StatefulSet│  Postgres          stable identity + own storage
                  │  + PVC    │
                  └───────────┘

  ConfigMap ─┐
             ├──→ injected into Pods as environment variables
  Secret ────┘
```

Short definitions — come back to these:

| Object | What it is | Why it exists |
| --- | --- | --- |
| **Pod** | One or more containers sharing a network namespace and storage | The smallest thing Kubernetes can schedule. Containers in a Pod reach each other on `localhost` |
| **ReplicaSet** | Keeps exactly N identical Pods alive | You never create one by hand — a Deployment makes it |
| **Deployment** | Manages ReplicaSets over time | Gives you rolling updates, rollout history, and `rollout undo` |
| **Service** | A stable name and IP in front of a changing set of Pods | Pods die and get new IPs constantly. You cannot hardcode a Pod IP |
| **Ingress** | HTTP routing rules (host + path → Service) | One public entrypoint instead of exposing every service |
| **ConfigMap** | Non-secret key/value config | Keeps config out of the image, so one image serves every environment |
| **Secret** | Same, but base64-encoded and handled more carefully | **Encoding, not encryption** — see Part 4 |
| **StatefulSet** | Like a Deployment, but each Pod has a stable name and its own volume | Databases need identity and storage; Deployments give neither |
| **PVC** | A *request* for storage | Decouples "I need 5Gi" from "how storage is actually made here" |
| **Namespace** | A scope / folder for objects | Lets you delete everything at once and apply quotas |

## 0.3 Labels and selectors — the glue

**Nothing in Kubernetes finds anything else by name.** It finds it by label.

```yaml
# Deployment says: the Pods I manage carry this label
template:
  metadata:
    labels:
      app: ui

# Service says: send traffic to whatever carries this label
selector:
  app: ui
```

The Service has no idea a Deployment exists. It just watches for Pods labelled
`app: ui`. That indirection is why you can swap a Deployment for a StatefulSet
and the Service never notices.

**The #1 beginner failure:** a typo in a label. The API server happily accepts it,
nothing errors, and your Service routes to nothing. `kubectl get endpoints <svc>`
showing `<none>` is the symptom.

## 0.4 What kind is — and why Docker Desktop shows nothing

**kind = "Kubernetes IN Docker".** It builds a cluster out of Docker containers.
Each Kubernetes *node* is a container running from the `kindest/node` image.

So your cluster correctly appears in Docker Desktop's **Containers** tab:

```
shorten-control-plane      <- runs the API server, scheduler, controllers
shorten-worker             <- runs your Pods
shorten-worker2            <- runs your Pods
```

Docker Desktop's **Kubernetes** tab is a *different, unrelated* built-in cluster.
It says "Create cluster" because you never enabled it.

> ⚠️ **Do not click "Create cluster" there.** It starts a second Kubernetes, eats
> ~2GB RAM, and adds a `docker-desktop` context you will confuse with yours.

**Your interface to kind is `kubectl`, never the Docker Desktop GUI.**

One consequence that matters a lot in Part 2: each kind node runs **its own
containerd**, completely separate from Docker Desktop's image store. A node cannot
see images you built on your host. That is what `kind load` is for.

## 0.5 Tooling — verified on this machine

| Tool | Version | Note |
| --- | --- | --- |
| Docker | 29.7.2 | |
| kind | 0.32.0 | |
| kubectl | v1.36.1 | bundles Kustomize v5.8.1 — `kubectl apply -k` works, no separate install |
| Helm | v4.2.3 | not needed until Stage 3 |
| minikube | not installed | intentional — this plan is kind-only |

Calico *may* be needed at Part 8.3. Nothing else to install.

## 0.6 Stage 0 gate

Do not start Part 2 until you can draw the three request paths — register,
shorten, follow a short link — and say which service touches the database.

Stage 1 is mostly re-expressing something you already understand in a new
vocabulary. If you do not understand it yet, you will be debugging the app and
Kubernetes at the same time, and you will not be able to tell which is broken.

> **💰 Cost note:** the RDS instance `shorten-url-db` (ap-south-1) is running and
> both `.env` files point at it. Parts 2–4 use it; Part 5 replaces it with
> in-cluster Postgres and **you should stop the instance then**. Storage still
> bills, but instance-hours stop. RDS auto-starts again after 7 days.

---

# Part 1 — The three app code fixes ✅ DONE

Kept for reference — this is *why* the rest of the document is short.

## Why these came first

The app was written assuming **three separate URLs** (`:3000`, `:4000`, `:5000`).
Compose is happy with that. Kubernetes wants **one entrypoint** routing by path.
Three things in the code blocked that shape, and all three were far easier to fix
in `npm run dev` — where a failure gives you a stack trace — than inside a Pod,
where the same failure is a `CrashLoopBackOff`.

```
Before (Compose)                Now (ready for Kubernetes)

browser → :3000 ui              browser → shorten.local ─┬─ /      → ui:3000
        → :4000 auth                                     ├─ /auth  → auth-server:4000
        → :5000 short                                    ├─ /api   → short-server:5000
                                                         └─ /r     → short-server:5000
```

## 1.1 ✅ UI now calls relative paths — commit `630f962`

`import.meta.env.VITE_AUTH_URL` was read by **Vite at build time** and literally
substituted into the JavaScript bundle. There was no runtime variable left to
change, so one image could never serve two environments.

Both base URLs are now `""`, so calls are same-origin (`/auth/register`,
`/api/shorten`). A dev proxy in [ui/vite.config.js](ui/vite.config.js) keeps
`npm run dev` working.

**The payoff:** the `ui` image you build in Part 2 is environment-independent, and
CORS becomes unnecessary.

## 1.2 ✅ Redirects moved to `/r` — commit `feddc9b`

`app.use("/", redirectRouter)` answered `GET /:code` — *any* single path segment —
which collides head-on with the UI at `/`. Now mounted at `/r`, with
`PUBLIC_BASE_URL` updated to match, because
[short-server/src/routes/links.ts](short-server/src/routes/links.ts) builds the
displayed short URL from it.

## 1.3 ✅ TLS decided by `sslmode` — commit `2709732`

The old code required TLS for any host that was not `localhost`. In-cluster the
host is `postgres`, so it would have demanded TLS from a plain
`postgres:17-alpine` that does not offer it, and died with *"The server does not
support SSL connections"* — reaching you as a `CrashLoopBackOff` whose message
points nowhere near the hostname that caused it.

Now: TLS by default, opt out with `?sslmode=disable`. RDS is unaffected.

---

# Part 2 — Cluster, images, and your first workloads

Roadmap §1.1. This is the longest part. Take it slowly.

## 2.1 ✅ Create the cluster

`k8s/kind-cluster.yaml` (already written — read it, do not skip the table below):

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
      - containerPort: 80
        hostPort: 80
        protocol: TCP
      - containerPort: 443
        hostPort: 443
        protocol: TCP
  - role: worker
  - role: worker
```

**Concept — why each piece is there:**

| Field | Why |
| --- | --- |
| `role: control-plane` | Runs the API server, scheduler and controllers. The "brain" |
| two `role: worker` | Your Pods run here. Two of them makes *"which node did this land on?"* a real question — which matters for storage in Part 5 |
| `node-labels: ingress-ready=true` | The ingress-nginx manifest for kind targets this exact label. Without it the controller Pod stays `Pending` forever |
| `extraPortMappings` 80/443 | Forwards your laptop's ports into the node container, so `http://shorten.local` reaches the cluster in Part 7 |

> ⚠️ **Both of these can only be set when the cluster is created.** You cannot add
> them later — you must delete and recreate the cluster. That is why they are in
> the file from day one, even though nothing uses them until Part 7.

Create it:

```powershell
kind create cluster --config k8s/kind-cluster.yaml
```

Verify:

```powershell
kind get clusters                    # shorten
kubectl config current-context       # kind-shorten
kubectl get nodes
```

You should see three nodes `Ready`.

- [x] `shorten` cluster created, three nodes `Ready`
- [x] current context is `kind-shorten`

### Clean up stale contexts

`kubectl config get-contexts` may list clusters that no longer exist
(`kind-deocker`, `kind-kind`). Delete them so you cannot accidentally apply into
nothing:

```powershell
kubectl config delete-context kind-deocker
kubectl config delete-context kind-kind
kubectl config delete-cluster kind-deocker
kubectl config delete-cluster kind-kind
```

## 2.2 ✅ Create the namespace

```powershell
kubectl create namespace shorten-dev
kubectl config set-context --current --namespace=shorten-dev
```

**Concept:** a Namespace is a scope. Two benefits that matter immediately:

1. `kubectl delete namespace shorten-dev` removes *everything* you made — the
   fastest possible reset.
2. Setting it as your context default means you stop typing `-n shorten-dev` on
   every command, and you stop accidentally polluting `default`.

Part 8.1 adds a `ResourceQuota` and `LimitRange` to it.

Verify: `kubectl config view --minify | Select-String namespace`

- [x] `shorten-dev` namespace exists
- [x] it is your context default, so `-n shorten-dev` is no longer needed

## 2.3 ✅ Build the images and load them into kind

### Build

```powershell
$SHA = git rev-parse --short HEAD
echo $SHA

docker build -t "shorten/ui:$SHA" ./ui
docker build -t "shorten/auth-server:$SHA" ./auth-server
docker build -t "shorten/short-server:$SHA" ./short-server
```

**Concept — why a git SHA and never `:latest`:**

You will set `imagePullPolicy: IfNotPresent` on every container (you must — there
is no registry to pull from). That policy makes the node ask: *"do I already have
something named `shorten/ui:latest`?"* If yes, it uses it — **without checking
whether it changed**.

So with `:latest`, you rebuild, you reload, you delete the Pod... and Kubernetes
serves the old image. You then debug code that is not running. It is a genuinely
miserable hour.

A SHA tag makes every build a new *name*. Nothing can be stale, and a deploy
becomes a real, recorded, reversible change.

### Load into the cluster

```powershell
kind load docker-image "shorten/ui:$SHA" "shorten/auth-server:$SHA" "shorten/short-server:$SHA" --name shorten
```

**Concept — why this step exists:** as covered in 0.4, each kind node runs its own
containerd, isolated from Docker Desktop's image store. Your freshly built image
is invisible to the cluster. `kind load` copies it into every node.

Skip this and you get `ErrImagePull` — the node trying to fetch `shorten/ui` from
Docker Hub, where it does not exist.

### Verify it landed on both workers

```powershell
docker exec shorten-worker crictl images | Select-String shorten
docker exec shorten-worker2 crictl images | Select-String shorten
```

Expect three lines from each. **Check both**, because the scheduler may put a Pod
on either one, and an image missing from just one node produces an
`ImagePullBackOff` that looks random.

- [x] three images built with a SHA tag — `2709732`
- [x] `crictl images` shows all three on **both** workers

## 2.4 ✅ One bare Pod, exactly once

```powershell
kubectl run ui-bare --image="shorten/ui:$SHA" --image-pull-policy=IfNotPresent --port=3000
kubectl get pod ui-bare
kubectl delete pod ui-bare
kubectl get pods
```

**Concept:** it is gone. Nothing brings it back. A bare Pod has no controller
watching it, so there is no desired state to converge on.

In 2.5 you will delete a Deployment-managed Pod and watch a replacement appear in
seconds. **That contrast is the entire reason Deployments exist.** Feel it once
here, then never use `kubectl run` for real workloads again.

- [x] bare Pod created, inspected, deleted — and it stayed dead

## 2.5 ✅ Your first Deployment

Create `k8s/base/ui-deployment.yaml`. **Type it out.** This is the object you will
spend the most time debugging over the next two stages.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ui
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ui               # (A) which Pods do I manage?
  template:                 # ---- everything below describes a Pod ----
    metadata:
      labels:
        app: ui             # (B) MUST match (A), and the Service selects on it
    spec:
      containers:
        - name: ui
          image: shorten/ui:PUT-YOUR-SHA-HERE
          imagePullPolicy: IfNotPresent
          ports:
            - containerPort: 3000
```

**Concept — read this before applying:**

- **`template` is a Pod definition.** Everything under it is the Pod you want.
  The Deployment stamps out copies of it. Recognising "this block is just a Pod"
  makes StatefulSets and Jobs instantly familiar later.
- **`selector.matchLabels` (A) must equal `template.metadata.labels` (B).** This
  is how the Deployment recognises its own Pods. Mismatch them and the API server
  rejects it — one of the few times Kubernetes catches your mistake for you.
- **`imagePullPolicy: IfNotPresent` is mandatory here.** The default for a
  non-`:latest` tag happens to be `IfNotPresent`, but set it explicitly so nobody
  has to remember the rule.
- **`containerPort: 3000` — not 80.** [ui/nginx.conf](ui/nginx.conf) listens on
  3000. Get this wrong and you get a Pod that is `Running` and `Ready` but refuses
  every connection. Nothing looks broken, which makes it hard to find.

Apply and watch:

```powershell
kubectl apply -f k8s/base/ui-deployment.yaml
kubectl get pods -w              # Ctrl+C once Running
```

Now feel the difference from 2.4:

```powershell
kubectl delete pod -l app=ui
kubectl get pods                 # a NEW pod, new name, already starting
```

See the three-layer chain for yourself:

```powershell
kubectl get deploy,rs,pod
```

`Deployment ui` → `ReplicaSet ui-7d4f...` → `Pod ui-7d4f...-x9k2`. You made the
first. The Deployment made the second. The ReplicaSet made the third.

- [x] `ui` Deployment Running
- [x] deleting its Pod produced a replacement automatically — `ui-9bf8b7698-c6zv5` → `-dhjc2`
- [x] you can name the Deployment → ReplicaSet → Pod chain in your own output

## 2.6 ✅ The backends — deliberately broken first

Write `k8s/base/auth-deployment.yaml` and `k8s/base/short-deployment.yaml` from
the same shape. Ports **4000** (auth) and **5000** (short).

**Give them no database configuration yet. On purpose.**

```powershell
kubectl apply -f k8s/base/auth-deployment.yaml -f k8s/base/short-deployment.yaml
kubectl get pods
```

You will see `CrashLoopBackOff`. Now find out why:

```powershell
kubectl logs -l app=short-server --previous
kubectl describe pod -l app=auth-server
```

**Concept — why this is the most valuable failure in Stage 1:**

Both backends **exit** when the database is unreachable — `short-server` calls
`process.exit(1)` after 3 retries, and `auth-server`'s FastAPI lifespan raises
during `pool.open()`. With no config they fall back to `localhost:5432`, and
inside a Pod `localhost` is *the Pod itself*, where nothing is listening.

Kubernetes restarts a crashed container, it crashes again, and the backoff grows
(10s, 20s, 40s...). That is `CrashLoopBackOff` — not an error type, just "this
keeps dying and I am slowing down my retries".

**The critical command is `kubectl logs --previous`.** Plain `kubectl logs` reads
the *current* container — which has just started and has no output yet, or does
not exist during the backoff wait. `--previous` reads the one that died, which is
the only place your actual error message lives. Learn this on a failure you caused
deliberately, so you are not learning it under pressure.

### What actually happened here (2026-09-12)

Both backends failed on the same missing config, but with **different timings**,
and that difference is the lesson:

| | Failed after | Signature |
| --- | --- | --- |
| `short-server` | ~4s | `ECONNREFUSED 127.0.0.1:5432`, 2 retries, `process.exit(1)` |
| `auth-server` | **30s** | `psycopg_pool.PoolTimeout: pool initialization incomplete after 30.0 sec` |

Because auth-server takes 30s to give up, `kubectl get pods` showed it as
`1/1 Running` for most of every cycle. **`STATUS` lied; `RESTARTS: 5` told the
truth.** Always read both columns.

`kubectl logs --previous` returned *"unable to retrieve container logs"* — the dead
container had already been garbage-collected. Plain `kubectl logs` worked instead.
Try `logs` first; reach for `--previous` only when the current container is too
fresh to have printed anything.

`kubectl describe` showed `Environment: <none>` — the single field that proved no
config was injected.

- [x] `CrashLoopBackOff` caused deliberately and diagnosed from logs + describe

## 2.7 ✅ Fix them with a Secret

```powershell
kubectl create secret generic shorten-secrets `
  --from-literal=DATABASE_URL='PASTE-FROM-short-server/.env' `
  --from-literal=JWT_SECRET='super-secret-change-me'
```

Add to **both** backend containers in their Deployment YAML:

```yaml
          envFrom:
            - secretRef:
                name: shorten-secrets
```

Re-apply and confirm:

```powershell
kubectl apply -f k8s/base/auth-deployment.yaml -f k8s/base/short-deployment.yaml
kubectl get pods
kubectl logs -l app=short-server | Select-String "Database connected"
```

**Concept — three things going on here:**

1. **`envFrom` + `secretRef` injects every key as an environment variable.** So
   the Secret's `DATABASE_URL` key becomes the `DATABASE_URL` env var the app
   already reads. No code change — this is exactly why twelve-factor config
   matters.
2. **Created imperatively, not as a YAML file, deliberately.** That string holds
   your live RDS password. `kubectl create secret` keeps it out of git. Part 4
   makes this declarative and forces you to confront "how do I commit a Secret
   safely" properly.
3. **Why the Pods can reach RDS at all:** Pod traffic NATs out through your
   laptop's public IP — the one already allowed in the `dev-rds-sg` security
   group. If your ISP rotates that IP, this breaks, and the symptom is a
   *connection timeout*, not an auth error.

> `auth-server` wants `?sslmode=require` and `short-server` does not care (it now
> reads `sslmode` from the URL). One shared URL without the parameter works for
> both — psycopg defaults to `sslmode=prefer` and negotiates TLS with RDS anyway.

### Status — ✅ done (2026-09-12)

- [x] `envFrom` / `secretRef` added to both backend Deployments
- [x] `shorten-secrets` holds `DATABASE_URL` + `JWT_SECRET`
- [x] `JWT_SECRET` identical for both backends — signed by auth, verified by short
- [x] all four Pods `Running`, **0 restarts**
- [x] `short-server` logs show `Database connected successfully`
- [x] `auth-server` logs show `Database connected successfully`
- [x] tables `links` and `users` created automatically at startup

### How this actually got fixed — RDS was abandoned

The original plan pointed `DATABASE_URL` at RDS. That failed with `ETIMEDOUT`,
and the cause was outside Kubernetes. Everything AWS-side checked out —

| Check | Result |
| --- | --- |
| SG allowed the current public IP | ✅ rule added |
| Subnets route `0.0.0.0/0` → internet gateway | ✅ |
| NACLs | ✅ allow all, both directions |
| RDS ENI public IP matched DNS from 3 resolvers | ✅ `13.232.201.124` |
| Outbound 5432 blocked by the ISP? | ✅ no — `portquiz.net:5432` connected |
| **TCP to RDS:5432** | ❌ still timed out |

Probable cause: the home network runs DNS64/NAT64 (`64:ff9b::` appeared in
resolver output), so the source IP AWS sees for a raw TCP connection differs from
the one reported over HTTPS. A `/32` allow-rule can never reliably match that.

Rather than widen the rule, **RDS was dropped entirely** — which is what Part 5
prescribes anyway. See [k8s/base/postgres-statefulset.yaml](k8s/base/postgres-statefulset.yaml):
a headless Service plus a StatefulSet with a 2Gi `volumeClaimTemplate`, and
`PGDATA` pointed at a subdirectory of the mount.

The connection string became:

```
postgresql://postgres:postgres@postgres:5432/shortenurl?sslmode=disable
```

That `?sslmode=disable` is exactly what fix **1.3** made possible. Without it,
`short-server` would have demanded TLS from a plaintext Postgres and crash-looped
with an error pointing nowhere near the cause.

> ⚠️ **Read [k8s/base/postgres-statefulset.yaml](k8s/base/postgres-statefulset.yaml)
> line by line before Part 5.** It was written for you, not by you, which breaks
> this document's ground rule. Part 5's concept sections explain every field in it.

### Lesson kept from the failure

`kubectl get secret -o yaml` was pasted into a chat transcript, exposing the RDS
password in reversible base64. The instance has since been deleted, so there is
nothing left to rotate — but the habit stands: **Secret YAML is plaintext.**

## 2.8 ✅ Cause the other three failure modes on purpose

Each has a distinct signature. At 2am you want to *recognise* them, not reason
them out.

### ImagePullBackOff — the image does not exist

```powershell
kubectl set image deploy/ui "ui=shorten/ui:nope"
kubectl get pods
kubectl describe pod -l app=ui | Select-String -Context 0,5 "Events"
kubectl set image deploy/ui "ui=shorten/ui:$SHA"
```

**Means:** the kubelet cannot get the image. In kind, 90% of the time it means you
forgot `kind load`, or the tag is wrong.

### Pending — the scheduler cannot place it

```powershell
kubectl set resources deploy/ui -c ui --requests=memory=100Gi
kubectl get pods
kubectl describe pod -l app=ui | Select-Object -Last 20
kubectl set resources deploy/ui -c ui --requests=memory=64Mi
```

**Means:** no node satisfies the Pod's requirements. `describe` tells you exactly
which constraint failed — read the `Events` section, it is unusually helpful.

**Concept — `requests` vs `limits`:** `requests` is what the **scheduler** uses to
pick a node ("reserve me this much"). `limits` is the hard ceiling the **kernel**
enforces at runtime. Asking for 100Gi is a scheduling failure; nothing ever tried
to run.

### OOMKilled — the container exceeded its memory limit

```powershell
kubectl set resources deploy/ui -c ui --limits=memory=8Mi
kubectl get pods
kubectl describe pod -l app=ui | Select-String -Context 0,4 "Last State"
kubectl set resources deploy/ui -c ui --limits=memory=128Mi
```

**Means:** the kernel killed it for exceeding `limits.memory`. Note it appears
under **`Last State`**, not the current state — the current container is freshly
restarted and looks fine. This is why "the Pod looks OK" is never sufficient.

- [x] `CrashLoopBackOff` — done in 2.6
- [x] `ImagePullBackOff`
- [x] `Pending`
- [x] `OOMKilled`

> **Trap hit here:** `kubectl set resources ... --limits=memory=8Mi` was **rejected
> by the API server** — `requests: Invalid value: "64Mi": must be less than or
> equal to memory limit of 8Mi`. `requests` can never exceed `limits`. Set both at
> once: `--requests=memory=8Mi --limits=memory=8Mi`.
>
> That makes three different enforcers for the same field, failing at three
> different times:
>
> | Enforcer | Catches | When |
> | --- | --- | --- |
> | API server | `requests > limits`, selector ≠ template labels | before anything runs |
> | Scheduler | `Pending` — no node is big enough | at placement |
> | Kernel | `OOMKilled` — exceeded the limit | at runtime |

## 2.9 ✅ The debug loop — make this muscle memory

Five commands answer almost every Kubernetes question. Run them in this order:

```powershell
kubectl get pods                                    # 1. what state is it in?
kubectl describe pod <name>                         # 2. what does the CLUSTER say? (Events at the bottom)
kubectl logs <name>                                 # 3. what does the APP say?
kubectl logs <name> --previous                      # 4. what did the app say before it died?
kubectl get events --sort-by=.lastTimestamp         # 5. what happened recently, everywhere?
kubectl exec -it <name> -- sh                       # 6. go look for yourself
```

> **Two things learned the hard way in 2.6** — `--previous` fails once the dead
> container is garbage-collected, so try plain `logs` first; and `kubectl logs -l app=X`
> mixes output from old terminating Pods with new ones. Use `kubectl logs deploy/X`
> to read only the current ReplicaSet.

**Concept — the split that beginners miss:** `describe` shows you what
*Kubernetes* thinks (scheduling, image pulls, probe failures, OOM kills). `logs`
shows what *your application* printed. A `CrashLoopBackOff` needs both: `describe`
tells you it is restarting, `logs --previous` tells you why.

- [x] `get` / `describe` / `logs` used to diagnose a real failure
- [x] you reach for these without looking them up

## Part 2 — done when

You can rebuild one service, load it, `kubectl set image`, and watch **only that
Deployment** roll while the others sit untouched.

---

# Part 3 — Services and cluster DNS ✅ DONE

Roadmap §1.2.

## Concept — why Pods cannot talk to each other directly

Every Pod gets its own IP. That IP is **gone** the moment the Pod restarts, is
rescheduled, or is scaled. There is nothing stable to hardcode.

A **Service** is a stable virtual IP and DNS name in front of whatever Pods
currently carry a given label. It watches for matching Pods, keeps a list
(the **Endpoints**), and load-balances across them.

Compose gave you this for free — `http://auth-server:4000` worked because Compose
ran a DNS server for its network. A Service is the Kubernetes equivalent, and
`http://auth-server:4000` will work again the moment you create one.

**Names to write:**

| Service | port | targetPort | Backing Pods labelled |
| --- | --- | --- | --- |
| `ui` | 3000 | 3000 | `app: ui` |
| `auth-server` | 4000 | 4000 | `app: auth-server` |
| `short-server` | 5000 | 5000 | `app: short-server` |
| `postgres` | 5432 | 5432 | `app: postgres` (headless, Part 5) |

> **`port` vs `targetPort`:** `port` is what clients dial on the Service.
> `targetPort` is the container's actual port. Keeping them equal is simplest,
> and remember the UI's is **3000**.

## Steps

1. Write a Service per backend service. Type them by hand.
2. Test DNS resolution from inside the cluster:

```powershell
kubectl run tmp --rm -it --image=curlimages/curl --restart=Never -- curl -s http://auth-server:4000/health
```

3. If it fails, check the label wiring first:

```powershell
kubectl get endpoints auth-server
```

`<none>` means your Service selector does not match any Pod's labels. That is the
bug, every time.

4. Try the two alternatives once each so you know why they are not the answer:

```powershell
kubectl port-forward svc/ui 8080:3000        # your laptop only, dies with the command
# then change a Service type to NodePort, see the high port, change it back
```

**Concept:** `port-forward` is a debugging tunnel from your machine — not
infrastructure. `NodePort` opens the same high-numbered port on *every* node and
gives you no hostnames, no paths, and no TLS. Real HTTP traffic wants an Ingress,
which is Part 7.

- [x] ClusterIP Service per service; `/health` reachable by DNS name from another Pod
- [x] `kubectl get endpoints` understood as the label-wiring check
- [x] NodePort and `port-forward` each tried once, and you can say why neither is the answer

### What happened (2026-09-14)

Services live in [k8s/base/services/](k8s/base/services/). Verified from inside the
cluster:

```
auth-server:4000/health   -> HTTP 200
short-server:5000/health  -> HTTP 200
ui:3000/health            -> HTTP 200
```

> The UI's 200 is **not** a real health check. nginx's `try_files $uri $uri/ /index.html`
> returns the SPA for any path, so every URL is 200. It proves the Service routes,
> nothing more. Part 6 gives it a real probe.

**Trap 1 — the label bug, hit for real.** The first two Services were written as
`name: auth` with `selector: app: auth`, but the Pods carry `app: auth-server`.
The API server accepted both files silently:

```
auth       <none>            <- broken, no error anywhere
short      <none>            <- broken
ui         10.244.2.3:3000   <- correct
```

`kubectl get endpoints` is the only thing that shows this. `<none>` = selector
matches no Pod. Fixing the label *and* the Service name (Part 7's Ingress routes to
`auth-server:4000` and `short-server:5000`) made all three resolve.

**Trap 2 — `kubectl run --rm -it` loses output on fast commands.** A one-shot curl
finishes before `kubectl` can attach a TTY:

```
warning: couldn't attach to pod/tmp ... container tmp not found
```

Drop the `-t`: use `-i` alone for one-shot commands, keep `-it` for `-- sh`.
And `--rm` only cleans up on a clean exit — a Ctrl+C leaves the Pod behind, so the
next run fails with `AlreadyExists`. Clear it with
`kubectl delete pod tmp --ignore-not-found`.

**Trap 3 — `kubectl patch` to NodePort does not revert itself.** `ui` was left as
`NodePort` on `31610`. Going back needs the nodePort removed too:

```powershell
kubectl patch svc ui --type=json -p '[{"op":"replace","path":"/spec/type","value":"ClusterIP"},{"op":"remove","path":"/spec/ports/0/nodePort"}]'
```

---

# Part 4 — ConfigMap and Secret, properly ✅ DONE

Roadmap §1.3. Part 2.7 got you running with an imperative Secret. Now do it
properly.

## Concept — why config lives outside the image

An image should be **one artifact that runs anywhere**. The moment it contains an
environment's hostname or password, you need a separate image per environment, and
"promote the tested build to prod" becomes impossible.

So: image = code. ConfigMap/Secret = environment. That is the split Part 9's
overlays depend on.

## The JWT coupling — the reason this part matters here

`auth-server` **signs** the JWT. `short-server` **verifies** it locally, using the
same secret. There is no service-to-service call — no network hop that could fail
loudly.

So a `JWT_SECRET` mismatch does not error. It does not log. Every logged-in
request just quietly returns 401, and you will assume the login is broken.

**One Secret key, consumed by both Pods.** Making the coupling *visible* is the
whole point of doing Secrets here rather than later.

## What goes where

```yaml
# ConfigMap: shorten-config      (boring, commit it)
PORT: "5000"
PUBLIC_BASE_URL: "http://shorten.local/r"
JWT_EXPIRES_MINUTES: "1440"

# Secret: shorten-secrets        (do NOT commit real values)
DATABASE_URL: ...
JWT_SECRET: ...
```

Consume both with `envFrom` rather than listing every key:

```yaml
          envFrom:
            - configMapRef:
                name: shorten-config
            - secretRef:
                name: shorten-secrets
```

## Prove a Secret is not encrypted

```powershell
kubectl get secret shorten-secrets -o jsonpath='{.data.JWT_SECRET}'
# copy the output, then:
[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('PASTE-HERE'))
```

**Concept:** base64 is an *encoding*, reversible by anyone with read access. A
Secret's real protections are RBAC (who can read it), encryption-at-rest in etcd
(off by default), and the fact that it is not baked into the image. Write down
where this gets solved properly: **Stage 2 — Secrets Manager + External Secrets or
the Secrets Store CSI driver, with IRSA.**

- [x] both backends read `JWT_SECRET` from the same Secret key
- [x] you have decoded a Secret yourself and understand it is encoding, not encryption
- [x] you have noted where Stage 2 fixes it

### What happened (2026-09-14)

`k8s/base/configmap.yaml` holds the three non-secret keys; `shorten-secrets` stays
imperative and uncommitted. Verified with `kubectl exec deploy/<name> -- printenv`:

| Key | short-server | auth-server | Source |
| --- | --- | --- | --- |
| `DATABASE_URL` | ✅ | ✅ | Secret |
| `JWT_SECRET` | ✅ | ✅ | Secret |
| `PORT` | ✅ | ✅ (ignored) | ConfigMap |
| `PUBLIC_BASE_URL` | ✅ | ✅ (ignored) | ConfigMap |
| `JWT_EXPIRES_MINUTES` | ✅ (ignored) | ✅ | ConfigMap |

**`envFrom` is all-or-nothing.** Every key lands in every container that references
the source. `auth-server` receives `PORT=5000` but listens on 4000 — safe only
because its port is hardcoded in the Dockerfile (`--port 4000`), not read from the
environment. That is luck, not design. Use explicit `env:` + `valueFrom` when a key
must reach only one container.

**Trap hit — a fifth failure signature.** A typo, `name: shorten-secretss`, produced:

```
short-server-f7c54bcf-z65vq   0/1   CreateContainerConfigError
```

| Signature | Means |
| --- | --- |
| `ImagePullBackOff` | image does not exist |
| `CrashLoopBackOff` | app starts, then dies |
| `Pending` | scheduler cannot place it |
| `OOMKilled` | kernel killed it |
| **`CreateContainerConfigError`** | **referenced ConfigMap/Secret does not exist** |

The container never started, so `kubectl logs` returned nothing — `describe` was the
only tool that worked. Meanwhile the **old Pod kept serving**: Kubernetes will not
remove a working Pod until the replacement is Ready, so the typo caused zero
downtime. That is the rolling-update guarantee, made explicit by `maxUnavailable: 0`
in Part 6.

> ⚠️ `PUBLIC_BASE_URL` is now `http://shorten.local/r`, which does not resolve until
> Part 7. Short links display correctly but will not open in a browser yet.

---

# Part 5 — Postgres: StatefulSet and storage

Roadmap §1.4. Now cut the dependency on RDS.

## Concept — why a Deployment is wrong for a database

A Deployment treats its Pods as **interchangeable**. Any Pod can be killed and
replaced by an identical one anywhere, with any name. That is exactly right for
`short-server` and exactly wrong for Postgres, which needs:

- a **stable name** — `postgres-0` is always `postgres-0`, so replicas can find
  each other and clients have a fixed identity to target;
- **its own persistent volume**, reattached to the same Pod name after a restart.

A **StatefulSet** provides both. Its `volumeClaimTemplate` creates one PVC *per
replica*, named after the Pod, and rebinds it on restart.

## Concept — PV, PVC and StorageClass

Three objects that confuse everyone at first:

| Object | Plain English | Who creates it |
| --- | --- | --- |
| **PVC** (PersistentVolumeClaim) | *"I need 5Gi of storage"* | You (or a `volumeClaimTemplate`) |
| **StorageClass** | *"here is how storage gets made on this cluster"* | The platform |
| **PV** (PersistentVolume) | The actual provisioned volume | Created automatically from the PVC + StorageClass |

The point of the split: your manifest says *what you need*, never *how to get it*.
The same YAML asks for 5Gi on kind (a folder on a node) and on EKS (an EBS volume).
**That is what makes Part 9's prod overlay possible.**

## Two things to get right

```yaml
          env:
            - name: POSTGRES_DB
              value: shortenurl              # must match your DATABASE_URL
            - name: PGDATA
              value: /var/lib/postgresql/data/pgdata   # SUBDIRECTORY of the mount
```

**Why `PGDATA` points to a subdirectory:** `initdb` refuses to initialise into a
non-empty directory. Many volume types arrive with a `lost+found` in them, so
mounting straight onto the data directory fails. kind's local-path volumes happen
to be empty, so you would get away with it here — and then be mystified on EKS.
Build the habit now.

**No migration step exists.** Both services run `CREATE TABLE IF NOT EXISTS` from
their own `schema.sql` at startup (`links` for short, `users` for auth). Give them
a reachable empty database and they set themselves up.

## Update the connection string

In-cluster the DB is plaintext, so:

```
postgresql://postgres:postgres@postgres:5432/shortenurl?sslmode=disable
```

That `?sslmode=disable` is exactly what fix 1.3 made possible. Drop
`?sslmode=require` for auth-server — psycopg's default `prefer` handles both.

## Watch storage behave

```powershell
kubectl get pvc
kubectl delete pod postgres-0        # data SURVIVES - new pod, same PVC
# register a user, confirm it is still there
kubectl delete pvc data-postgres-0   # now it does not
```

**Concept — kind's storage has a sharp edge worth seeing.** The default
StorageClass is `standard` (rancher local-path) with `WaitForFirstConsumer`
binding: the volume is a directory **on one specific node**. If the Pod is later
scheduled elsewhere, it cannot follow. Lose that node and the data is gone.

That limitation *is* the argument for RDS in Stage 2. Notice it here.

- [ ] Postgres runs as a StatefulSet with a PVC from a `volumeClaimTemplate`
- [ ] data survived Pod deletion; you watched it **not** survive PVC deletion
- [ ] you can explain why a Deployment is the wrong shape for a database
- [ ] 💰 **RDS instance stopped** — you no longer need it

---

# Part 6 — Probes, resources, self-healing ✅ DONE

Roadmap §1.5.

## Concept — the three probes do different jobs

| Probe | Question it answers | What failing does |
| --- | --- | --- |
| **readiness** | *"Can I serve traffic right now?"* | Removed from Service endpoints. **Not** restarted |
| **liveness** | *"Am I wedged and beyond saving?"* | Container is **killed and restarted** |
| **startup** | *"Am I still booting?"* | Suspends the other two until it passes |

**The classic beginner mistake:** setting a liveness probe with a short timeout on
a service that is slow to start. It fails during boot, Kubernetes kills it, it
starts booting again, fails again — an infinite restart loop caused entirely by
the probe. A `startupProbe` exists precisely to prevent that.

**Readiness is the more useful of the two.** It is what makes rolling updates safe:
a new Pod receives no traffic until it says it is ready.

## For this app

- Both backends expose `/health` — use it for readiness and liveness.
- The UI has none. Probe `/` on nginx, or add a real endpoint.
- Add a `startupProbe` on the backends: their first action is a database connect,
  which is the slow, failure-prone part.

## Concept — the crash-loop you already met, solved two ways

Both backends exit if the DB is down at boot. On a fresh `apply` they will
crash-loop until Postgres is Ready. Try both answers and compare:

1. **Let Kubernetes handle it.** Restarts converge once Postgres is up. Simple,
   noisy, and genuinely fine.
2. **An `initContainer` that waits for Postgres.** The app container does not
   start until the port answers. Cleaner event log, one more moving piece.

Neither is wrong. Knowing why you chose one is the point.

## Scaling and rollouts

```powershell
kubectl scale deploy/short-server --replicas=3
kubectl get pods
# shorten a URL, follow it - still works
```

**Why that is safe:** `short-server` keeps no state in memory. Click counts go
straight to Postgres, so any replica can serve any redirect. Stateless-ness is a
property you can *check*, not an assumption.

Then:

```powershell
kubectl set image deploy/short-server "short-server=shorten/short-server:broken"
kubectl rollout status deploy/short-server     # watch it stall
kubectl rollout undo deploy/short-server
kubectl rollout history deploy/short-server
```

**Concept — why the rollout stalls instead of breaking the site.** With
`maxUnavailable: 0`, Kubernetes will not remove an old Pod until a new one is
Ready. The broken image never becomes Ready, so the old Pods stay serving and the
rollout simply waits. Your bad deploy did nothing to users. That is what readiness
probes buy you — without one, Kubernetes would consider a crashed container "up"
and happily replace everything.

- [x] readiness + liveness on all three; startupProbe where the DB connect is slow
- [x] `requests` and `limits` on everything
- [x] `short-server` at 3 replicas, redirects still correct
- [x] HPA on CPU — created and reading metrics (`cpu: 4%/60%`). Load test still ⬜
- [x] `maxUnavailable: 0` + PodDisruptionBudget; bad image stalled, `rollout undo` recovered it

### What happened (2026-09-14)

**Probes made "Ready" mean something.** The `-w` output during the rollout:

```
short-server-cfd76c64c-8zxfm   0/1  Running       3s   <- started, NOT ready
short-server-cfd76c64c-8zxfm   1/1  Running       5s   <- /health answered
short-server-5d867c669b-8nskp  1/1  Terminating        <- only now is the old one removed
```

Before the probes, a Pod flipped to `1/1` the instant the process started — before
Postgres was connected.

> **Caveat worth remembering:** at `replicas: 1`, the default `maxUnavailable: 25%`
> already rounds *down* to 0, so that safe ordering would have happened anyway.
> `maxUnavailable: 0` only starts to matter at 3 replicas.

**`metrics-server` is not in kind — install it for the HPA.** It also needs a patch,
because kubelets use self-signed certs:

```powershell
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
kubectl -n kube-system patch deploy metrics-server --type=json -p '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'
```

Without that patch it runs but never reports, and the HPA shows `cpu: <unknown>/60%`
forever. Pin the release before Part 10.

### The bad-deploy drill — the payoff

```
kubectl set image deploy/short-server short-server=shorten/short-server:broken

short-server-655c588756-6rhzx  0/1  ImagePullBackOff   <- the bad one, quarantined
short-server-cfd76c64c-8zxfm   1/1  Running            <- all three originals
short-server-cfd76c64c-fdq25   1/1  Running               still serving
short-server-cfd76c64c-qh4xv   1/1  Running

GET /            HTTP 200
GET /r/KXrMX1v   HTTP 302
```

`rollout status` timed out instead of failing; `rollout undo` restored it without
touching the three healthy Pods. **A broken deploy did nothing to users.**

### ⚠️ Open conflict — `replicas` vs the HPA

[short-deployment.yaml](k8s/base/short-deployment.yaml) declares `replicas: 3` and the
HPA manages the same field (`min 2, max 6`). They will fight: every `kubectl apply`
resets the count to 3, and the HPA immediately moves it back.

**Fix in Part 9:** remove `replicas` from the Deployment once an HPA owns it. Until
then, expect a brief thrash after each apply.

> `kubectl rollout undo` also warns that it does not update the
> `last-applied-configuration` annotation. Rollback is a break-glass tool — the
> durable fix is to correct the YAML and `apply`.

---

# Part 7 — Ingress and TLS — ✅ HTTP done, TLS pending

Roadmap §1.6. Part 1 already did the hard work — this is now four plain rules.

## Concept — Ingress is data, not a program

An `Ingress` object is **just routing rules**. On its own it does nothing at all.

An **Ingress Controller** (here, ingress-nginx) is a real Pod that watches for
Ingress objects and reconfigures itself to match. No controller = your Ingress is
an inert row in etcd.

That is why you install the controller first.

## Install the controller

```powershell
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml
kubectl -n ingress-nginx wait --for=condition=Ready pod -l app.kubernetes.io/component=controller --timeout=180s
```

**Use the `provider/kind` manifest specifically.** It binds the controller to
`hostPort` 80/443 on the node labelled `ingress-ready=true` — which is exactly
what your `kind-cluster.yaml` set up in 2.1. A generic manifest would ask for a
cloud LoadBalancer that does not exist locally, and sit `Pending` forever.

Once it works, pin `main` to a release tag so a cluster rebuild is reproducible.

## Point a hostname at it

Add to `C:\Windows\System32\drivers\etc\hosts` (edit as Administrator):

```
127.0.0.1 shorten.local
```

**The full path your request takes:**

```
browser → shorten.local:80
        → laptop port 80
        → (extraPortMappings) node container port 80
        → ingress-nginx controller Pod
        → matches a rule by host + path
        → Service ClusterIP
        → one of the Service's Pods
```

Every hop is something you configured. When something 404s, walk the chain.

## The four rules

| Path | pathType | Backend |
| --- | --- | --- |
| `/auth` | Prefix | `auth-server:4000` |
| `/api` | Prefix | `short-server:5000` |
| `/r` | Prefix | `short-server:5000` |
| `/` | Prefix | `ui:3000` |

**Concept — why you need no rewrite annotation.** The backends already serve those
exact prefixes: FastAPI has `APIRouter(prefix="/auth")`, Express has
`app.use("/api", ...)` and now `app.use("/r", ...)`. So the path the browser sends
is the path the backend expects, and the Ingress passes it through untouched.

A `rewrite-target` annotation exists for when they *disagree* — public `/api/v1/x`
mapping to a backend that only knows `/x`. Try it once to see what it does, then
delete it. Needing one is usually a sign of a mismatch worth fixing at the source,
which is precisely what Part 1 did.

**`pathType` in one line:** `Prefix` matches whole path segments (`/api` matches
`/api/shorten` but not `/apifoo`). `Exact` matches only that string.
`ImplementationSpecific` hands the decision to the controller — avoid it while
learning, since behaviour varies by controller.

## Then TLS

Generate a self-signed cert, put it in a `tls` Secret, add a `tls:` block to the
Ingress. Your browser will warn — that is correct, and it is the same mechanism
ACM will provide in Stage 2.

- [x] all four rules work: register → shorten → history → follow the short link, on `http://shorten.local`
- [x] you can explain `Prefix` vs `ImplementationSpecific`
- [ ] one rewrite annotation tried, understood, and removed

### Verified end to end (2026-09-14)

```
POST /auth/register  -> 201, JWT issued
POST /auth/login     -> token
POST /api/shorten    -> http://shorten.local/r/KXrMX1v
GET  /r/KXrMX1v      -> 302 -> https://kubernetes.io/docs/...
```

**🔴 Trap — the upstream `main` manifest no longer honours `ingress-ready`.**
The controller shipped with `nodeSelector: {kubernetes.io/os: linux}` only, so the
scheduler put it on `shorten-worker` — a node with **no** Docker port mapping for
80/443. Symptom: `curl http://shorten.local/` returned `HTTP 000`, nothing at all.

Nothing in `kind-cluster.yaml` was wrong. The upstream manifest drifted. Fix:

```powershell
kubectl -n ingress-nginx patch deploy ingress-nginx-controller --type=json -p '[{"op":"add","path":"/spec/template/spec/nodeSelector/ingress-ready","value":"true"}]'
```

**Before Part 10, pin the install URL to a release tag instead of `main`** — a
cluster rebuilt from this repo must get the manifest that was actually tested.

**Trap — `/health` is not reachable through the Ingress.** Both backends serve
`/health` at their *root*, but the Ingress only forwards `/auth`, `/api` and `/r`.
So `http://shorten.local/auth/health` returns FastAPI's `{"detail":"Not Found"}`
and `/api/health` returns Express's `Cannot GET /api/health`.

Those 404s look like failures and are actually **proof the routing works** — two
different frameworks answering means each request reached its own backend. Use the
real routes (`/auth/register`, `/api/shorten`) to test, or `kubectl exec` for
`/health`.
- [x] self-signed cert in a `tls` Secret; `https://shorten.local` serves it

```
https://shorten.local/       200   (browser warns - correct for self-signed)
http://shorten.local/        308 -> https
cert: CN=shorten.local, SAN DNS:shorten.local, valid to Dec 2028
```

> ingress-nginx adds the HTTP->HTTPS 308 **automatically** the moment a `tls:` block
> exists. No annotation needed; disable with `nginx.ingress.kubernetes.io/ssl-redirect: "false"`.
>
> Generating the cert in Git Bash needs `MSYS_NO_PATHCONV=1`, or `-subj "/CN=..."`
> gets rewritten into a Windows path.
- [ ] CORS tightened — `allow_origins=["*"]` in [auth-server/app/main.py](auth-server/app/main.py) and the bare `cors()` in [short-server/src/index.ts](short-server/src/index.ts) are no longer needed

---

# Part 8 — Security and isolation ✅ DONE

Roadmap §1.7.

## 8.1 ResourceQuota and LimitRange

- **ResourceQuota** caps the whole namespace ("no more than 4 CPU total here").
- **LimitRange** sets per-container defaults and ceilings, and can reject a Pod
  that declares no limits at all.

Write both, then deliberately try to apply an oversized Pod and watch it get
rejected. A quota you have never seen enforce anything is a quota you do not
understand.

- [x] everything in `shorten-dev`, nothing in `default`
- [x] a `ResourceQuota` and `LimitRange` that actually reject an over-large Pod

> **Apply the LimitRange first.** A ResourceQuota that tracks cpu/memory rejects any
> Pod without limits, and `postgres` declared none. The LimitRange injects defaults,
> so the quota has something to count.
>
> Proof it enforces:
>
> ```
> kubectl run toobig --image=nginx --requests=cpu=3 --limits=cpu=3
> Error from server (Forbidden): maximum cpu usage per Container is 2, but limit is 3
> ```

## 8.2 Stop running as root

All three images run as root today. Root in a container is not root on your
laptop, but a container escape becomes far more damaging, and it is *free* to fix.

```yaml
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
      containers:
        - name: ...
          securityContext:
            readOnlyRootFilesystem: true
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
```

Per image:

- **`short-server`** — `node:20-alpine` already ships a `node` user. Add
  `USER node` and make sure `/app` is owned by it.
- **`auth-server`** — add a user in the Dockerfile and `USER` it. (Side note: the
  image is `python:3.9-slim` while the requirements are modern — bumping it is a
  fair side-quest, not a requirement.)
- **`ui`** — the hard one. Stock `nginx:alpine` writes to `/var/cache/nginx` and
  `/var/run`, which `readOnlyRootFilesystem` forbids. Either switch to
  `nginxinc/nginx-unprivileged` (it defaults to port 8080 — adjust
  [ui/nginx.conf](ui/nginx.conf) and your Service) or mount `emptyDir` volumes
  over those two paths.

**Note:** binding port 3000 is *not* the problem — only ports below 1024 need
privileges. Writable paths are the problem.

- [x] all three run as non-root with a read-only root filesystem

### Verified (2026-09-14)

```
ui           uid=101   writable-root=NO
auth-server  uid=1000  writable-root=NO
short-server uid=1000  writable-root=NO
```

| Image | Change |
| --- | --- |
| `short-server` | `RUN chown -R node:node /app` + `USER node` (alpine ships uid 1000) |
| `auth-server` | `RUN useradd -u 1000 -m appuser && chown -R appuser:appuser /app` + `USER appuser` |
| `ui` | base image swapped to `nginxinc/nginx-unprivileged:alpine` (runs as uid **101**, not 1000) |

**Trap — the UI crash-looped on `readOnlyRootFilesystem`.** The unprivileged image
still needs a writable `/tmp`:

```
nginx: [emerg] mkdir() "/tmp/proxy_temp" failed (30: Read-only file system)
```

Fix: an `emptyDir` mounted at `/tmp`. The backends needed nothing. And note `runAsUser`
must match the image — 101 for the UI, not the 1000 used elsewhere.

> Images are tagged `2709732-nonroot` because the Dockerfile changes are **not yet
> committed**. Retag with a real short SHA after committing.

## 8.3 NetworkPolicy — and a warning

**Concept:** by default, **every Pod can reach every other Pod**. There is no
firewall. Your UI Pod can open a Postgres connection right now.

A NetworkPolicy changes that — but with a rule that trips everyone up:

> A Pod is "unrestricted" until *some* NetworkPolicy selects it. Once any policy
> selects it, everything not explicitly allowed is denied.

So the standard pattern is: apply a default-deny policy for the whole namespace,
then add narrow allow rules.

What you want:

```
ingress-nginx  →  ui, auth-server, short-server
auth-server    →  postgres:5432
short-server   →  postgres:5432
everything else: denied
```

### ⚠️ Verify enforcement before you trust it

**NetworkPolicy is enforced by the CNI plugin, not by Kubernetes.** kind's default
CNI (kindnet) may accept your policy and silently ignore it. A policy that does
nothing is worse than no policy — you will "prove" an isolation that does not
exist.

Test it:

```powershell
kubectl exec -it deploy/ui -- nc -zv postgres 5432    # MUST fail after default-deny
```

If it still connects, recreate the cluster with `networking.disableDefaultCNI: true`
in `k8s/kind-cluster.yaml`, install Calico, and re-test.

- [x] default-deny in force **and empirically verified** from the UI Pod
- [x] auth and short still reach Postgres; the UI cannot

### Verified (2026-09-14) — kindnet **does** enforce; no Calico needed

```
ui           -> postgres:5432   BLOCKED
short-server -> postgres:5432   CONNECTED
site 200 / redirect 302 / login 200
```

Four policies in [k8s/base/networkpolicy.yaml](k8s/base/networkpolicy.yaml):
`default-deny-ingress`, `allow-ingress-nginx-to-apps`, `allow-kubelet-probes`,
`allow-backends-to-postgres`.

**🔴 Trap — a too-broad allow rule silently defeats the whole policy.** The probe
rule was first written as `ipBlock: 10.244.0.0/16` to let kubelet probes through.
That CIDR is the **entire pod network**, so it re-allowed every Pod: the ui→postgres
test connected, which looked exactly like "kindnet ignores NetworkPolicy".

The real probe source is each node's pod-network gateway — visible in the nginx access
log as `10.244.1.1 ... "kube-probe/1.36"`. Narrowing to `10.244.0.1/32`,
`10.244.1.1/32`, `10.244.2.1/32` made the deny real while keeping probes alive.

**A policy that permits too much and a CNI that ignores policy produce identical
symptoms.** Always narrow the allow rules before blaming the CNI.

## 8.4 RBAC

**Concept:** every Pod gets a ServiceAccount, and by default its token is mounted
into the container. Your three services never call the Kubernetes API, so that
token is pure attack surface.

```yaml
      serviceAccountName: short-server
      automountServiceAccountToken: false
```

Then do one small Role / RoleBinding exercise — grant a ServiceAccount permission
to list Pods in the namespace, and verify with:

```powershell
kubectl auth can-i list pods --as=system:serviceaccount:shorten-dev:short-server
```

**Why bother:** Stage 2's IRSA is exactly this idea extended to AWS — *"this
ServiceAccount, not this node, gets these permissions."* RBAC being a mystery here
makes IRSA a mystery there.

- [x] a ServiceAccount per service with `automountServiceAccountToken: false`
- [x] one Role / RoleBinding exercise, verified with `kubectl auth can-i`

### Verified (2026-09-14)

```
ui / auth-server / short-server:  no token mounted
short-server can list pods     -> yes   (Role pod-reader + RoleBinding)
short-server can list secrets  -> no
ui           can list pods     -> no
```

`automountServiceAccountToken: false` is set in **both** places — on the
ServiceAccount and on the Pod spec. The Pod-spec setting is the one that wins.

> `kubectl auth can-i` exits **1** when the answer is "no". That is the tool working,
> not an error.

---

# Part 9 — Package it ✅ DONE

Roadmap §1.8.

## Concept — why not just keep the YAML files

You now have a folder of manifests with a dev hostname, dev image tags, and
in-cluster Postgres hardcoded. To run this on EKS you would copy the folder and
edit — and the two copies drift within a week.

**Kustomize** solves this with a *base* plus *overlays* that patch it. No
templating language, no placeholders — the base is valid YAML you can apply
directly, and an overlay is a patch on top.

**Use Kustomize, not Helm, for your own app.** `kubectl` already bundles it
(v5.8.1), so `kubectl apply -k` needs nothing installed. Helm's value is
distributing charts to other people, and you will use it in Stage 3 to *install*
kube-prometheus-stack — not to author your own.

## Layout

```
k8s/
  kind-cluster.yaml
  base/           namespace, configmap, secret, deployments, services,
                  ingress, postgres statefulset, networkpolicies, rbac
  overlays/dev/   local image tags, 1 replica, in-cluster postgres
  overlays/prod/  ECR images, HPA, RDS endpoint, real TLS   # Stage 2 consumes this
```

Exactly four things differ per environment: **image tag, replica count, hostname,
and whether Postgres is in-cluster or external.** If a fifth appears, ask whether
it should be config instead.

```powershell
kubectl apply -k k8s/overlays/dev
kubectl kustomize k8s/overlays/prod        # render without applying
```

`kubectl kustomize` printing correct YAML for an environment that does not exist
yet is the whole point — Stage 2 starts from a rendered manifest, not a blank file.

- [x] `kubectl apply -k k8s/overlays/dev` brings up everything
- [x] `kubectl kustomize k8s/overlays/prod` renders sensibly

### Final layout

```
k8s/
  kind-cluster.yaml
  bootstrap.ps1              everything kubectl cannot apply
  patches/                   JSON patch files for ingress-nginx + metrics-server
  base/                      the app: 14 resources, no database
  components/postgres/       in-cluster Postgres - dev only
  overlays/dev/              local image tags + postgres + shorten.local
  overlays/prod/             ECR images + RDS (no StatefulSet) + shorten.example.com
```

`prod` renders with **zero StatefulSets** — the in-cluster/external database swap
works, which is what Stage 2 consumes.

**`replicas` was removed from `short-deployment.yaml`.** An HPA owns that field; leaving
both meant every `apply` reset it to 3 and the HPA moved it back.

> `commonLabels` is deprecated in Kustomize v5. Use `labels: [{pairs: {...}, includeSelectors: false}]`.
> `includeSelectors: false` matters — adding labels to an existing Deployment's
> **selector** is rejected, because selectors are immutable.

---

# Part 10 — Stage 1 definition of done ✅ PASSED

The real test: **delete the cluster and rebuild it from this repo.** If that does
not work, the repo is incomplete — which is the actual point of the exercise.

```powershell
kind delete cluster --name shorten
kind create cluster --config k8s/kind-cluster.yaml
# reinstall ingress-nginx, rebuild + kind load images, recreate the Secret, apply -k
```

- [x] one apply against a fresh cluster brings the whole app up healthy
- [x] a single hostname serves UI, API and redirects
- [x] deleting any application Pod is invisible to the user
- [x] a default-deny NetworkPolicy is in force **and proven**
- [ ] you can explain every field you typed  <- only you can tick this one

### The rebuild (2026-09-14)

`kind delete cluster` then `powershell -File k8s/bootstrap.ps1`, exit code 0:

```
3 nodes Ready          ingress controller on shorten-control-plane
5 pods Running         https 200 / http 308
register -> shorten -> follow:  302 -> https://kubernetes.io/
ui -> postgres BLOCKED         short-server -> postgres CONNECTED
uid 101 / 1000 / 1000          quota rejects an oversized Pod
metrics-server reporting       HPA cpu: 14%/60%
deleted a short-server Pod mid-request -> site stayed HTTP 200
```

### 🔴 The first run FAILED — which is the entire point

Three bugs that only a real teardown could expose:

| Bug | Cause | Fix |
| --- | --- | --- |
| both `kubectl patch` calls rejected | PowerShell strips inner `"` when passing JSON to a native exe | `--patch-file k8s/patches/*.json` |
| `Test-Path : Illegal characters in path` | a `` in the script became a literal backspace | rebuilt the path with `Join-Path` |
| patch failure was silent | nothing verified the controller's node | the script now **throws** unless it is on `shorten-control-plane` |

**A bootstrap script that has never run against an empty cluster does not work.**
Pinned `controller-v1.15.1` and `metrics-server v0.9.0` so the next rebuild gets the
manifests that were actually tested.

Then update [progress.md](progress.md) and move to Stage 2.

---

# Appendix A — Repo-specific traps

| # | Trap | Where | Status / fix |
| --- | --- | --- | --- |
| 1 | UI API URLs baked in at build time | [ui/src/lib/api.js](ui/src/lib/api.js) | ✅ fixed — relative paths |
| 2 | `short-server` owned `/`, colliding with the UI | [short-server/src/index.ts](short-server/src/index.ts) | ✅ fixed — mounted at `/r` |
| 3 | TLS forced for any non-`localhost` host | [short-server/src/db/pool.ts](short-server/src/db/pool.ts) | ✅ fixed — reads `sslmode` |
| 4 | `JWT_SECRET` mismatch fails **silently** (401s, no logs) | both backends | one Secret, both Pods — Part 4 |
| 5 | Both backends **exit** if the DB is down at boot | `index.ts`, `main.py` | startupProbe / initContainer — Part 6 |
| 6 | nginx listens on **3000**, not 80 | [ui/nginx.conf](ui/nginx.conf) | Service `targetPort: 3000` |
| 7 | All three images run as root | all three Dockerfiles | Part 8.2 |
| 8 | kindnet may silently ignore NetworkPolicy | cluster | verify with `nc`, else Calico — Part 8.3 |
| 9 | RDS security group allows only your current home IP | AWS | ✅ moot — RDS deleted 2026-09-12, app runs on in-cluster Postgres |
| 10 | `kubectl get secret -o yaml` prints credentials in reversible base64 | any Secret | never paste it anywhere; rotate if you do |

# Appendix B — Command cheat sheet

```powershell
# ---- cluster ----
kind get clusters
kind create cluster --config k8s/kind-cluster.yaml
kind delete cluster --name shorten
kubectl config get-contexts
kubectl config set-context --current --namespace=shorten-dev

# ---- images ----
$SHA = git rev-parse --short HEAD
docker build -t "shorten/ui:$SHA" ./ui
kind load docker-image "shorten/ui:$SHA" --name shorten
docker exec shorten-worker crictl images | Select-String shorten

# ---- the debug loop ----
kubectl get pods
kubectl describe pod <name>
kubectl logs <name>
kubectl logs <name> --previous
kubectl get events --sort-by=.lastTimestamp
kubectl exec -it <name> -- sh

# ---- wiring checks ----
kubectl get endpoints <service>            # <none> = label mismatch
kubectl get deploy,rs,pod                  # the ownership chain
kubectl describe ingress <name>

# ---- rollouts ----
kubectl set image deploy/<name> "<container>=<image>"
kubectl rollout status deploy/<name>
kubectl rollout undo deploy/<name>
kubectl rollout history deploy/<name>

# ---- cleanup ----
kubectl delete namespace shorten-dev       # removes everything you made
```

# Appendix C — Glossary

| Term | Meaning |
| --- | --- |
| **Control loop** | A controller comparing desired state to actual state, forever. The core idea of Kubernetes |
| **Declarative** | You describe the end state, not the steps. `apply` declares; it does not command |
| **Node** | A machine that runs Pods. In kind, a Docker container |
| **Control plane** | API server, scheduler, controllers — the brain |
| **kubelet** | The agent on each node that actually starts containers |
| **containerd** | The container runtime. Each kind node has its own, separate from Docker Desktop |
| **Endpoints** | The live list of Pod IPs behind a Service. Empty = broken label selector |
| **CNI** | The network plugin. Provides Pod networking and enforces NetworkPolicy |
| **CrashLoopBackOff** | Container keeps dying; Kubernetes is spacing out its retries. Not an error type |
| **ImagePullBackOff** | The kubelet cannot fetch the image. In kind, usually a missing `kind load` |
| **OOMKilled** | Kernel killed the container for exceeding `limits.memory`. Shows under `Last State` |
| **Pending** | The scheduler could not place the Pod. `describe` says why |
| **Headless Service** | `clusterIP: None` — returns Pod IPs directly instead of load-balancing. Used by StatefulSets |
| **IRSA** | Stage 2: AWS IAM permissions granted to a ServiceAccount rather than a node |
