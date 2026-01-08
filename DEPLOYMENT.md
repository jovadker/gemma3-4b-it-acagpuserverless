# Deploy gemma-3-4b-it (GPU) to Azure Container Apps

This repo runs a FastAPI service backed by GPU-enabled inference. The container image is built from [dockerfile](dockerfile) and downloads the gemma-3-4b-it model during the image build.

## What gets deployed

- **HTTP server**: `uvicorn app:app --port 5000`
- **Endpoints**:
  - `GET /` serves the UI from `web/`
  - `GET /health` health check
  - `POST /predict` non-streaming inference
  - `POST /predictstream` streaming inference

## Prerequisites

- Azure CLI installed (`az`) and logged in
- Permissions to deploy to a resource group and to create/update Container Apps + ACR
- An Azure Container Apps environment with a **GPU workload profile** available in your target region
  - GPU on Container Apps can be preview/region-limited; verify availability for your subscription and region

## Recommended path: run the deployment script

The canonical deployment flow for this repo is [deployment.ps1](deployment.ps1). It:

1. Deploys infra via Bicep (see [infra/main.bicep](infra/main.bicep) + [infra/main.parameters.json](infra/main.parameters.json))
2. Builds and pushes the container image using `az acr build`
3. Recreates the Container App with a GPU workload profile
4. Assigns `AcrPull` to the app's system-assigned managed identity

Run it from PowerShell:

```powershell
./deployment.ps1
```

Before running, review/edit the hard-coded names inside the script (resource group, ACR name, environment name, app name, workload profile name).

## Configure the Bicep parameters

Update the values in [infra/main.parameters.json](infra/main.parameters.json) to match your environment:

- `location`
- `registries_jvllmcontainers_name` (ACR name)
- `managedEnvironments_me_gpullm_name` (Container Apps environment name)
- `containerAppName` (Container App name)
- `containerImage` (ACR image reference, e.g. `<acr>.azurecr.io/gemma-3-4b-gpu:latest`)
- `cpuCores`, `memorySize`, `minReplicas`, `maxReplicas`

## Manual steps (mirrors deployment.ps1)

If you prefer running commands yourself, these are the same building blocks used by the script. Replace the placeholders.

```powershell
$resourceGroup = "<your-rg>"
$location = "<your-region>"
$acrName = "<your-acr-name>"
$image = "$acrName.azurecr.io/gemma-3-4b-gpu:latest"
$appName = "<your-containerapp-name>"
$environmentName = "<your-containerapps-env-name>"
$workloadProfileName = "<your-gpu-workload-profile-name>"  # e.g. NC24-A100

# Deploy infra
az deployment group create `
  --resource-group $resourceGroup `
  --template-file .\infra\main.bicep `
  --parameters .\infra\main.parameters.json

# Build + push image (server-side build)
az acr build --registry $acrName --resource-group $resourceGroup --image gemma-3-4b-gpu:latest .

# Recreate container app
az containerapp delete --name $appName --resource-group $resourceGroup --yes

az containerapp create --name $appName `
  --resource-group $resourceGroup `
  --image $image `
  --environment $environmentName `
  --ingress external --target-port 5000 `
  --workload-profile-name $workloadProfileName `
  --cpu 4 --memory 8Gi `
  --registry-server "$acrName.azurecr.io" `
  --env-vars CUDA_VISIBLE_DEVICES=0 NVIDIA_VISIBLE_DEVICES=all NVIDIA_DRIVER_CAPABILITIES=compute,utility `
  --min-replicas 1 --max-replicas 10 --system-assigned

# Grant ACR pull to the app identity
$principalId = az containerapp show --name $appName --resource-group $resourceGroup --query identity.principalId -o tsv
$acrId = az acr show --name $acrName --resource-group $resourceGroup --query id -o tsv
az role assignment create --assignee $principalId --role AcrPull --scope $acrId
```

## Verify the deployment

```powershell
$fqdn = az containerapp show --name $appName --resource-group $resourceGroup --query properties.configuration.ingress.fqdn -o tsv
$baseUrl = "https://$fqdn"

Invoke-RestMethod -Uri "$baseUrl/health" -Method GET
Invoke-RestMethod -Uri "$baseUrl/predict" -Method POST -Headers @{"Content-Type"="application/json"} -Body '{"prompt":"What is 2+2?"}'
```

## Troubleshooting

### Workload profile errors

If `az deployment group create/validate` fails with `WorkloadProfileNotFound` (examples are captured in [az-deploy-debug.txt](az-deploy-debug.txt) and [az-validate-debug.txt](az-validate-debug.txt)), it means the **Container Apps environment does not have a workload profile with the exact name** you’re referencing.

- Ensure your Container Apps environment was created with the GPU workload profile you intend to use.
- Ensure the name used by:
  - `--workload-profile-name ...` in the CLI, and
  - `workloadProfileName` in [infra/main.bicep](infra/main.bicep)
  matches the environment’s workload profile *name*.

### Image builds take a long time

The image build downloads the model (`google/gemma-3-4b-it`) during `docker build` / `az acr build`. Expect long build times and a large image.

### Cold starts are slow

The model is loaded at startup in [app.py](app.py). Keep `minReplicas` at 1 if you need consistent latency.

## References

- https://learn.microsoft.com/azure/container-apps/gpu-workloads
- https://hub.docker.com/r/nvidia/cuda
- https://github.com/abetlen/llama-cpp-python
