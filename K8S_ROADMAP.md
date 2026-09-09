# Kubernetes Roadmap — ShortenURL

Branch purpose: learn Kubernetes properly on a real three-tier app, then run it
in AWS as something production-shaped.

Not a "30 days" plan. Four stages, each with a **definition of done**. Move on
only when the definition of done is true — the stages build on each other.

```
Stage 0  Baseline      know exactly what you are deploying        (short)
Stage 1  Local k8s     the whole app on your laptop, k8s-native   (the long one)
Stage 2  AWS           EKS + ECR + real VPC networking/security
Stage 3  Production    reliability, Prometheus/Grafana, CI/CD
```

---

## The app you are deploying

| Service        | Stack                    | Port | Owns    | Health    |
| -------------- | ------------------------ | ---- | ------- | --------- |
| `ui`           | React (Vite) → nginx     | 3000 | —       | none yet  |
| `auth-server`  | Python FastAPI + psycopg | 4000 | `users` | `/health` |
| `short-server` | Node + Express + TS + pg | 5000 | `links` | `/health` |
| Postgres       | not in the repo yet      | 5432 | both    | —         |

Two facts that shape every manifest you will write:

1. **`auth-server` and `short-server` must share the same `JWT_SECRET`.** Auth
   signs the token, short verifies it locally — no service-to-service call.
   A mismatch means every logged-in request silently fails.
2. **Both services create their own table on startup** (`CREATE TABLE IF NOT
   EXISTS`, from their `schema.sql`). So there is no migration step to run — but
   it also means each one needs the database reachable *before* it can be Ready.

---

## Stage 0 — Baseline

**Goal:** the app runs, and you can name what talks to what. One evening.

1. Run it with Compose (`docker-compose.yaml`) or `npm run dev`. Register,
   shorten a URL, see it in history, follow the short link.
2. Note there is **no database in the repo**. The old Supabase and RDS instances
   are both gone. Use a throwaway local Postgres for now — Stage 1 replaces it
   with an in-cluster StatefulSet.
3. Read the three `Dockerfile`s and say out loud which port each image exposes
   and what its `CMD` is. You are about to re-type these into manifests.

**Done when:** you can draw the request path for *register*, *shorten*, and
*follow a short link*, including which service touches the database.

---

## Stage 1 — Local Kubernetes

**Goal:** the entire app on a local cluster using the real primitives — not one
mega-Pod. This is where the actual learning happens. Do not rush it to get to
AWS.

Use **kind** or **minikube**. kind is faster and closer to a real cluster;
minikube has a friendlier `addons` story for Ingress. Either is fine — pick one
and stay on it.

### 1.1 Pods and Deployments

- One Deployment per service. Use `kubectl run` for a bare Pod once, to feel the
  difference, then never again.
- Get images into the cluster: `kind load docker-image` or
  `minikube image load`, with `imagePullPolicy: IfNotPresent`. Understand why
  `:latest` will bite you, then tag by git SHA instead.
- Practice the loop that matters: `kubectl describe`, `logs`,
  `logs --previous`, `exec -it`, `get events --sort-by=.lastTimestamp`.
- Break things deliberately and learn the symptoms: `ImagePullBackOff`,
  `CrashLoopBackOff`, `Pending` (unschedulable), `OOMKilled`.

### 1.2 Services and cluster DNS

- A ClusterIP per service. Reach `auth-server` from inside another Pod as
  `http://auth-server:4000` — that DNS name is what replaces Compose's
  service-name networking.
- Try NodePort and `port-forward` once, so you know why neither is your answer
  for real traffic.

### 1.3 Config and Secrets

- `ConfigMap` for the boring values (`PORT`, `PUBLIC_BASE_URL`).
- **One `Secret` holding `JWT_SECRET`, mounted into both backends.** This is the
  natural first Secret in this app, and it makes the shared-secret coupling
  visible instead of accidental. Put `DATABASE_URL` alongside it.
- Know that a plain Secret is base64, not encryption. Note where that gets
  solved in Stage 2 (Secrets Manager / External Secrets / IRSA).

### 1.4 Database in-cluster: StatefulSet and storage

- Postgres as a `StatefulSet` with a `volumeClaimTemplate` and a headless
  Service. Delete the Pod and watch the data survive; delete the PVC and watch
  it not.
- This is the cleanest way to learn PV / PVC / StorageClass, and *why* a
  Deployment is the wrong shape for a database.

### 1.5 Health, resources, self-healing

- `readinessProbe` and `livenessProbe` on `/health` for both backends. The UI
  has no health endpoint — probe `/` on nginx, or add one.
- Add a `startupProbe` where the database connect is slow. Both backends exit on
  DB failure, so you can watch Kubernetes restart them until Postgres is up.
- Set `requests` and `limits` on everything. Then set one limit deliberately too
  low and meet `OOMKilled` on purpose.
- Scale `short-server` to 3 replicas and confirm redirects still work — it is
  stateless, so they should. Then add an `HPA` on CPU.
- `RollingUpdate` with `maxUnavailable: 0`, plus a `PodDisruptionBudget`. Roll
  out a bad image, watch it stall, then `kubectl rollout undo`.

### 1.6 Ingress — and two real decisions this app forces

Install `ingress-nginx`. Before you write the Ingress, settle these two. They
are genuine blockers in the current code, not hypotheticals.

**Decision A — the UI's API URLs are baked in at build time.**
[ui/src/lib/api.js](ui/src/lib/api.js#L1-L2) reads `VITE_AUTH_URL` and
`VITE_SHORT_URL`, and Vite inlines them into the built bundle. Two consequences:
one image cannot serve two environments, and the browser calls both backends
*directly*, so both have to be publicly exposed and CORS has to stay wide open
(`allow_origins=["*"]` in auth, bare `cors()` in short).

The Kubernetes-correct fix, which makes the rest of this roadmap much easier:
change the UI to call **relative paths** (`/auth/*`, `/api/*`) and let one
Ingress route them to the right Service. One image, one hostname, one public
entrypoint, no CORS. Do it here — carrying build-time URLs forward is exactly
what made the earlier ECS attempt awkward.

**Decision B — `short-server` owns the root path.**
[short-server/src/index.ts](short-server/src/index.ts#L22) mounts the redirect
router at `/`, so it answers `GET /:code`. Under a single hostname that collides
with the UI at `/`. Pick one:

- prefix the redirect route (`/r/:code`) and set `PUBLIC_BASE_URL` to match —
  simplest;
- or give short links their own host (`s.local`) with a second Ingress rule —
  closest to how real shorteners do it.

Then work through host-based rules, path-based rules, `pathType` (`Prefix` vs
`ImplementationSpecific`), and one rewrite annotation until you can say what it
actually rewrites. Finish with local TLS: a self-signed cert in a `tls` Secret.

### 1.7 Security and isolation

- Its own `Namespace` (`shorten-dev`), not `default`. Add a `ResourceQuota`.
- `securityContext`: `runAsNonRoot`, `readOnlyRootFilesystem`, drop all
  capabilities. All three images currently run as root — fixing that is about
  two lines per Dockerfile.
- `NetworkPolicy`, and this app is a perfect case for it: default-deny in the
  namespace, then allow only `ingress-nginx → ui/auth/short` and
  `auth/short → postgres:5432`. Prove it by `exec`ing into the UI Pod and
  failing to reach Postgres.
- A dedicated `ServiceAccount` per service with no API access, plus one small
  `Role` / `RoleBinding` exercise so RBAC is not a mystery in Stage 2.

### 1.8 Package it

Move the manifests into a Helm chart, or a Kustomize base with overlays. The
values that differ per environment are: image tag, replica count, hostname, and
whether Postgres is in-cluster or external. That split is what Stage 2 consumes.

```
k8s/
  base/           namespace, configmap, secret, deployments, services,
                  ingress, postgres statefulset, networkpolicies
  overlays/dev/   local images, 1 replica, in-cluster postgres
  overlays/prod/  ECR images, HPA, RDS endpoint, real TLS
```

**Done when:** one apply against a fresh cluster brings the whole app up
healthy; a single hostname serves UI, API and redirects; deleting any
application Pod is invisible to the user; a default-deny NetworkPolicy is in
force; and you can explain every field you typed.

---

## Stage 2 — AWS: EKS, ECR, networking, security

**Goal:** the same chart running on EKS, reachable over the internet, with the
data layer and secrets done the AWS way.

Cost discipline matters here. An EKS control plane bills around $0.10/hr whether
you use it or not, and a NAT Gateway is the other silent cost. **Tear the
cluster down between sessions.**

1. **ECR** — one repo per service, scan-on-push, immutable tags, git-SHA tags,
   and a lifecycle policy so old images do not pile up.
2. **VPC** — two AZs, public and private subnets, IGW, NAT. Nodes in the
   **private** subnets, load balancer in the public ones. Tag the subnets
   correctly (`kubernetes.io/role/elb`, `kubernetes.io/role/internal-elb`) or the
   AWS controllers will not find them — this is the single most common EKS setup
   failure.
3. **Cluster** — start with a managed node group; it is predictable and easy to
   reason about. Try Fargate profiles or Karpenter afterwards as a comparison,
   not first.
4. **Ingress** — the AWS Load Balancer Controller turning your Ingress into a
   real ALB. This is where the Stage 1 single-entrypoint decision pays off: one
   ALB, one hostname. Then an ACM certificate, HTTPS, and an HTTP→HTTPS redirect.
5. **Identity** — IRSA (IAM Roles for Service Accounts). Understand it as "this
   ServiceAccount, not this node, gets these permissions", and why granting the
   node role instead is the lazy insecure alternative.
6. **Data** — RDS Postgres in the private subnets, security group allowing 5432
   only from the node/Pod security group. Deliver `DATABASE_URL` from Secrets
   Manager via External Secrets or the Secrets Store CSI driver, not a
   checked-in Secret.
7. **DNS** — a Route 53 record for your hostname; optionally ExternalDNS so the
   Ingress manages its own record.

**Done when:** the app answers over HTTPS on a real domain, no Pod holds a
long-lived AWS credential, Postgres is unreachable from the internet, and you
can destroy and rebuild the cluster from your chart plus infra code.

---

## Stage 3 — Production shape

**Goal:** the part that separates "it runs on EKS" from "I would put real
traffic on this."

### Observability

- `kube-prometheus-stack` (Prometheus + Grafana + Alertmanager) via Helm.
- Instrument both backends with a `/metrics` endpoint — `prom-client` for Node,
  `prometheus-fastapi-instrumentator` for FastAPI — and scrape them with a
  `ServiceMonitor`. Cluster metrics alone teach you half the lesson; app metrics
  are the half that matters.
- Grafana dashboards for the four signals that actually page someone: request
  rate, error rate, p95 latency, and saturation (CPU/memory against limits).
  Plus one business panel: shortens per minute, redirects per minute.
- Alertmanager rules with real thresholds: 5xx rate, Pods crash-looping,
  `PodDisruptionBudget` violated, RDS connections near max, PVC nearly full.
- Logs: Fluent Bit to CloudWatch — and know why logs and metrics stay separate.

### Reliability

- An HPA driven by a metric that reflects load, not just CPU.
- `topologySpreadConstraints` across AZs, so losing one AZ is survivable.
- Cluster Autoscaler or Karpenter, plus a `PriorityClass`.
- Then actually test it: kill a node, drain a node, delete the Postgres Pod,
  blow past a memory limit. Write down what the user saw each time.

### CI/CD with GitHub Actions

- **CI on PR:** build all three images, run `tsc` and lint, scan with Trivy,
  validate manifests (`kubeconform`), and show a `helm template` diff. No
  cluster access needed for any of it.
- **On merge to main:** build once, tag with the git SHA, push to ECR.
  Authenticate with **OIDC**, not stored access keys — the same
  short-lived-credential idea as IRSA, applied to CI.
- **Deploy:** update the image tag and roll out. Start with Actions running
  `helm upgrade` against dev. Then add a GitOps controller (Argo CD or Flux) so
  the cluster pulls its desired state instead of CI pushing it, and understand
  why the pull model wins once more than one person can deploy.
- **Promotion:** dev deploys automatically; prod requires a manual approval via
  GitHub Environments. Verify with `kubectl rollout status`, and roll back
  automatically on failure.

**Done when:** a merge to `main` puts a new SHA-tagged image in production with
no manual step, a Grafana dashboard shows the effect, an alert fires when you
deliberately break something, and you can roll back with one command.

---

## Ground rules

- **Write every manifest by hand at least once.** Generated YAML you did not
  type is YAML you cannot debug at 2am.
- **One concept per commit.** Keep `progress.md` current — it is what makes this
  reviewable later.
- **Destroy and rebuild often.** If the cluster cannot be recreated from this
  repo, the repo is incomplete.
- **On AWS, tear down between sessions.** The EKS control plane and NAT Gateway
  bill by the hour.

## Not in scope on this branch

Docker fundamentals and the ECS Fargate track live on `only_docker_practice`
(`01DockerNotes.md`, the ECS roadmap, and the Phase 2 AWS setup notes). This
branch assumes you can already build and run the three images.
