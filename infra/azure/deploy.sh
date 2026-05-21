#!/usr/bin/env bash
# First-time deploy: provisions resource group, Container Apps environment,
# Azure Files volume, and the Container App itself. Subsequent image updates
# are done by .github/workflows/build-and-publish.yml (no need to re-run this).
#
# Image source: ghcr.io (free, fed by GitHub Actions). No ACR needed.
#
# Free-tier sizing:
#   - Container Apps Consumption: 180k vCPU-sec + 360k GiB-sec always-free/mo
#   - minReplicas=0 (scale to zero when idle)
#   - 0.25 vCPU / 0.5 GiB (smallest allowed)
#   - Azure Files 5 GiB Standard_LRS ≈ $0.30/mo
#   - GHCR package: $0 (free for public packages)
# Expected total: under $1/mo for personal use.
#
# Caveats of scale-to-zero for a WebSocket sync hub:
#   - First connect after idle pays a 10-30s cold start
#   - On cold start the Yjs in-memory docs reload from /data — no data loss
#   - If somebody's always editing, hub stays warm

set -euo pipefail

# ─── required env ────────────────────────────────────────────────────────
: "${GHCR_IMAGE:?Set GHCR_IMAGE to e.g. ghcr.io/youruser/yourrepo/surd-server}"
# Docker image references must be lowercase. GHA's docker/metadata-action
# lowercases automatically, so the pushed image lives at the lowercase path
# regardless of what the user typed.
GHCR_IMAGE="${GHCR_IMAGE,,}"

# ─── tuneable ────────────────────────────────────────────────────────────
RG="${RG:-surd-rg}"
LOCATION="${LOCATION:-centralindia}"
APP="${APP:-surd-server}"
ENV_NAME="${ENV_NAME:-surd-env}"
# Deterministic per subscription so re-running the script reuses the same
# account instead of provisioning a new one each time. Storage account names
# must be 3-24 chars, lowercase letters + digits only.
STORAGE_ACCOUNT="${STORAGE_ACCOUNT:-surdstg$(az account show --query id -o tsv | sha256sum | cut -c1-12)}"
FILE_SHARE="${FILE_SHARE:-surd-data}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
SURD_TOKEN="${SURD_TOKEN:-$(openssl rand -hex 24)}"

echo "─── config ──────────────────────────────────"
echo "resource group:    $RG"
echo "location:          $LOCATION"
echo "image:             ${GHCR_IMAGE}:${IMAGE_TAG}"
echo "container app:     $APP"
echo "environment:       $ENV_NAME"
echo "storage account:   $STORAGE_ACCOUNT"
echo "file share:        $FILE_SHARE  (5 GiB)"
echo "compute:           0.25 vCPU / 0.5 GiB, min=0 max=1"
echo "SURD_TOKEN:        $SURD_TOKEN"
echo "                   ↑ save this — collaborators need it"
echo "────────────────────────────────────────────"

az extension add --name containerapp --only-show-errors --upgrade 2>/dev/null || true
# Container Apps needs Microsoft.App. Storage account needs Microsoft.Storage
# (usually pre-registered, but harmless if not). Microsoft.OperationalInsights
# is only needed if we ship logs to Log Analytics — we don't (see env create
# below with --logs-destination none), but registering avoids friction if the
# script is later modified to enable logs.
az provider register --namespace Microsoft.App --wait --only-show-errors >/dev/null
az provider register --namespace Microsoft.OperationalInsights --wait --only-show-errors >/dev/null

# ─── 1. resource group ───────────────────────────────────────────────────
az group create --name "$RG" --location "$LOCATION" --output none

# ─── 2. storage for /data ────────────────────────────────────────────────
az storage account create \
  --resource-group "$RG" --name "$STORAGE_ACCOUNT" \
  --location "$LOCATION" --sku Standard_LRS \
  --output none
STORAGE_KEY=$(az storage account keys list -g "$RG" -n "$STORAGE_ACCOUNT" --query '[0].value' -o tsv)
az storage share-rm create \
  --resource-group "$RG" --storage-account "$STORAGE_ACCOUNT" \
  --name "$FILE_SHARE" --quota 5 \
  --output none

# ─── 3. container apps environment + volume ──────────────────────────────
# Both of these are non-idempotent on Azure's side:
#   - `containerapp env create` errors if the env already exists
#   - `containerapp env storage set` rejects updates to anything other than
#     the account key once the entry exists (returns
#     ManagedEnvironmentStorageUpdateBadRequest)
# Guard with show-then-create so re-runs of the script are safe.
if ! az containerapp env show -g "$RG" -n "$ENV_NAME" >/dev/null 2>&1; then
  az containerapp env create \
    --resource-group "$RG" --name "$ENV_NAME" \
    --location "$LOCATION" \
    --logs-destination none \
    --output none
fi

if ! az containerapp env storage show \
       -g "$RG" -n "$ENV_NAME" --storage-name surddata >/dev/null 2>&1; then
  az containerapp env storage set \
    --resource-group "$RG" --name "$ENV_NAME" \
    --storage-name surddata \
    --azure-file-account-name "$STORAGE_ACCOUNT" \
    --azure-file-account-key "$STORAGE_KEY" \
    --azure-file-share-name "$FILE_SHARE" \
    --access-mode ReadWrite \
    --output none
fi

# ─── 4. deploy the container app (pulls from ghcr.io) ────────────────────
# Assumes the ghcr.io package is PUBLIC. If it's private, set GHCR_USER and
# GHCR_PAT (a GitHub personal access token with read:packages) and we'll wire
# them in as a registry credential.
TMP_YAML=$(mktemp --suffix=.yaml)
{
  cat <<EOF
properties:
  template:
    containers:
      - name: surd-server
        image: ${GHCR_IMAGE}:${IMAGE_TAG}
        env:
          - name: SURD_TOKEN
            value: "${SURD_TOKEN}"
          - name: SURD_DATA_DIR
            value: /data
          # /data is an Azure Files (CIFS) mount; SQLite's WAL journal mode
          # is broken over CIFS, so force DELETE.
          - name: SURD_SQLITE_JOURNAL_MODE
            value: DELETE
        resources:
          cpu: 0.25
          memory: 0.5Gi
        volumeMounts:
          - volumeName: data
            mountPath: /data
        probes:
          - type: Liveness
            httpGet:
              path: /health
              port: 4455
            initialDelaySeconds: 20
            periodSeconds: 60
    scale:
      minReplicas: 0
      maxReplicas: 1
    volumes:
      - name: data
        storageType: AzureFile
        storageName: surddata
  configuration:
    ingress:
      external: true
      targetPort: 4455
      transport: auto
      allowInsecure: false
EOF

  if [[ -n "${GHCR_USER:-}" && -n "${GHCR_PAT:-}" ]]; then
    cat <<EOF
    registries:
      - server: ghcr.io
        username: ${GHCR_USER}
        passwordSecretRef: ghcr-pat
    secrets:
      - name: ghcr-pat
        value: "${GHCR_PAT}"
EOF
  fi
} > "$TMP_YAML"

if az containerapp show -g "$RG" -n "$APP" >/dev/null 2>&1; then
  az containerapp update -g "$RG" -n "$APP" --yaml "$TMP_YAML" --output none
else
  az containerapp create -g "$RG" -n "$APP" --environment "$ENV_NAME" --yaml "$TMP_YAML" --output none
fi
rm -f "$TMP_YAML"

FQDN=$(az containerapp show -g "$RG" -n "$APP" --query properties.configuration.ingress.fqdn -o tsv)

echo
echo "─── deployed ────────────────────────────────"
echo "URL:       https://$FQDN"
echo "WS URL:    wss://$FQDN/sync"
echo "Token:     $SURD_TOKEN"
echo
echo "Collaborators link with:"
echo "  surd link wss://$FQDN --token $SURD_TOKEN"
echo
echo "Quick check:"
echo "  curl https://$FQDN/health"
echo
echo "Tear down everything later:"
echo "  az group delete --name $RG --yes --no-wait"
