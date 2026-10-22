#!/usr/bin/env bash
# Deploys a released version to Kubernetes (used by .github/workflows/release.yml; can be run by hand).
#   KUBECONFIG_DATA="$(cat kubeconfig)" REGISTRY=ghcr.io/acme/orbit VERSION=1.4.0 APP_URL=https://orbit.example.com \
#     infrastructure/scripts/deploy.sh production
# Production: fresh backup → migrations → rollout → smoke test. A failed rollout is undone automatically;
# migrations are expand/contract, so the previous version keeps working on the new schema.
set -euo pipefail

ENVIRONMENT=${1:?usage: deploy.sh staging|production}
: "${KUBECONFIG_DATA:?KUBECONFIG_DATA is required}" "${REGISTRY:?REGISTRY is required}" "${VERSION:?VERSION is required}"
NS=orbit
ROOT=$(cd "$(dirname "$0")/../.." && pwd)

KUBECONFIG=$(mktemp)
export KUBECONFIG
trap 'rm -f "$KUBECONFIG"' EXIT
printf '%s' "$KUBECONFIG_DATA" > "$KUBECONFIG"
chmod 600 "$KUBECONFIG"

image() { printf '%s/orbit-%s:%s' "$REGISTRY" "$1" "$VERSION"; }
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }

if [ "$ENVIRONMENT" = production ]; then
  job="release-backup-$(date +%s)"
  log "backup: $job"
  kubectl -n "$NS" create job "$job" --from=cronjob/mysql-backup
  kubectl -n "$NS" wait --for=condition=complete "job/$job" --timeout=60m
fi

log "migrations: $(image migrate)"
kubectl -n "$NS" delete job orbit-migrate --ignore-not-found --wait=true
sed "s#ghcr.io/example/orbit-migrate:0.0.0#$(image migrate)#" "$ROOT/infrastructure/k8s/release/migrate-job.yaml" | kubectl -n "$NS" apply -f -
kubectl -n "$NS" wait --for=condition=complete job/orbit-migrate --timeout=15m

log "rollout: $VERSION"
host=""
if [ -n "${APP_URL:-}" ]; then host=$(printf '%s' "$APP_URL" | sed -E 's#^https?://##; s#/.*$##'); fi
kubectl kustomize "$ROOT/infrastructure/k8s/overlays/production" \
  | sed -E "s#ghcr.io/example/orbit-(api|worker|web|ops):0.0.0#$REGISTRY/orbit-\1:$VERSION#g" \
  | { if [ -n "$host" ]; then sed "s#orbit.example.com#$host#g"; else cat; fi; } \
  | kubectl apply -f -

failed=0
for deployment in api worker web; do
  if ! kubectl -n "$NS" rollout status "deployment/$deployment" --timeout=10m; then failed=1; fi
done
if [ "$failed" = 1 ]; then
  log "rollout failed: undoing"
  for deployment in api worker web; do kubectl -n "$NS" rollout undo "deployment/$deployment" || true; done
  exit 1
fi

if [ -n "${APP_URL:-}" ]; then
  log "smoke test: $APP_URL"
  curl -fsS --retry 10 --retry-delay 6 --retry-all-errors "$APP_URL/api/v1/health/ready" > /dev/null
fi
log "deployed $VERSION to $ENVIRONMENT"
