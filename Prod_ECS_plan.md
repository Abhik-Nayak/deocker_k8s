# ShortenURL → AWS ECS Fargate, with GitHub Actions CI/CD

## Context

Two developers built **ShortenURL**, a three-service app that today only runs on
`localhost` via `npm run dev`. It needs to run on a server.

What actually exists on branch `only_docker_practice`:

| Service | Stack | Port | Owns |
| --- | --- | --- | --- |
| [ui/](ui/) | React 18 + Vite 5 SPA, no router, single page | 3000 | — |
| [auth-server/](auth-server/) | Python FastAPI + uvicorn + psycopg | 4000 | `users` |
| [short-server/](short-server/) | Node 20 + Express 4 + TypeScript + `pg` | 5000 | `links` |

The two backends **never call each other** — `auth-server` signs an HS256 JWT,
`short-server` verifies it locally with the same `JWT_SECRET`. Both talk to one
shared Postgres (today: a public Supabase instance) and each runs
`CREATE TABLE IF NOT EXISTS` on boot, so there is no migration step.

**Nothing operational exists yet.** Despite the repo name and
[01DockerNotes.md](01DockerNotes.md), there are no Dockerfiles (only three
`.dockerignore` stubs), no compose file, no CI, no IaC. This plan builds all of
it from zero.

### Constraints the user set

1. **AWS ECS (Fargate) only** for compute — no EKS, no Lambda, no S3/CloudFront
   static hosting. The UI is served by an nginx container on ECS.
2. **GitHub Actions** for CI/CD, using OIDC (no long-lived AWS keys in secrets).
3. **Secure network** — RDS Postgres in private subnets, never publicly
   reachable; every security group scoped to another security group, not a CIDR.
4. **Terraform** for all infrastructure.
5. **Production only**, one environment.
6. **HTTP only.** No domain, no TLS. See *Accepted risks* below.
7. **This is a learning exercise, destroyed after ~2 hours. Cost must be near
   zero.** This constraint drives several deliberate deviations from what I'd
   build for real; each one is flagged as `[cost]` with the production
   alternative stated.

### Toolchain (verified present on this machine)

| Tool | Version | Status |
| --- | --- | --- |
| AWS CLI | 1.45.46 | authenticated as `arn:aws:iam::786174827428:user/AbhikIAM` |
| Default region | `ap-south-1` (Mumbai) | matches prior work in this repo |
| Terraform | 1.15.4 | ready |
| Docker | 29.7.2 | ready |

Nothing needs installing. All costs below are quoted at ap-south-1 rates.

The account is currently **clean** — no ECS clusters, RDS instances, load
balancers, or ECR repositories exist in `ap-south-1`. (The `todo-db` RDS endpoint
hardcoded in the old `k8s/01-configmap.yaml` on the `dev` branch is already gone.)
So the cost estimate below is the whole bill, and a clean `terraform destroy`
returns the account to zero.

---

## Target architecture

```
                    Internet
                        │  HTTP :80
              ┌─────────▼──────────┐
              │        ALB         │   public subnets, 2 AZ
              │  (single origin)   │   SG: 0.0.0.0/0 → :80
              └─────────┬──────────┘
        ┌───────────────┼────────────────┐
   /auth/*           /api/*          / , /assets/*
   (rule 100)       (rule 200)        (rule 300)
        │               │                 │        default rule → short-server
        ▼               ▼                 ▼        (bare /{code} redirects)
  ┌───────────┐  ┌────────────┐   ┌────────────┐
  │auth-server│  │short-server│   │  ui:nginx  │   3 Fargate services
  │  :4000    │  │   :5000    │   │    :80     │   desired_count = 1
  └─────┬─────┘  └─────┬──────┘   └────────────┘   SG: only from ALB SG
        │              │
        └──────┬───────┘  :5432, SG: only from tasks SG
               ▼
        ┌──────────────┐
        │ RDS Postgres │   private subnets, publicly_accessible = false
        │ db.t4g.micro │   no route to the internet at all
        └──────────────┘
```

### The one design decision that makes everything else simple

**Serve all three services from a single ALB origin and let the UI use relative
URLs.** This kills three problems at once:

- **The Vite build-time trap.** [ui/src/lib/api.js:1-2](ui/src/lib/api.js#L1-L2)
  reads `import.meta.env.VITE_AUTH_URL` / `VITE_SHORT_URL`, which Vite *bakes
  into the bundle at build time*. Normally that means the UI image is pinned to
  one environment's URLs and CI has to know the ALB DNS name before it can
  build. Setting both to the **empty string** makes `fetch` use relative paths
  (`??` only falls back on `null`/`undefined`, so `""` survives). The UI image
  becomes environment-agnostic — build once, deploy anywhere.
- **CORS.** Both backends currently use `allow_origins=["*"]`
  ([auth-server/app/main.py:20-25](auth-server/app/main.py#L20-L25),
  [short-server/src/index.ts:13](short-server/src/index.ts#L13)). Same origin
  means no preflight and no wildcard needed.
- **A chicken-and-egg on the ALB DNS name** for the frontend build.

`PUBLIC_BASE_URL` for short-server still needs the real ALB DNS name, but that's
a *runtime* env var, so Terraform wires `http://${aws_lb.main.dns_name}` straight
into the task definition.

### ALB listener rules

`GET /:code` in [short-server/src/index.ts:22](short-server/src/index.ts#L22) is
a catch-all mounted at `/`, which collides with the SPA at `/`. Because the UI
has no client-side router (single page, no `react-router`), an explicit
allow-list for the UI plus a catch-all default resolves it cleanly:

| Priority | Match | Target |
| --- | --- | --- |
| 100 | `/auth/*` | auth-server TG :4000 |
| 200 | `/api/*` | short-server TG :5000 |
| 300 | `/`, `/index.html`, `/assets/*`, `/favicon.ico`, `/vite.svg`, `/healthz` | ui TG :80 |
| default | everything else | short-server TG :5000 |

Target-group health checks bypass listener rules and hit targets directly:
auth → `/health`, short → `/health`, ui → `/healthz` (added in nginx.conf).

---

## Estimated cost (ap-south-1, ~2 hours)

| Item | Rate | 2 hours |
| --- | --- | --- |
| ALB | $0.0225/hr + LCU | ~$0.06 |
| Fargate ×3 @ 0.25 vCPU / 0.5 GB | $0.0426/hr total | ~$0.09 |
| RDS db.t4g.micro + 20 GB gp3 | ~$0.017/hr + storage | ~$0.04 |
| Public IPv4 addresses (~5) | $0.005/hr each | ~$0.05 |
| ECR storage, SSM Standard, CloudWatch Logs | free tier / negligible | ~$0.00 |
| **Total** | | **≈ $0.25** |

**Traps avoided:**
- **Secrets Manager bills $0.40 per secret per month** regardless of a 2-hour
  lifetime → use **SSM Parameter Store `SecureString`, which is free**.
- **NAT Gateway** is $0.045/hr + $0.045/GB and takes minutes to create *and*
  destroy → skipped entirely (see below).
- **VPC interface endpoints** bill per hour *per AZ* — for a 2-hour run they'd
  cost more than the NAT they replace → skipped.
- **CloudWatch log groups survive `terraform destroy`** if not managed by
  Terraform → they are declared explicitly with `retention_in_days = 1`.

### `[cost]` Deliberate deviations from a production build

| Here | Production would be |
| --- | --- |
| ECS tasks in **public subnets** with `assign_public_ip = true`, no NAT Gateway. Inbound is still fully blocked — the task SG only allows the ALB SG. | Private subnets + NAT Gateway (or VPC endpoints for ECR/S3/SSM/Logs). |
| **Local Terraform state** (`terraform.tfstate` on disk) | S3 backend + DynamoDB state locking |
| Single AZ RDS, `backup_retention_period = 0`, `skip_final_snapshot = true` | Multi-AZ, 7-day backups, final snapshot, deletion protection |
| `desired_count = 1`, no autoscaling | ≥2 tasks per service across AZs + target-tracking autoscaling |
| HTTP only | ACM cert + HTTPS listener + HTTP→HTTPS redirect |

Public subnets without NAT do **not** break anything: ECR pulls, SSM Parameter
Store reads, and CloudWatch Logs all go out over the task's own public IP.

---

## Phase 1 — Containerize (do this locally first, no AWS)

This is STEP 1–5 of the team's own [01DockerNotes.md](01DockerNotes.md), and it
must work locally before any Terraform runs.

### New files

**`auth-server/Dockerfile`** — `python:3.12-slim`, install
[requirements.txt](auth-server/requirements.txt), non-root `USER`, and critically:

```dockerfile
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "4000"]
```

`--host 0.0.0.0` is mandatory. The current scripts
([package.json:14,21](package.json#L14-L21)) omit it, so uvicorn binds
`127.0.0.1` and the container would be unreachable from the ALB. `psycopg[binary]`
ships wheels, so no build toolchain is needed.

**`short-server/Dockerfile`** — multi-stage, `node:20-alpine`:
- Stage 1: `npm ci` (full, **including devDependencies** — `typescript` is a
  devDependency so `--omit=dev` cannot precede the build), then `npm run build`.
  That script is `tsc` **plus a node one-liner that copies
  `src/db/schema.sql` → `dist/db/schema.sql`` — `dist/db/schema.sql` must survive
  into the final image or `initSchema()` throws at startup.
- Stage 2: `npm ci --omit=dev`, copy `dist/`, non-root, `CMD ["node","dist/index.js"]`.

**`ui/Dockerfile`** — multi-stage:
- Stage 1: `npm ci`, `npm run build` with `VITE_AUTH_URL=""` / `VITE_SHORT_URL=""`.
- Stage 2: `nginx:alpine`, copy `dist/` to `/usr/share/nginx/html`, copy the new
  `ui/nginx.conf`, `EXPOSE 80`.

**`ui/nginx.conf`** (new) — SPA fallback `try_files $uri $uri/ /index.html`,
`location = /healthz { return 200 "ok\n"; }` for the ALB health check, immutable
caching on `/assets/`, `no-cache` on `index.html`, gzip.

**`ui/.env.production`** (new) — two empty values:
```
VITE_AUTH_URL=
VITE_SHORT_URL=
```
This is what switches the UI to relative paths. No change to
[ui/src/lib/api.js](ui/src/lib/api.js) is required.

**`docker-compose.yml`** (repo root, new) — local parity: a `postgres:16-alpine`
service with a healthcheck, the three app services, one user-defined bridge
network, and an nginx or Traefik front door replicating the ALB path rules so
local behaviour matches production. Uses a root `.env` (gitignored).

### Existing files that need no change

- [short-server/src/db/pool.ts:8](short-server/src/db/pool.ts#L8) — the TLS
  heuristic (`ssl` on for any host that isn't `localhost`/`127.0.0.1`) is
  already correct for RDS. It also correctly disables TLS for the local
  compose Postgres.
- Both `schema.sql` files use `gen_random_uuid()`, which is **built into
  Postgres 13+** — RDS Postgres 16 needs no `pgcrypto` extension.
- Both `/health` endpoints already exist and return 200.

### `.dockerignore`

All three already list `node_modules`, `dist`, `.env` — correct as-is. Verify
`.env` is excluded so no local Supabase credential is baked into an image.

---

## Phase 2 — Terraform

Flat layout under `infra/` — readable over clever, since this doubles as a
learning artifact.

```
infra/
├── versions.tf              # terraform >= 1.6, aws provider ~> 5.0
├── providers.tf             # region var, default_tags
├── variables.tf             # region, project, db_username, container sizes
├── network.tf               # VPC 10.0.0.0/16, 2 public + 2 private subnets,
│                            #   IGW, route tables, 3 security groups
├── ecr.tf                   # 3 repos, force_delete = true, lifecycle policy
├── rds.tf                   # subnet group + db.t4g.micro Postgres 16
├── ssm.tf                   # SecureString params (free)
├── iam.tf                   # ECS exec role, task role, GitHub OIDC role
├── alb.tf                   # ALB, 3 target groups, listener + 3 rules
├── ecs.tf                   # cluster, 3 task definitions, 3 services
├── logs.tf                  # 3 log groups, retention_in_days = 1
├── outputs.tf               # alb_dns_name, ecr URLs, oidc role arn
└── terraform.tfvars.example
```

### Security groups (the "secure network" requirement)

Three SGs, each referencing another SG rather than a CIDR:

- `alb_sg` — ingress `0.0.0.0/0:80`, egress to `tasks_sg`.
- `tasks_sg` — ingress **only from `alb_sg`** on 80/4000/5000. Egress
  `0.0.0.0/0` (needed for ECR/SSM/Logs without a NAT).
- `rds_sg` — ingress **only from `tasks_sg`** on 5432. No egress rule needed.

RDS gets `publicly_accessible = false` and lives in the private subnets, which
have **no internet route at all**. The database becomes unreachable from
anywhere except the three task ENIs — a real improvement over the current
public Supabase instance.

### Secrets — SSM Parameter Store `SecureString`

| Parameter | Value | Consumed by |
| --- | --- | --- |
| `/shortenurl/prod/DATABASE_URL` | built from the RDS endpoint + generated password, with `?sslmode=require` | both backends |
| `/shortenurl/prod/JWT_SECRET` | `random_password` — **one parameter, referenced by both task definitions** | both backends |

`JWT_SECRET` being a *single* parameter is the point. Today both services
default to the literal string `"super-secret-change-me"`
([auth-server/app/config.py:12](auth-server/app/config.py#L12),
[short-server/src/config.ts:8](short-server/src/config.ts#L8)) — anyone can forge
a token for any user and read their link history. Worse, if the two values ever
drift, login "succeeds" but every request is silently treated as anonymous, with
no error anywhere. One parameter makes drift structurally impossible.

Task definitions reference these through the `secrets` block (never `environment`),
so values never appear in `describe-task-definition` output or CloudWatch.

### ECS

- One cluster, `FARGATE` capacity provider, Container Insights **off** `[cost]`.
- 3 task definitions, 256 CPU / 512 MB, `awsvpc`, `awslogs` driver.
- 3 services, `desired_count = 1`, in public subnets, `assign_public_ip = true`,
  `health_check_grace_period_seconds = 60`.

The grace period matters: `auth-server`'s psycopg pool **hard-fails startup with
no retry** if the DB is unreachable, unlike short-server which retries 3× with
backoff. Terraform `depends_on` the RDS instance, and the grace period stops ECS
from killing a task that's still connecting.

> With `desired_count = 1` there is no `CREATE TABLE IF NOT EXISTS` race between
> replicas, so no separate migration task is needed. **If you ever scale past 1,
> revisit this** — concurrent DDL on the same table will produce noisy (though
> ultimately harmless) errors.

### The Terraform ↔ CI/CD boundary (the classic mistake)

Terraform creates the task definitions, but GitHub Actions registers new
revisions on every deploy. Without guarding this, the next `terraform apply`
would roll the service back to the image Terraform last knew about.

```hcl
resource "aws_ecs_service" "app" {
  # ...
  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }
}
```

**Terraform owns the infrastructure; the pipeline owns the image tag.**

### Apply order

Fargate services cannot start before images exist in ECR:

```bash
cd infra
terraform init
terraform apply -target=aws_ecr_repository.ui \
                -target=aws_ecr_repository.auth_server \
                -target=aws_ecr_repository.short_server
# push the three images (locally or via the GitHub Actions workflow)
terraform apply
```

---

## Phase 3 — GitHub Actions

### `.github/workflows/deploy.yml`

Triggered on push to the working branch. Permissions `id-token: write`,
`contents: read` — **OIDC only, no `AWS_ACCESS_KEY_ID` secret anywhere.**

1. `aws-actions/configure-aws-credentials@v4` with `role-to-assume` (the OIDC
   role Terraform created, trust policy scoped to `repo:<owner>/<repo>:ref:refs/heads/<branch>`).
2. `aws-actions/amazon-ecr-login@v2`.
3. **Matrix over the three services**: build, tag with `${{ github.sha }}`
   (**never `latest`** — the team's own stated discipline), push to ECR. Use
   `docker/build-push-action` with GitHub Actions layer caching.
4. Per service: `aws ecs describe-task-definition` → 
   `aws-actions/amazon-ecs-render-task-definition` (swap in the new image) →
   `aws-actions/amazon-ecs-deploy-task-definition` with `wait-for-service-stability: true`.

Rollback is `aws ecs update-service --task-definition <previous-revision>`, since
every revision is retained and tagged by SHA.

### `.github/workflows/ci.yml` (runs on PRs, deploys nothing)

`tsc --noEmit` for short-server, `vite build` for ui, `python -m compileall` for
auth-server, plus `docker build` on all three to catch Dockerfile breakage.

> There are currently **no tests and no linters** in any `package.json` or
> `requirements.txt`, so a "test" stage would be a no-op today. The workflow is
> structured with the step present but trivially passing, so tests slot in later
> without touching the pipeline.

---

## Phase 4 — Verify end to end

```bash
ALB=$(terraform -chdir=infra output -raw alb_dns_name)

curl -i  http://$ALB/healthz                    # nginx  → 200 "ok"
curl -i  http://$ALB/health                     # short  → {"status":"ok",...}
curl -i  http://$ALB/auth/register -X POST \
     -H 'Content-Type: application/json' \
     -d '{"email":"a@b.com","password":"pass1234"}'   # → {access_token, user}

TOKEN=<access_token from above>
curl -i  http://$ALB/api/shorten -X POST \
     -H "Authorization: Bearer $TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{"url":"https://example.com"}'          # → shortUrl must be http://$ALB/<code>,
                                                 #   NOT http://localhost:5000/<code>
curl -i  http://$ALB/<code>                      # → 302 to https://example.com
curl -s  http://$ALB/api/links -H "Authorization: Bearer $TOKEN"   # clicks == 1
```

Then open `http://$ALB/` in a browser and drive register → shorten → history.
Watch the browser network tab: every call must be **relative and same-origin**
(`/auth/login`, not `http://localhost:4000/auth/login`). Any `localhost` call
means `ui/.env.production` didn't take effect during the image build.

Also confirm the security boundary actually holds:

```bash
psql "postgresql://...@<rds-endpoint>:5432/postgres"   # must TIME OUT from your laptop
```

CI is verified by pushing a trivial UI change and watching the workflow build,
push a SHA-tagged image, and roll the service — with no downtime, since ECS
rolling deployment keeps the old task until the new one passes health checks.

---

## Phase 5 — Teardown (run this; it's the whole point of the 2-hour budget)

```bash
terraform -chdir=infra destroy
```

Things that commonly strand billable resources — all pre-handled above:

| Risk | Handled by |
| --- | --- |
| ECR repo won't delete with images in it | `force_delete = true` |
| RDS destroy blocked on a final snapshot | `skip_final_snapshot = true`, `deletion_protection = false` |
| ALB deletion protection | left disabled |
| Log groups linger and accrue storage | declared in Terraform, `retention_in_days = 1` |
| ENIs hold the subnet open | ECS services are Terraform-managed, so tasks drain first |

After destroy, confirm in the console that **ECS services, RDS, ALB, NAT (none),
and Elastic IPs (none)** are all gone. Public IPv4 addresses bill hourly, so a
stranded ALB or EIP is the most likely surprise on a bill.

---

## Fitting this into ~2 hours

RDS is the long pole: roughly **8–12 minutes to create** and **3–5 minutes to
destroy**, and nothing else depends on finishing first. So kick it off early and
build containers while it provisions.

| | Step | Wall clock |
| --- | --- | --- |
| 1 | Write Dockerfiles + `nginx.conf` + compose; verify all three locally | ~30 min |
| 2 | Write `infra/`; `terraform apply` **ECR + VPC + RDS first** | ~15 min to write, then RDS provisions in the background |
| 3 | Build + push the three images to ECR while RDS provisions | ~10 min |
| 4 | `terraform apply` the rest (ALB, ECS, SSM, IAM) | ~5 min |
| 5 | Verify end-to-end with the curl sequence above | ~10 min |
| 6 | Write + run the GitHub Actions workflow; push a change and watch it deploy | ~20 min |
| 7 | `terraform destroy` and confirm the console is empty | ~10 min |

If time runs short, **step 6 is the one to cut** — the infrastructure is the
harder half, and the workflow file can be written and tested against a
re-created stack another day. Do **not** cut step 7.

---

## Accepted risks (learning environment — do not ship as-is)

These are known and deliberately deferred, not oversights:

1. **HTTP only.** JWTs, passwords, and registration bodies travel in clear text.
   A bare ALB genuinely cannot serve trusted HTTPS — ACM will not issue a
   certificate for `*.elb.amazonaws.com`. Fixing it properly needs either a
   domain (~$3–15/yr for a `.link`, which a URL shortener wants anyway) or a
   CloudFront distribution, which hands you a free `*.cloudfront.net` hostname
   with valid TLS.
2. **`CORS allow_origins=["*"]`** on both backends. Same-origin routing means it
   is unused in this deployment, but it should become an env-driven allow-list
   before any real exposure.
3. **FastAPI's `/docs` is unreachable through the ALB.** It sits at `/docs`, not
   under `/auth/*`, so the default rule sends it to short-server, whose `/:code`
   catch-all answers "link not found". This is a routing consequence, not a bug —
   if you want Swagger UI while learning, add a listener rule at priority 150 for
   `/docs`, `/openapi.json`, `/redoc` → auth TG. Leaving it off is the more
   secure default.
4. **`/health` endpoints don't check the database.** Both return a static 200,
   so a task with a dead DB connection still reports healthy to the ALB. A
   `SELECT 1` in the handler is a small, worthwhile follow-up.
5. **A real Postgres password is committed in plaintext** in `Ec2_setup.md` and
   `EKS_PLAN.md` on the `main` / `learning_k8s` branches (commit `4558991`,
   already pushed to `origin`). Out of scope per your instruction, but that
   credential should be considered public. Adding `gitleaks` to `ci.yml` is a
   cheap way to stop a repeat.
