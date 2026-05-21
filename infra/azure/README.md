# Deploy surd-server to Azure (free-tier sized, fed by GitHub)

```
GitHub push
   │
   ▼  (GHA workflow)
Build multi-arch image  ──►  ghcr.io/<you>/<repo>/surd-server:<sha>  (free)
                                              │
                                              ▼  (GHA workflow)
                                  Azure Container App pulls image,
                                  rolls a new revision, scales to zero
                                  when idle.
                                              │
                                              ▼
                                  /data persisted on Azure Files (5 GiB)
```

## One-time setup

### 1. Push the repo to GitHub
The image must be reachable, and the workflow needs a place to live.

### 2. Make the GHCR package public (so Azure can pull anonymously)
After the first successful workflow run, go to:
- your GitHub profile → **Packages** → `surd-server`
- **Package settings** → **Change visibility** → **Public**

If you'd rather keep it private, set `GHCR_USER` and `GHCR_PAT` env vars when
running `deploy.sh` — the script will wire those in as a registry credential
on the Container App.

### 3. Run `deploy.sh` once (first-time provisioning)

```bash
# from the repo root
export GHCR_IMAGE=ghcr.io/<you>/<repo>/surd-server
az login                    # if not already
az account set --subscription <id>   # if you have multiple

bash infra/azure/deploy.sh
```

This creates:
- resource group `surd-rg` in `centralindia`
- storage account + 5 GiB Azure Files share (`surd-data`)
- Container Apps environment `surd-env`
- Container App `surd-server` with min=0, max=1, 0.25 vCPU, 0.5 GiB

It prints the URL, token, and the `surd link` command for collaborators.

### 4. Wire up auto-deploy from GitHub Actions

Create a service principal scoped to the resource group:

```bash
SUB=$(az account show --query id -o tsv)
az ad sp create-for-rbac \
  --name surd-gha-deployer \
  --role contributor \
  --scopes /subscriptions/$SUB/resourceGroups/surd-rg \
  --sdk-auth
```

Copy the entire JSON output. In GitHub:

- **Settings → Secrets and variables → Actions → New repository secret**
  - `AZURE_CREDENTIALS` = (paste the JSON)
- (Optional) **Variables** tab:
  - `AZURE_RG` = `surd-rg`  (only if you changed the default)
  - `AZURE_APP` = `surd-server`  (only if you changed the default)

From then on, every push to `main` builds, publishes to GHCR, and rolls the
Azure Container App to the new image automatically. The deploy job no-ops
cleanly if `AZURE_CREDENTIALS` isn't set, so the workflow still works in
forks or before you've provisioned Azure.

## Costs (free-tier sizing)

| Component | Est. monthly |
|---|---|
| Container Apps Consumption (0.25 vCPU / 0.5 GiB, scaled to zero) | $0 (within free 180k vCPU-sec + 360k GiB-sec) |
| Azure Files (5 GiB Standard_LRS) | ~$0.30 |
| GHCR (public package) | $0 |
| Egress (a few GB/mo) | ~$0.10–1 |
| **Total** | **under $1/mo** for personal/small-team use |

The cost only goes up if the hub is constantly active (consumes free seconds)
or if many collaborators pull large amounts of state through it.

## Tear down

```bash
az group delete --name surd-rg --yes --no-wait
```
Removes everything in one shot.
