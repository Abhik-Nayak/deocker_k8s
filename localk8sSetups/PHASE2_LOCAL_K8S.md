# Phase 2 — Run the app on local Kubernetes (kind)

## Recap — where Phase 1 left off

No Compose. Two images, one user-defined network, containers started by hand:

```bash
# 1. Network — required so nginx can resolve the hostname "api"
docker network create todo

# 2. Build
docker build -t todo-server ./server
docker build -t todo-client ./client

# 3. Migrate once (one-shot, exits)
docker run --rm --network todo --env-file server/.env todo-server npm run migrate

# 4. API — the container MUST be named "api"
docker run -d --name api --network todo \
  --env-file server/.env -p 8000:8000 --restart unless-stopped todo-server

# 5. Client
docker run -d --name client --network todo \
  -p 8080:80 --restart unless-stopped todo-client
```

Three things Compose was doing for you that you now do by hand:

- **The default bridge network has no DNS.** Without `--network todo`, nginx cannot
  resolve `api` and every `/api` call returns 502.
- **Order matters.** nginx resolves `api` at startup and exits if it does not exist,
  so the API container must be running first. There is no `depends_on`.
- **The migration is yours to remember.** Nothing sequences it before the API starts.

---

## What changes in Phase 2

Same two images, same RDS database. Only the *runtime* changes — Docker networking
and flags are replaced by Kubernetes objects:

| docker run                  | Kubernetes                          |
| --------------------------- | ----------------------------------- |
| `--network todo`            | cluster networking (automatic)      |
| `--name api`                | a **Service** named `api`           |
| `--env-file server/.env`    | **ConfigMap** + **Secret**          |
| `-p 8080:80`                | a Service + `kubectl port-forward`  |
| `npm run migrate` one-shot  | a **Job**                           |
| `--restart unless-stopped`  | a **Deployment**                    |

---

## 0. Your cluster

```bash
kubectl config current-context      # docker-desktop
kubectl get nodes
```

```
desktop-control-plane   Ready   control-plane   v1.36.1
desktop-worker          Ready   <none>          v1.36.1
desktop-worker2         Ready   <none>          v1.36.1
```

Docker Desktop's Kubernetes is *kind under the hood* (3 nodes), but Docker Desktop
manages those nodes itself. Two consequences that will confuse you otherwise:

- `kind get clusters` prints **nothing**, and `kind load docker-image` does not
  work. The `kind` CLI cannot see a cluster Docker Desktop created.
- The nodes do not appear in `docker ps`.

---

## 1. Get your images into the cluster

**This is the one step with no Docker equivalent, and it is where most people get stuck.**

The cluster does *not* share your local image store. Deploy `todo-server:latest`
directly and the Pod fails with `ErrImageNeverPull` — the image exists on your
machine, but not on the nodes.

The fix is a local registry. Docker Desktop's cluster forwards `localhost:5000`
from inside the nodes to a registry on your host:

```bash
# One-time: a registry container on port 5000
docker run -d --name localreg -p 5000:5000 --restart=always registry:2

# Re-run this every time you rebuild an image
docker tag  todo-server:latest localhost:5000/todo-server:latest
docker tag  todo-client:latest localhost:5000/todo-client:latest
docker push localhost:5000/todo-server:latest
docker push localhost:5000/todo-client:latest

curl -s http://localhost:5000/v2/_catalog   # {"repositories":["todo-client","todo-server"]}
```

**What it did:** put the images somewhere the nodes can pull from. From here on
every manifest refers to `localhost:5000/...`, never the bare local tag.

> `host.docker.internal:5000` does **not** work here — only `localhost:5000`.

---

## 2. Secret — the database password

**PowerShell** (what you are using):

```powershell
$pw = (Get-Content server\.env | Where-Object { $_ -match '^PGPASSWORD=' }) -replace '^PGPASSWORD=', ''

kubectl create secret generic db-credentials `
  --from-literal=PGUSER=app_admin `
  --from-literal=PGPASSWORD=$pw
```

**Bash / Git Bash:**

```bash
# Reads server/.env so the password is never typed
set -a; . ./server/.env; set +a

kubectl create secret generic db-credentials \
  --from-literal=PGUSER="$PGUSER" \
  --from-literal=PGPASSWORD="$PGPASSWORD"
```

> **Do not run the bash version in PowerShell.** `set -a` is not a PowerShell
> command and `$PGUSER` will be an undefined variable, so the Secret is created
> with **empty values**. It looks fine — `kubectl get secret` shows 2 keys — but
> the migration then fails with
> `no PostgreSQL user name specified in startup packet`.

Always verify the values are non-empty:

```bash
# bash
kubectl get secret db-credentials -o jsonpath='{.data.PGUSER}' | base64 -d    # app_admin
```

```powershell
# PowerShell
[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(
  (kubectl get secret db-credentials -o jsonpath='{.data.PGUSER}')))          # app_admin
```

**Why:** credentials do not belong in a YAML file you commit. A Secret is a
separate object, created imperatively, that Pods read as env vars.

**Note:** Secrets are only base64-encoded, not encrypted at rest by default —
`kubectl get secret db-credentials -o yaml` will show you the value. This is
about *separation*, not real secrecy. That comes later with AWS Secrets Manager.

---

## 3. ConfigMap — everything that isn't secret

`k8s/01-configmap.yaml`

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: api-config
data:
  PORT: "8000"
  PGHOST: todo-db.cl4wyoi28bez.ap-south-1.rds.amazonaws.com
  PGPORT: "5432"
  PGDATABASE: appdb
  PGSSL: "true"
```

**Why:** this is `server/.env` minus the password — safe to commit, and you can
change the RDS endpoint without rebuilding the image. Values must be strings,
hence the quotes around the numbers.

```bash
kubectl apply -f k8s/01-configmap.yaml
```

---

## 4. Job — run the migration once

`k8s/02-migrate-job.yaml`

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: migrate
spec:
  backoffLimit: 3
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: localhost:5000/todo-server:latest
          imagePullPolicy: Always
          command: ["npm", "run", "migrate"]
          envFrom:
            - configMapRef:
                name: api-config
            - secretRef:
                name: db-credentials
```

```bash
kubectl apply -f k8s/02-migrate-job.yaml
kubectl wait --for=condition=complete job/migrate --timeout=180s
kubectl logs job/migrate        # Migration complete: 'todos' table is ready.
```

**Why a Job, not a Deployment:** a Deployment restarts its Pod forever. A Job runs
to completion once and stops — right for a one-shot `CREATE TABLE IF NOT EXISTS`.

**What it did:** proved the whole config chain works (ConfigMap + Secret reached
the container, and the container reached RDS) *before* deploying anything long-running.

To re-run it later you must delete it first — a completed Job is immutable:
`kubectl delete job migrate`.

---

## 5. Deployment + Service — the API

`k8s/03-api.yaml`

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  replicas: 2
  selector:
    matchLabels:
      app: api            # must match the Pod labels below
  template:
    metadata:
      labels:
        app: api          # the Service finds Pods by this label
    spec:
      containers:
        - name: api
          image: localhost:5000/todo-server:latest
          imagePullPolicy: Always
          ports:
            - containerPort: 8000
          envFrom:
            - configMapRef:
                name: api-config
            - secretRef:
                name: db-credentials
          readinessProbe:
            httpGet:
              path: /health
              port: 8000
            initialDelaySeconds: 3
            periodSeconds: 10
---
apiVersion: v1
kind: Service
metadata:
  name: api               # MUST be "api" — nginx proxies to http://api:8000
spec:
  type: ClusterIP
  selector:
    app: api
  ports:
    - port: 8000
      targetPort: 8000
```

**Deployment / ReplicaSet / Pod:** you write the Deployment. It creates a
ReplicaSet, which creates the Pods. You never write a ReplicaSet by hand — the
Deployment makes a new one per rollout, which is how rollback works. See it with
`kubectl get rs`.

**Why the Service name matters:** [client/nginx.conf](client/nginx.conf) proxies to
`http://api:8000`. In Docker that resolved to a container name; here it resolves to
a Service DNS name. **Rename the Service and the app breaks with 502.**

**Why `readinessProbe`:** without it a Pod receives traffic the instant it starts —
before the RDS connection is up — and users get errors during a rollout. Readiness
keeps the Pod out of the Service's endpoint list until `/health` passes.

**Why `replicas: 2`:** the Service load-balances across both Pods. This is the thing
`docker run` could not do.

---

## 6. Deployment + Service — the client

`k8s/04-client.yaml`

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: client
spec:
  replicas: 2
  selector:
    matchLabels:
      app: client
  template:
    metadata:
      labels:
        app: client
    spec:
      containers:
        - name: client
          image: localhost:5000/todo-client:latest
          imagePullPolicy: Always
          ports:
            - containerPort: 80
          readinessProbe:
            httpGet:
              path: /healthz    # the endpoint in client/nginx.conf
              port: 80
---
apiVersion: v1
kind: Service
metadata:
  name: client
spec:
  type: NodePort
  selector:
    app: client
  ports:
    - port: 80
      targetPort: 80
      nodePort: 30080         # must be in 30000-32767
```

```bash
kubectl apply -f k8s/03-api.yaml -f k8s/04-client.yaml
kubectl rollout status deploy/api
kubectl rollout status deploy/client
```

**Why NodePort:** ClusterIP is reachable only inside the cluster. NodePort opens a
fixed port on every node — conceptually the replacement for `-p 8080:80`.

**But on this cluster it is not reachable from your host.** `curl localhost:30080`
just fails. Docker Desktop hides the kind node containers, so nothing maps node
port 30080 to your machine. The Service is fine — you simply cannot reach it directly.

Use a port-forward, which is what actually works here:

```bash
kubectl port-forward svc/client 8080:80
```

Then open **http://localhost:8080**. Leave it running in its own terminal; it stops
when you Ctrl-C it.

The `nodePort: 30080` line is kept because it is worth seeing in `kubectl get svc`,
but do not expect to browse to it.

---

## 7. Check it

```bash
kubectl get deploy,rs,pods,svc
```

Expected — both Deployments `2/2`, the Job `Complete`:

```
deployment.apps/api      2/2     2            2
deployment.apps/client   2/2     2            2
job.batch/migrate        Complete   1/1
```

With `kubectl port-forward svc/client 8080:80` running in another terminal:

```bash
curl http://localhost:8080/healthz         # nginx is up
curl http://localhost:8080/api/todos       # full path: nginx -> api Service -> RDS
```

Useful when something is wrong:

```bash
kubectl logs -l app=api --tail=50           # logs from all api Pods
kubectl describe pod <name>                 # scheduling / image / probe failures
kubectl get endpoints api                   # empty = selector or readiness problem
kubectl exec -it deploy/client -- wget -qO- http://api:8000/health   # test DNS from inside
```

| Symptom | Cause |
| --- | --- |
| `ErrImageNeverPull` / `ImagePullBackOff` | Skipped step 1, or forgot to re-push after a rebuild |
| `/api` returns 502 | The Service is not named exactly `api` |
| `0/2 READY`, never becomes ready | `/health` failing — the Pod cannot reach RDS (see below) |
| `CreateContainerConfigError` | The ConfigMap or Secret name is wrong |
| `no PostgreSQL user name specified in startup packet` | The Secret has empty values — the bash snippet was run in PowerShell (see step 2) |
| `Unable to listen on port 8080` | An older `port-forward` still holds the port. Close that terminal, or forward to a different port: `kubectl port-forward svc/client 8081:80` |

---

## 8. The RDS gotcha

Pods reach RDS through the node containers, which egress via **Docker's public IP —
not your host's**. On this machine they differ:

| Path | Public IP |
| --- | --- |
| Host | `49.42.179.217` |
| Docker / Pods | `49.42.186.51` |

Both are already allowed on `sg-0d66af33044e5a2f6`. When the API Pods hang at
`0/2 READY` with `ETIMEDOUT`, your ISP rotated one of them:

```bash
aws ec2 authorize-security-group-ingress --group-id sg-0d66af33044e5a2f6 \
  --protocol tcp --port 5432 --cidr $(curl -s https://checkip.amazonaws.com)/32
```

---

## 9. Redeploy after a code change

```bash
docker build -t todo-server:latest ./server
docker tag todo-server:latest localhost:5000/todo-server:latest
docker push localhost:5000/todo-server:latest
kubectl rollout restart deploy/api
```

`rollout restart` is needed because the `:latest` tag does not change — nothing tells
Kubernetes to re-pull. (`imagePullPolicy: Always` only applies when a Pod is actually
created.) In real projects you tag images with a version or git SHA and this problem
disappears.

---

## Teardown

```bash
kubectl delete -f k8s/
kubectl delete secret db-credentials
docker rm -f localreg
```

---

## Not needed yet

- **Volumes** — the database is RDS, so no Pod stores state. You would need one for a
  Postgres Pod, which this app does not have.
- **Ingress** — NodePort is enough for a single service. Ingress earns its place when
  you want path routing (`/api` → api, `/` → client) behind one address, which is what
  the ALB does in Phase 3. Requires installing an ingress controller first.
