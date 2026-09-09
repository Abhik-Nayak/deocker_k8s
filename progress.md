# Project Progress Tracker

Shorten-URL microservices → AWS ECS Fargate.
Roadmap: `architecture_image_roadmap/ECS_Fargate_DevOps_Roadmap.md` (Phases 0–20)
and `architecture_image_roadmap/PHASE 2 — AWS Infrastructure Manual Setup` (Parts 0–37).

Region: **ap-south-1** · Account: **786174827428** · Branch: `only_docker_practice`

---

## Current status

**AWS spend is back to ~$0.** All billable resources were deleted at the end of
2026-09-08. The free networking layer (VPC, subnets, IGW, route tables, security
groups) and the three empty ECR repositories were kept, so Parts 1–6, 9 and 10 do
**not** need redoing.

Roadmap position: **Parts 0–10 complete.** Parts 11–14 were attempted but pushed the
wrong image and have been rolled back.

---

## 2026-09-08 — what was done

### Database: Supabase → RDS → deleted

- Created RDS `shorten-url-db` (PostgreSQL 17.11, db.t4g.micro, 20 GB gp3, encrypted,
  single-AZ, in the **default** VPC), SG locked to home IP only.
- Repointed `auth-server/.env` and `short-server/.env` from Supabase to the RDS
  endpoint. Verified end-to-end: both services connected, created `users` and `links`,
  and a register → shorten → history flow worked. Test rows were cleaned up.
- Updated the committed `.env.example` files to document RDS instead of Supabase.
- **Deleted the same day** to stop charges (see below).

### Region cleanup

- Deleted `Hospital-VPC` (`vpc-010830446469141a9`, 10.0.0.0/16) and its two custom SGs.
  It was completely empty — no subnets, IGW, NAT, ENIs or instances.
- Deleted 5 stale unattached SGs from earlier labs: `ALB-SG`, `EC2-SG`, `DB-SG`,
  `todo-rds-sg`, `ansible-lab-sg`. Had to delete in reverse reference order
  (`DB-SG` → `EC2-SG` → `ALB-SG`); AWS refuses to delete an SG another SG references.

### Phase 2 Parts 0–10 built

- **Parts 1, 3, 4** — VPC `dev-microservices-vpc` (10.0.0.0/16) + 4 subnets across 2 AZs.
- **Part 5** — `dev-igw` created and attached.
- **Part 6** — `dev-public-rt` with `0.0.0.0/0 → igw`, associated to both public subnets.
- **Part 7** — NAT Gateway created. **Since deleted.**
- **Part 8** — `dev-private-rt-a` / `dev-private-rt-b` created and associated.
  Their `0.0.0.0/0 → NAT` routes were removed when the NAT was deleted.
- **Part 9** — 3 SGs chained by group reference, not CIDR:
  `dev-alb-sg` (80 ← 0.0.0.0/0) → `dev-ecs-sg` (3000/4000/5000 ← alb-sg) →
  `dev-rds-sg` (5432 ← ecs-sg). HTTPS 443 deliberately deferred.
- **Part 10** — ECR repos `dev-ui`, `dev-auth`, `dev-short` with scan-on-push.

Two additions the roadmap omits but later parts require: **DNS hostnames + DNS support**
enabled on the VPC (else an in-VPC RDS endpoint will not resolve), and **auto-assign
public IPv4** on both public subnets.

### Parts 11–14 — attempted, rolled back

Pushed an image to `dev-short` that was actually the **UI/nginx image**
(`cmd: nginx -g daemon off;`, exposed 3000 — identical image ID to `shorten-ui:latest`),
almost certainly built from the wrong directory. It was also tagged `latest` rather
than a commit SHA, against Part 13. All images have been removed; `dev-short` is empty.

### Roadmap doc port fixes

Corrected in `ECS_Fargate_DevOps_Roadmap.md`, verified against the code:

| Location | Was | Now |
|---|---|---|
| Phase 0 table — UI | 80 | **3000** |
| Phase 0 table — Short | 4000 | **5000** |
| "Understand" block — UI | 80 | **3000** |
| "Understand" block — short-server | 4000 | **5000** |
| Phase 4 task-def example | 4000 | **5000** |
| Compose mapping row | 2 ports | added `5000:5000` |

Also added a note distinguishing container port from host port. Auth was already
correct at 4000.

### Local Docker

Ran the three services manually (no compose), then created user-defined network
`shorten-network` and attached all three with aliases `ui`, `auth-server`,
`short-server`. Verified embedded DNS resolves between containers — the default
`bridge` network cannot do this.

---

## What was deleted, and why

| Resource | ID | Reason |
|---|---|---|
| NAT Gateway | `nat-03a4033a93d95fbe4` | ~$40/mo, no free tier, useless with no ECS running |
| Elastic IP (NAT) | `eipalloc-016e03cd47c17bca2` (13.234.149.70) | released; unattached EIPs are charged |
| RDS instance | `shorten-url-db` | skip-final-snapshot, automated backups deleted |
| DB subnet group | `shorten-rds-subnets` | dependent on the deleted instance |
| Security group | `sg-0b578824c58da508d` (`shorten-rds-sg`) | dependent on the deleted instance |
| ECR images | `dev-short` (all) | wrong image (UI, not short-server) + `latest` tag |
| Private RT default routes | on both private RTs | pointed at the deleted NAT (blackhole) |

Verified after cleanup: **0** NAT gateways, **0** Elastic IPs, **0** RDS instances,
**0** EC2, **0** ALBs, **0** ECS clusters, **0** EBS volumes, **0** bytes in ECR.

---

## What must be recreated before proceeding

### 1. RDS — required before deploying auth-server or short-server

Both services **hard-exit** if the database is unreachable
(`process.exit(1)` in `short-server/src/index.ts`; FastAPI lifespan `open_pool()`
in auth-server). On ECS that is a permanent crash-loop, so do not deploy either
without a reachable database.

Recreate it **inside `dev-microservices-vpc`** this time, not the default VPC, so
`dev-rds-sg` can actually attach and the Part 9 SG chain works:

```bash
aws rds create-db-subnet-group --db-subnet-group-name dev-rds-subnets \
  --db-subnet-group-description "private subnets" \
  --subnet-ids subnet-06cdab66d0d708b4a subnet-0b1c65619c1c8d43b

aws rds create-db-instance --db-instance-identifier shorten-url-db \
  --db-name shortenurl --engine postgres --engine-version 17.11 \
  --db-instance-class db.t4g.micro --master-username shortenadmin \
  --master-user-password "<NEW-PASSWORD>" \
  --allocated-storage 20 --storage-type gp3 --storage-encrypted \
  --db-subnet-group-name dev-rds-subnets \
  --vpc-security-group-ids sg-012bbd17304a994bf \
  --no-publicly-accessible --backup-retention-period 1 --no-multi-az \
  --no-enable-performance-insights --monitoring-interval 0
```

Schema needs no migration — both services run `CREATE TABLE IF NOT EXISTS` on boot.

### 2. NAT Gateway — only if ECS tasks run in the private subnets

Needed for tasks to pull from ECR and reach the internet. **~$40/mo — delete it again
when you stop working.**

```bash
EIP=$(aws ec2 allocate-address --domain vpc --query AllocationId --output text)
NAT=$(aws ec2 create-nat-gateway --subnet-id subnet-04e1dbde0665871a8 \
  --allocation-id $EIP --query NatGateway.NatGatewayId --output text)
aws ec2 wait nat-gateway-available --nat-gateway-ids $NAT
aws ec2 create-route --route-table-id rtb-01cdd31a0d9004c1f \
  --destination-cidr-block 0.0.0.0/0 --nat-gateway-id $NAT
aws ec2 create-route --route-table-id rtb-0eb5ff4d638dd9bfa \
  --destination-cidr-block 0.0.0.0/0 --nat-gateway-id $NAT
```

**Cheaper alternative:** run ECS tasks in the **public** subnets with public IPs and
skip the NAT entirely. The main roadmap explicitly permits this
("For learning, ECS tasks can temporarily use public IPs if required").

### 3. ECR image — redo Parts 11–14 correctly

```bash
cd short-server
docker build --provenance=false --sbom=false -t dev-short .
SHA=$(git rev-parse --short HEAD)
REG=786174827428.dkr.ecr.ap-south-1.amazonaws.com
docker tag dev-short:latest $REG/dev-short:$SHA
aws ecr get-login-password --region ap-south-1 | docker login --username AWS --password-stdin $REG
docker push $REG/dev-short:$SHA
```

`--provenance=false` matters: Docker Desktop's containerd store otherwise pushes an
OCI **image index** with an `unknown/unknown` attestation manifest, a known cause of
`CannotPullContainerError ... manifest does not contain descriptor matching platform`
on Fargate. ECR login expires after **12 hours**.

### 4. Local `.env` files point at a dead host

Both `auth-server/.env` and `short-server/.env` still have
`shorten-url-db.cl4wyoi28bez.ap-south-1.rds.amazonaws.com`, which no longer exists.
The previous Supabase URL is preserved as a commented line in each file — uncomment it
to get local Docker working again, or point them at a newly created RDS.

---

## Surviving resources (all free)

| Resource | Name | ID |
|---|---|---|
| VPC | `dev-microservices-vpc` | `vpc-0382291aa9fde2a9c` (10.0.0.0/16) |
| Subnet | `dev-public-subnet-a` | `subnet-04e1dbde0665871a8` (10.0.1.0/24, 1a) |
| Subnet | `dev-public-subnet-b` | `subnet-0a3337fccf494e400` (10.0.2.0/24, 1b) |
| Subnet | `dev-private-subnet-a` | `subnet-06cdab66d0d708b4a` (10.0.11.0/24, 1a) |
| Subnet | `dev-private-subnet-b` | `subnet-0b1c65619c1c8d43b` (10.0.12.0/24, 1b) |
| IGW | `dev-igw` | `igw-0d266add76deffe01` |
| Route table | `dev-public-rt` | `rtb-0fd3e22a58816e27b` (→ igw) |
| Route table | `dev-private-rt-a` | `rtb-01cdd31a0d9004c1f` (no default route) |
| Route table | `dev-private-rt-b` | `rtb-0eb5ff4d638dd9bfa` (no default route) |
| SG | `dev-alb-sg` | `sg-0c4a2c419325df57c` |
| SG | `dev-ecs-sg` | `sg-0836790b4ad833c00` |
| SG | `dev-rds-sg` | `sg-012bbd17304a994bf` |
| ECR | `dev-ui` / `dev-auth` / `dev-short` | `786174827428.dkr.ecr.ap-south-1.amazonaws.com/<name>` |

Untagged main route table `rtb-0356f972304ac1cf2` also exists — AWS created it with the
VPC. All 4 subnets are explicitly associated elsewhere, so it is unused. Keep it that
way: a subnet you forget to associate silently inherits it and gets no internet route.

---

## Known code blockers — not yet fixed

1. **UI bakes `localhost` API URLs into its bundle.** `ui/src/lib/api.js` falls back to
   `http://localhost:4000` / `:5000`, and `ui/Dockerfile` never passes
   `VITE_AUTH_URL` / `VITE_SHORT_URL`. Vite inlines these at **build time**, so an ECS
   env var cannot fix it. Surfaces at Part 33: the task will pass health checks and
   still fail in the browser. Fix by switching to relative paths + ALB/nginx routing.
2. **Route prefixes do not match the ALB plan.** Auth serves `/auth/*`, short serves
   `/api/shorten` and `/api/links`. The roadmap's Part 34 expects `/api/auth/*` and
   `/api/short/*`, so a single `/api/*` rule cannot disambiguate the two target groups.
3. **`GET /:code` collides with the UI's `/*` rule.** `short-server/src/routes/redirect.ts`
   claims every root path, but Part 34 routes `/*` to the UI. Needs a separate hostname
   or a prefix like `/r/:code`.
4. **No tests exist**, so Phase 13's CI "Run tests" step has nothing to run.
5. **PHASE 2 doc still says port 4000 for short-server** in Part 9 and Part 18. The real
   port is 5000. Part 18 is the dangerous one — it goes straight into the task definition.

---

## Also outstanding

- **`todo-db-snapshot`** — a 20 GB *manual* RDS snapshot from a long-deleted `todo-db`
  instance, unrelated to this project. Manual snapshots persist and consume backup
  storage. Delete it if the old todo project is finished:
  `aws rds delete-db-snapshot --db-snapshot-identifier todo-db-snapshot`
- **Two AWS CLIs installed.** pip-installed v1 (`aws-cli/1.45.46`) shadows the official
  v2 (`aws-cli/2.36.2`) because `Python312\Scripts` comes first in PATH. This causes the
  harmless `File association not found for extension .py` message in cmd.exe, and means
  v2-only subcommands fail. Fix: `pip uninstall awscli`.
- **Uncommitted git move.** `ECS_Fargate_DevOps_Roadmap.md` is still tracked at the repo
  root but now lives in `architecture_image_roadmap/`.
- Docker network `shorten-network` still exists locally; no containers running.

---

## Next steps

1. Decide RDS placement (private subnets of the new VPC) and recreate it.
2. Redo Parts 11–14 with the **correct** image and a SHA tag.
3. Consider deploying the **UI first** rather than short-server, as Part 11 suggests —
   nginx has no database dependency, so it isolates ECS learning from DB problems.
4. Continue Parts 15–28: ECS cluster → CloudWatch log group → task execution IAM role →
   task definition → service → target group → ALB → listener.
5. Before Part 33, fix the UI build-arg problem (blocker 1).

**Always at the end of a session:** delete the NAT Gateway, release its EIP, and delete
the RDS instance. Those are the only meaningful recurring costs.
