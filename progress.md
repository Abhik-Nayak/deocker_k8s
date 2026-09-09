# Progress Tracker — Kubernetes

Shorten-URL three-tier app → local Kubernetes → AWS EKS.
Roadmap: [K8S_ROADMAP.md](K8S_ROADMAP.md) (Stages 0–3)

Branch: `only_kubernets_practice` · Region when we get to AWS: **ap-south-1**

---

## Current status

**Stage 0 — not started.** The branch was just cleaned of the Docker and ECS
Fargate material (that work continues on `only_docker_practice`). What remains
here is the application plus its three Dockerfiles.

No Kubernetes manifests exist yet. No AWS resources for this track.

---

## Stage checklist

### Stage 0 — Baseline
- [ ] App runs end-to-end locally (register → shorten → history → redirect)
- [ ] Local Postgres chosen and `DATABASE_URL` set in both `.env` files
- [ ] Can draw the request path for all three flows

### Stage 1 — Local Kubernetes
- [ ] 1.1 Local cluster up (kind or minikube); Deployments for all three services
- [ ] 1.2 ClusterIP Services; service-to-service by cluster DNS
- [ ] 1.3 ConfigMap + shared `JWT_SECRET` Secret
- [ ] 1.4 Postgres StatefulSet with PVC; data survives Pod deletion
- [ ] 1.5 Probes, resource requests/limits, HPA, rollout + rollback
- [ ] 1.6 Ingress — **Decision A** (UI relative paths) and **Decision B**
      (root-path collision) resolved
- [ ] 1.7 Namespace, non-root containers, default-deny NetworkPolicy, RBAC
- [ ] 1.8 Packaged as Helm chart or Kustomize base + overlays

### Stage 2 — AWS
- [ ] ECR repos with immutable SHA tags
- [ ] VPC: 2 AZs, private nodes, subnets tagged for the AWS controllers
- [ ] EKS cluster + managed node group
- [ ] AWS Load Balancer Controller → ALB from Ingress; ACM + HTTPS
- [ ] IRSA in place; no static AWS creds in Pods
- [ ] RDS Postgres, private only; secrets from Secrets Manager
- [ ] Route 53 hostname

### Stage 3 — Production shape
- [ ] kube-prometheus-stack installed
- [ ] `/metrics` on both backends, scraped via ServiceMonitor
- [ ] Grafana dashboards (rate, errors, p95, saturation + business panel)
- [ ] Alertmanager rules firing on a deliberate break
- [ ] Logs shipping to CloudWatch
- [ ] AZ spread, autoscaling, failure drills documented
- [ ] GitHub Actions CI (build, scan, manifest validation) on PR
- [ ] ECR push on merge via OIDC
- [ ] Deploy to dev automatically; prod behind manual approval
- [ ] One-command rollback verified

---

## Known blockers carried in from the app

These are real issues in the current code that Stage 1 has to resolve. Details
in the roadmap's section 1.6.

1. **UI API URLs are baked in at build time** — `ui/src/lib/api.js` uses
   `VITE_AUTH_URL` / `VITE_SHORT_URL`, which Vite inlines into the bundle. One
   image cannot serve two environments, and the browser calls both backends
   directly, forcing wide-open CORS. Fix: relative paths behind one Ingress.
2. **`short-server` owns `/`** — the redirect router is mounted at the root and
   answers `GET /:code`, colliding with the UI under a single hostname. Fix:
   prefix the redirect route, or give short links their own host.
3. **No database in the repo** — Supabase and the RDS instance are both gone.
   `docker-compose.yaml` has no Postgres service either, so Stage 0 needs one
   supplied. Note that a `DATABASE_URL` of `localhost` works for `npm run dev`
   but *not* inside Compose, where `localhost` is the container itself — use
   `host.docker.internal`, or add a `postgres` service to the compose file.
   Stage 1 runs Postgres in-cluster; Stage 2 moves it to RDS.
4. **All three images run as root**, with no resource limits and no
   securityContext. Addressed in Stage 1.5 and 1.7.

---

## Log

### 2026-09-09 — branch cleanup

Removed the material that belonged to the Docker/ECS track, all of which is
preserved on `only_docker_practice` (local and pushed to origin):
`01DockerNotes.md`, the old ECS-Fargate `progress.md`, and
`architecture_image_roadmap/` (ECS roadmap, Phase 2 AWS setup notes, 3 images).

Kept: the three services, their Dockerfiles and `.dockerignore`/`.env.example`
files, `docker-compose.yaml` (the baseline to translate into manifests), and the
root npm scripts for running the app without containers.

Added `K8S_ROADMAP.md` and reset this tracker.
