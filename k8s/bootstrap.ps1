# Rebuilds the whole local cluster from this repo. Part 10's definition of done.
#   powershell -File k8s/bootstrap.ps1
$ErrorActionPreference = "Stop"

# Versions are PINNED. 'main' drifts - it silently dropped the ingress-ready
# nodeSelector once already, which put the controller on a node with no port mapping.
$INGRESS_VERSION = "controller-v1.15.1"
$IMAGE_TAG       = "2709732-nonroot"

Write-Host "==> 1/6 cluster"
kind create cluster --config k8s/kind-cluster.yaml
kubectl config set-context --current --namespace=shorten-dev

Write-Host "==> 2/6 build + load images"
docker build -t "shorten/ui:$IMAGE_TAG" ./ui
docker build -t "shorten/auth-server:$IMAGE_TAG" ./auth-server
docker build -t "shorten/short-server:$IMAGE_TAG" ./short-server
kind load docker-image "shorten/ui:$IMAGE_TAG" "shorten/auth-server:$IMAGE_TAG" "shorten/short-server:$IMAGE_TAG" --name shorten

Write-Host "==> 3/6 ingress-nginx"
kubectl apply -f "https://raw.githubusercontent.com/kubernetes/ingress-nginx/$INGRESS_VERSION/deploy/static/provider/kind/deploy.yaml"
# The manifest no longer pins to ingress-ready; only the control-plane has the 80/443 port mappings.
kubectl -n ingress-nginx patch deploy ingress-nginx-controller --type=json --patch-file k8s/patches/ingress-nodeselector.json
kubectl -n ingress-nginx rollout status deploy/ingress-nginx-controller --timeout=300s
$node = kubectl -n ingress-nginx get pod -l app.kubernetes.io/component=controller -o jsonpath='{.items[0].spec.nodeName}'
if ($node -ne "shorten-control-plane") { throw "ingress controller landed on '$node' - only the control-plane has the 80/443 port mappings" }

Write-Host "==> 4/6 metrics-server (for the HPA)"
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/download/v0.9.0/components.yaml
# kind kubelets serve self-signed certs; without this metrics never arrive.
kubectl -n kube-system patch deploy metrics-server --type=json --patch-file k8s/patches/metrics-server-insecure-tls.json

Write-Host "==> 5/6 secrets (never committed)"
kubectl create namespace shorten-dev --dry-run=client -o yaml | kubectl apply -f -
kubectl -n shorten-dev create secret generic shorten-secrets `
  --from-literal=DATABASE_URL='postgresql://postgres:postgres@postgres:5432/shortenurl?sslmode=disable' `
  --from-literal=JWT_SECRET='super-secret-change-me' `
  --dry-run=client -o yaml | kubectl apply -f -

if (-not (Test-Path "k8s/tls/tls.crt")) {
  New-Item -ItemType Directory -Force k8s/tls | Out-Null
  # openssl ships with Git for Windows but is not on PATH by default.
  $ssl = (Get-Command openssl -ErrorAction SilentlyContinue).Source
  if (-not $ssl) {
    $candidate = Join-Path $env:ProgramFiles "Git\mingw64\bin\openssl.exe"
    if (Test-Path -LiteralPath $candidate) { $ssl = $candidate }
  }
  if (-not $ssl) { throw "openssl not found - install it or add it to PATH" }
  & $ssl req -x509 -nodes -days 825 -newkey rsa:2048 `
    -keyout k8s/tls/tls.key -out k8s/tls/tls.crt `
    -subj "/CN=shorten.local/O=shorten-dev" -addext "subjectAltName=DNS:shorten.local"
}
kubectl -n shorten-dev create secret tls shorten-tls `
  --cert=k8s/tls/tls.crt --key=k8s/tls/tls.key `
  --dry-run=client -o yaml | kubectl apply -f -

Write-Host "==> 6/6 the app"
kubectl apply -k k8s/overlays/dev
kubectl -n shorten-dev rollout status deploy/ui --timeout=300s
kubectl -n shorten-dev rollout status deploy/auth-server --timeout=300s
kubectl -n shorten-dev rollout status deploy/short-server --timeout=300s

Write-Host ""
Write-Host "Done. Ensure '127.0.0.1 shorten.local' is in C:\Windows\System32\drivers\etc\hosts"
Write-Host "Then open https://shorten.local (self-signed cert warning is expected)"
