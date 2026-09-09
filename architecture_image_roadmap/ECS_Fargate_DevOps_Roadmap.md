# Microservices → AWS ECS Fargate DevOps Roadmap

## Project Goal

Current application:

```text
Docker Compose
├── UI
├── Auth Server
├── Short Server
└── PostgreSQL
```

Target:

```text
Developer
   ↓
Feature Branch
   ↓
Pull Request
   ↓
dev
   ↓
GitHub Actions
   ↓
Build + Test
   ↓
Docker Image
   ↓
Amazon ECR
   ↓
Amazon ECS Fargate
   ↓
DEV Server
```

The final AWS architecture will use:

- Amazon VPC
- Public/private subnets
- Security Groups
- Application Load Balancer (ALB)
- Amazon ECS Fargate
- Amazon ECR
- Amazon RDS PostgreSQL
- AWS Systems Manager Parameter Store
- Amazon CloudWatch Logs
- Terraform
- GitHub Actions
- Git/GitHub branching and pull requests

---

# 1. Current Docker Compose → AWS Mapping

| Local Docker Compose | AWS |
|---|---|
| `shorten-network` bridge | VPC + Security Groups + ECS networking |
| Port mappings such as `80:3000`, `4000:4000`, `5000:5000` | ALB listeners/rules + target groups |
| `.env` files | SSM Parameter Store / Secrets Manager |
| Locally built Docker images | Amazon ECR |
| `docker logs` / container stdout | CloudWatch Logs |
| PostgreSQL container | Amazon RDS PostgreSQL |
| Docker Compose service | ECS Service |
| Docker Compose container | ECS Fargate Task |
| `docker-compose.yml` | ECS Task Definitions + Services |

---

# 2. Target Architecture

```text
                         INTERNET
                             │
                             │ HTTP/HTTPS
                             ▼
                    ┌─────────────────┐
                    │       ALB       │
                    │  Public Subnet  │
                    └────────┬────────┘
                             │
               ┌─────────────┼─────────────┐
               │             │             │
               ▼             ▼             ▼
             UI TG        AUTH TG       SHORT TG
               │             │             │
               ▼             ▼             ▼
          ECS Fargate   ECS Fargate   ECS Fargate
          Private Subnets / AZ-A + AZ-B
                       │
                       │ :5432
                       ▼
                 RDS PostgreSQL
                 Private Subnets


Supporting Services:

              GitHub
                 │
                 ▼
          GitHub Actions
                 │
                 ▼
                ECR
                 │
                 ▼
               ECS

ECS ───────────────→ CloudWatch Logs

ECS ───────────────→ SSM Parameter Store
```

## Important Production Improvement

For learning, ECS tasks can temporarily use public IPs if required.

For the production architecture, prefer:

```text
Internet
   ↓
ALB
   ↓
ECS Fargate in Private Subnets
   ↓
RDS in Private Subnets
```

Do not expose RDS directly to the internet.

---

# 3. Overall Learning Strategy

Do NOT build everything simultaneously.

Follow this sequence:

```text
PHASE 0
Understand current application
        ↓
PHASE 1
Make Docker production-ready
        ↓
PHASE 2
Create AWS infrastructure manually
        ↓
PHASE 3
Deploy ONE microservice to ECS
        ↓
PHASE 4
Add ALB
        ↓
PHASE 5
Deploy all microservices
        ↓
PHASE 6
Move PostgreSQL to RDS
        ↓
PHASE 7
Add SSM + CloudWatch
        ↓
PHASE 8
Recreate infrastructure with Terraform
        ↓
PHASE 9
Introduce Git/GitHub workflow
        ↓
PHASE 10
Build CI/CD with GitHub Actions
        ↓
PHASE 11
Add rollback, health checks and scaling
        ↓
PHASE 12
Production hardening
```

---

# PHASE 0 — Understand the Existing Application

Before AWS, document every service.

Example:

| Service | Container Port | Public? | Database? |
|---|---:|---|---|
| UI | 3000 | Yes | No |
| Auth | 4000 | No | Yes |
| Short | 5000 | No | Yes |
| PostgreSQL | 5432 | No | — |

Container port is what the process listens on *inside* the container. This is the
value an ECS task definition and target group need. It is not the host port from
`docker-compose.yaml`: the UI publishes `80:3000`, so it is port 80 on your laptop
but port 3000 to ECS.

Understand:

```text
UI
 └── Port 3000

auth-server
 └── Port 4000
 └── PostgreSQL

short-server
 └── Port 5000
 └── PostgreSQL

postgres
 └── Port 5432
```

## Key networking principle

Do not build:

```text
Internet
 ├── Auth
 ├── Short
 └── PostgreSQL
```

Build:

```text
Internet
   ↓
ALB
   ↓
ECS Services
   ↓
RDS
```

## Milestone

You should be able to explain:

- Which service does what
- Which ports are used
- Which services communicate with PostgreSQL
- Which service should be publicly accessible
- Which environment variables are required
- Which Dockerfiles build each service

---

# PHASE 1 — Make Docker Production-Ready

Before AWS, ensure every service can run independently.

You should be able to do:

```bash
docker build -t auth-server .
docker run auth-server
```

and similarly for:

```text
ui
auth-server
short-server
```

## Learn these Docker commands

```bash
docker images
docker ps
docker ps -a
docker logs <container>
docker exec -it <container> sh
docker stop <container>
docker rm <container>
docker build
docker tag
docker push
```

## Understand this flow

```text
Dockerfile
    ↓
docker build
    ↓
Docker Image
    ↓
docker run
    ↓
Container
```

## Milestone

You can build and run every microservice independently without Docker Compose.

---

# PHASE 2 — Create AWS Infrastructure Manually

Do the first AWS deployment manually.

Do NOT start with Terraform.

The purpose is to understand the actual AWS architecture before automating it.

Create:

```text
AWS
│
├── VPC
│
├── Public Subnets
│   ├── AZ-A
│   └── AZ-B
│
├── Private Subnets
│   ├── AZ-A
│   └── AZ-B
│
├── Application Load Balancer
│
├── ECS Cluster
│
├── ECS Services
│   ├── UI
│   ├── Auth
│   └── Short
│
├── ECR
│   ├── ui
│   ├── auth
│   └── short
│
├── RDS PostgreSQL
│
├── SSM Parameter Store
│
└── CloudWatch
```

And the supporting infrastructure:
```
AWS
│
├── VPC
│
├── Public Subnets
│   ├── AZ-A
│   └── AZ-B
│
├── Private Subnets
│   ├── AZ-A
│   └── AZ-B
│
├── Internet Gateway
│
├── NAT Gateway
│
├── Route Tables
│
├── Security Groups
│
├── ECR
│
├── ECS Cluster
│
├── ALB
│
├── RDS
│
├── SSM
│
└── CloudWatch
```

---

# PHASE 3 — Amazon ECR

ECR stores your Docker images.

Local:

```text
Docker Image
     ↓
auth-server
```

AWS:

```text
Amazon ECR
     ↓
auth-server:commit-sha
```

Example:

```bash
docker build -t auth-server .
```

Eventually:

```text
123456789.dkr.ecr.ap-south-1.amazonaws.com/auth-server
```

## Use immutable image tags

Avoid depending on:

```text
latest
```

Prefer:

```text
auth-server:a1b2c3d
```

where:

```text
a1b2c3d = Git commit SHA
```

This gives you traceability and rollback.

Example:

```text
Commit A
   ↓
auth-server:a1b2c3d

Commit B
   ↓
auth-server:b4c5d6e
```

If B is broken:

```text
Rollback
b4c5d6e
   ↓
a1b2c3d
```

---

# PHASE 4 — Deploy ONE Microservice to ECS Fargate

Do not deploy all microservices first.

Start with:

```text
short-server
```

Learn these ECS concepts:

```text
ECS Cluster
     ↓
Task Definition
     ↓
ECS Service
     ↓
Fargate Task
```

## ECS Task Definition

Defines:

```text
Docker image
Container port
CPU
Memory
Environment variables
IAM roles
Logging
Networking configuration
```

Example:

```text
short-server

Image:
ECR/short-server:a1b2c3d

Container Port:
5000

CPU:
0.5 vCPU

Memory:
1 GB
```

## ECS Service

Controls how many tasks should run.

Example:

```text
desired count = 1
```

Meaning:

```text
ECS Cluster
   └── short-service
         └── Fargate Task
```

If the task crashes:

```text
Task crashes
     ↓
ECS detects it
     ↓
ECS starts replacement
```

## Milestone

You can access the running ECS task/service and understand:

- Cluster
- Task Definition
- Task
- Service
- Container
- Port mapping
- Logs

---

# PHASE 5 — Add Application Load Balancer

Now connect the internet to ECS.

Architecture:

```text
Internet
   ↓
ALB
   ↓
Target Group
   ↓
ECS Task
```

Learn these three concepts together:

```text
ALB
Target Group
Listener Rule
```

For your application:

```text
ALB :80
 │
 ├── /api/auth/*
 │       ↓
 │   auth-target-group
 │
 ├── /api/short/*
 │       ↓
 │   short-target-group
 │
 └── /*
         ↓
     ui-target-group
```

## Important

The ALB should be public.

The ECS tasks should not need to be directly accessible from the internet in the production design.

---

# PHASE 6 — Deploy All Microservices

Now convert:

```text
docker-compose

ui
auth
short
postgres
```

into:

```text
ECS

ui-service
auth-service
short-service

RDS PostgreSQL
```

ECS:

```text
ECS Cluster
│
├── ui-service
│     └── Fargate Task
│
├── auth-service
│     └── Fargate Task
│
└── short-service
      └── Fargate Task
```

Start with:

```text
desired count = 1
```

Later:

```text
desired count = 2+
```

---

# PHASE 7 — Move PostgreSQL to RDS

Current:

```text
Docker Compose
      ↓
Postgres Container
```

Target:

```text
ECS
  ↓
RDS PostgreSQL
```

Your application should use the RDS endpoint instead of:

```text
postgres
localhost
```

Example:

```env
DB_HOST=<RDS endpoint>
DB_PORT=5432
DB_USER=<user>
DB_PASSWORD=<password>
DB_NAME=<database>
```

## Security Groups

Use:

```text
ALB SG
   ↓
ECS SG
   ↓
RDS SG
```

Rules:

```text
ALB SG
80/443 ← Internet

ECS SG
Application port ← ALB SG

RDS SG
5432 ← ECS SG
```

Never use:

```text
RDS 5432 ← 0.0.0.0/0
```

for production.

---

# PHASE 8 — Move .env Configuration to SSM

Current:

```text
.env
```

Example:

```env
DB_HOST=localhost
DB_USER=postgres
DB_PASSWORD=password
JWT_SECRET=xxxxx
```

Do not commit secrets into Git.

Target:

```text
SSM Parameter Store
        ↓
ECS Task
        ↓
Environment variables
        ↓
Application
```

Example parameter naming:

```text
/dev/auth/DB_HOST
/dev/auth/DB_USER
/dev/auth/DB_PASSWORD
/dev/auth/JWT_SECRET

/dev/short/DB_HOST
/dev/short/DB_USER
/dev/short/DB_PASSWORD
```

The ECS task gets the required values through AWS IAM permissions.

---

# PHASE 9 — CloudWatch Logs

Current:

```bash
docker logs auth-server
```

AWS:

```text
ECS Container
      ↓
CloudWatch Logs
```

Example log groups:

```text
/aws/ecs/dev-auth
/aws/ecs/dev-short
/aws/ecs/dev-ui
```

You should be able to trace:

```text
Request
   ↓
ALB
   ↓
ECS
   ↓
Application
   ↓
CloudWatch
```

---

# PHASE 10 — Introduce Terraform

Only after the manual AWS deployment works.

Terraform's job:

```text
Terraform
    ↓
AWS APIs
    ↓
Infrastructure
```

Terraform manages things such as:

```text
VPC
Subnets
Route Tables
Security Groups
ALB
Target Groups
ECR
ECS
RDS
SSM
CloudWatch
IAM
```

## Terraform project

Start simple:

```text
terraform/
│
├── providers.tf
├── variables.tf
├── outputs.tf
│
├── vpc.tf
├── security-groups.tf
├── ecr.tf
├── ecs.tf
├── alb.tf
├── rds.tf
├── ssm.tf
└── cloudwatch.tf
```

Later:

```text
terraform/
│
├── modules/
│   ├── vpc/
│   ├── ecs/
│   ├── alb/
│   ├── rds/
│   └── ecr/
│
└── environments/
    └── dev/
```

---

# PHASE 11 — Terraform Learning Sequence

## Day 1 — Terraform Fundamentals

Learn:

```text
provider
resource
variable
output
```

Commands:

```bash
terraform init
terraform plan
terraform apply
terraform destroy
```

## Day 2 — AWS Networking

Learn:

```text
VPC
Subnet
Route Table
Internet Gateway
NAT Gateway
Security Group
```

## Day 3 — ECR

Create:

```text
ECR repository
```

using Terraform.

## Day 4 — ECS

Create:

```text
ECS Cluster
Task Definition
ECS Service
```

## Day 5 — ALB

Create:

```text
ALB
Target Group
Listener
Listener Rules
```

## Day 6 — RDS

Create:

```text
RDS PostgreSQL
```

## Day 7 — Supporting Services

Create:

```text
SSM
CloudWatch
IAM
```

## Final Terraform Milestone

```text
terraform apply
       ↓
Entire DEV infrastructure
       ↓
created automatically
```

---

# PHASE 12 — Git/GitHub Workflow for Two Developers

Recommended branches:

```text
main
 │
 └── production

dev
 │
 └── development environment

feature/*
 │
 ├── feature/login
 ├── feature/url-expiration
 └── feature/dashboard
```

Workflow:

```text
Developer
    ↓
feature branch
    ↓
Pull Request
    ↓
Code Review
    ↓
dev
    ↓
GitHub Actions
    ↓
DEV ECS
```

---

# PHASE 13 — Your CI/CD Pipeline

This is the main goal.

When code is merged into:

```text
dev
```

GitHub Actions should automatically:

```text
1. Checkout code
        ↓
2. Install dependencies
        ↓
3. Run tests
        ↓
4. Build Docker image
        ↓
5. Authenticate with AWS
        ↓
6. Push image to ECR
        ↓
7. Update ECS service
        ↓
8. Wait for deployment
        ↓
9. DEV server runs new version
```

So:

```bash
git push origin dev
```

eventually results in:

```text
GitHub
   ↓
GitHub Actions
   ↓
Test
   ↓
Docker Build
   ↓
ECR
   ↓
ECS Fargate
   ↓
DEV SERVER UPDATED
```

---

# PHASE 14 — Use Git Commit SHA for Docker Images

Example:

```text
Developer pushes commit:

a1b2c3d
```

Pipeline creates:

```text
auth-server:a1b2c3d
```

Another commit:

```text
b4c5d6e
```

Pipeline creates:

```text
auth-server:b4c5d6e
```

ECS moves from:

```text
a1b2c3d
```

to:

```text
b4c5d6e
```

Rollback:

```text
b4c5d6e ❌

        ↓ rollback

a1b2c3d ✅
```

This is preferable to relying on:

```text
latest
```

---

# PHASE 15 — Microservice-Aware CI/CD

As the application grows, avoid rebuilding every service for every change.

Example:

```text
auth-server/
short-server/
ui/
```

Developer changes:

```text
auth-server/
```

Pipeline can eventually determine:

```text
auth changed
    ↓
Build auth image
    ↓
Push auth image
    ↓
Deploy auth ECS service
```

No unnecessary deployment of:

```text
short
ui
```

This optimization can be introduced after the basic CI/CD pipeline works.

---

# PHASE 16 — Recommended Git Workflow

## Developer 1

```bash
git checkout dev
git pull

git checkout -b feature/auth-api
```

Make changes:

```bash
git add .
git commit -m "Add auth API"
git push origin feature/auth-api
```

Create:

```text
feature/auth-api
        ↓
Pull Request
        ↓
dev
```

After merge:

```text
dev
 ↓
GitHub Actions
 ↓
DEV ECS
```

## Developer 2

```bash
git checkout dev
git pull

git checkout -b feature/short-url
```

Then:

```text
feature/short-url
        ↓
Pull Request
        ↓
dev
        ↓
GitHub Actions
        ↓
DEV ECS
```

---

# PHASE 17 — Add Production Later

Initially focus only on:

```text
feature/*
    ↓
   dev
    ↓
  DEV
```

After the DEV environment is stable:

```text
dev
 ↓
Pull Request
 ↓
main
 ↓
PRODUCTION
```

Final environment model:

```text
                GitHub
                   │
        ┌──────────┴──────────┐
        │                     │
       dev                   main
        │                     │
        ▼                     ▼
     DEV ECS              PROD ECS
```

---

# PHASE 18 — Terraform vs CI/CD

This distinction is critical.

## Terraform

Terraform manages infrastructure:

```text
VPC
Subnets
Security Groups
ALB
ECR
ECS
RDS
SSM
CloudWatch
IAM
```

Think:

```text
Terraform
    =
Infrastructure
```

## GitHub Actions

GitHub Actions manages application delivery:

```text
Source Code
    ↓
Test
    ↓
Docker Build
    ↓
ECR
    ↓
ECS
```

Think:

```text
GitHub Actions
    =
Application CI/CD
```

Do not make Terraform rebuild and deploy the application on every normal code change.

---

# PHASE 19 — Complete Project Architecture

```text
                         INTERNET
                             │
                             ▼
                    ┌─────────────────┐
                    │       ALB       │
                    │  Public Subnet  │
                    └────────┬────────┘
                             │
               ┌─────────────┼─────────────┐
               │             │             │
               ▼             ▼             ▼
             UI TG        AUTH TG       SHORT TG
               │             │             │
               ▼             ▼             ▼
          ECS Fargate   ECS Fargate   ECS Fargate
               │             │             │
               └─────────────┼─────────────┘
                             │
                             ▼
                     RDS PostgreSQL
                     Private Subnet


                  ┌─────────────────┐
                  │     GitHub      │
                  └────────┬────────┘
                           │
                           ▼
                  GitHub Actions
                           │
                    ┌──────┴──────┐
                    │             │
                   Test         Build
                    │             │
                    └──────┬──────┘
                           ▼
                          ECR
                           │
                           ▼
                         ECS


ECS ───────────────→ CloudWatch Logs

ECS ───────────────→ SSM Parameter Store

Terraform ─────────→ AWS Infrastructure
```

---

# PHASE 20 — Do Not Learn These Yet

For this project, don't immediately add:

```text
Kubernetes
EKS
Helm
Service Mesh
Kafka
ArgoCD
Jenkins
Ansible
Prometheus
Grafana
Complex multi-account AWS
```

Learn them after you can confidently operate:

```text
Docker
ECR
VPC
ECS Fargate
ALB
RDS
SSM
CloudWatch
Terraform
GitHub Actions
CI/CD
```

---

# 21. Project Milestones

## Milestone 1 — Local

```text
docker compose up
```

works reliably.

---

## Milestone 2 — Independent Containers

Every service works with:

```text
docker build
docker run
```

---

## Milestone 3 — ECR

```text
Docker
   ↓
ECR
```

works.

---

## Milestone 4 — ECS

```text
ECR
 ↓
ECS Fargate
```

works for ONE service.

---

## Milestone 5 — ALB

```text
Internet
   ↓
ALB
   ↓
ECS
```

works.

---

## Milestone 6 — All Microservices

```text
ALB
 ├── UI
 ├── Auth
 └── Short
```

works.

---

## Milestone 7 — RDS

```text
ECS
 ↓
RDS PostgreSQL
```

works.

---

## Milestone 8 — Configuration

```text
ECS
 ↓
SSM
```

works.

---

## Milestone 9 — Logging

```text
ECS
 ↓
CloudWatch
```

works.

---

## Milestone 10 — Terraform

```text
Terraform
    ↓
AWS Infrastructure
```

works.

---

# 22. Final CI/CD Milestone

This is the most important milestone.

```text
Developer
     │
     ▼
feature branch
     │
     ▼
Pull Request
     │
     ▼
dev
     │
     ▼
GitHub Actions
     │
     ├── Test
     │
     ├── Docker Build
     │
     ├── ECR Push
     │
     └── ECS Deployment
              │
              ▼
          DEV SERVER
```

The desired developer experience is:

```bash
git push
```

followed by:

```text
CI
 ↓
Docker image
 ↓
ECR
 ↓
ECS deployment
 ↓
DEV updated
```

No manual Docker build or ECS deployment should be necessary for normal DEV deployments.

---

# 23. Final Recommended Learning Order

```text
1. Docker
      ↓
2. ECR
      ↓
3. VPC + Security Groups
      ↓
4. ECS Fargate
      ↓
5. ALB + Target Groups
      ↓
6. Deploy all microservices
      ↓
7. RDS PostgreSQL
      ↓
8. SSM Parameter Store
      ↓
9. CloudWatch Logs
      ↓
10. Terraform Fundamentals
      ↓
11. Terraform AWS Infrastructure
      ↓
12. Git/GitHub Branching
      ↓
13. GitHub Actions
      ↓
14. CI Pipeline
      ↓
15. ECR Deployment
      ↓
16. ECS CD
      ↓
17. Rollback
      ↓
18. Health Checks
      ↓
19. Auto Scaling
      ↓
20. Production Hardening
```

---

# 24. The Actual Project Strategy

Because you are new to DevOps but already understand the purpose of AWS services, use this project as your learning lab.

Do not try to memorize DevOps concepts first.

For every technology, ask:

```text
What problem does it solve?
Why does my application need it?
How do I configure it?
How do I verify it?
What happens when it fails?
How would I automate it?
```

Your final project should demonstrate:

```text
Docker
   +
AWS
   +
ECS Fargate
   +
ALB
   +
ECR
   +
RDS
   +
SSM
   +
CloudWatch
   +
Terraform
   +
GitHub Actions
   +
CI/CD
```

That is a strong practical DevOps project for someone transitioning from application development into DevOps/Cloud engineering.

---

# 25. What to Do First

Do not start with Terraform or GitHub Actions yet.

Start with:

```text
STEP 1
Understand your current docker-compose application

        ↓

STEP 2
Make sure every microservice can run independently

        ↓

STEP 3
Create ECR repositories

        ↓

STEP 4
Build and push ONE image to ECR

        ↓

STEP 5
Create ECS Cluster

        ↓

STEP 6
Create Task Definition

        ↓

STEP 7
Run ONE Fargate service

        ↓

STEP 8
Connect it to ALB

        ↓

STEP 9
Deploy remaining microservices

        ↓

STEP 10
Move PostgreSQL to RDS

        ↓

STEP 11
Add SSM + CloudWatch

        ↓

STEP 12
Recreate the whole infrastructure using Terraform

        ↓

STEP 13
Create GitHub Actions CI

        ↓

STEP 14
Create automatic DEV deployment

        ↓

STEP 15
Test the complete workflow:
feature → PR → dev → CI/CD → ECR → ECS → DEV
```

## End Goal

```text
                 TWO DEVELOPERS

              ┌───────────────┐
              │   Developer 1 │
              └───────┬───────┘
                      │
              ┌───────▼───────┐
              │   Developer 2 │
              └───────┬───────┘
                      │
                      ▼
                GitHub Feature
                   Branches
                      │
                      ▼
                 Pull Request
                      │
                      ▼
                     DEV
                      │
                      ▼
               GitHub Actions
                      │
          ┌───────────┼───────────┐
          ▼           ▼           ▼
        Test        Build        Scan
                      │
                      ▼
                     ECR
                      │
                      ▼
                ECS Fargate
                      │
                      ▼
                    ALB
                      │
                      ▼
                 DEV SERVER
```

**Success condition:**

> A developer merges code into `dev`, and without manually logging into AWS, the updated application becomes available on the DEV server.
