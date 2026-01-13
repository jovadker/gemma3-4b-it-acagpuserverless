# Stop execution on any error
$ErrorActionPreference = "Stop"

#az login --tenant d48594cd-9d21-483f-a3f0-b10090b34d90

$ContainerAppName = "gemma-3-4b-gpu"
$acrName = "jvllmcontainers"
$acrLoginServer = "$acrName.azurecr.io"
$ContainerImageName = "gemma-3-4b-gpu:latest"
$ContainerImageFullName = "$acrLoginServer/$ContainerImageName"

# Deploy infrastructure using Bicep
Write-Host "Deploying infrastructure..." -ForegroundColor Cyan
az deployment group create `
    --resource-group GPU.LLM.RG `
    --template-file .\infra\main.bicep `
    --parameters .\infra\main.parameters.json containerAppName=$ContainerAppName containerImageName=$ContainerImageFullName
if ($LASTEXITCODE -ne 0) { throw "Infrastructure deployment failed" }

Write-Host "Logging into ACR..." -ForegroundColor Cyan
az acr login --name $acrName
if ($LASTEXITCODE -ne 0) { throw "ACR login failed" }

Write-Host "Building Docker image..." -ForegroundColor Cyan
$buildTime = Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ"

# Check if HF_TOKEN environment variable is set
$hfToken = $env:HF_TOKEN
if (-not $hfToken) {
    Write-Host "WARNING: HF_TOKEN environment variable not set. Model download may fail for gated models." -ForegroundColor Yellow
    Write-Host "Set your HuggingFace token: `$env:HF_TOKEN = 'your_token_here'" -ForegroundColor Yellow
}

az acr build --registry $acrName --resource-group GPU.LLM.RG --image $ContainerImageName --build-arg "BUILD_TIME=$buildTime" --build-arg "HF_TOKEN=$hfToken" .
if ($LASTEXITCODE -ne 0) { throw "Docker build failed" }

# Delete existing container app if it exists
Write-Host "Deleting existing container app..." -ForegroundColor Cyan
az containerapp delete --name $ContainerAppName --resource-group GPU.LLM.RG --yes

Write-Host "Creating container app..." -ForegroundColor Cyan
#create a container app with system-assigned identity
az containerapp create --name $ContainerAppName `
    --resource-group GPU.LLM.RG `
    --image $ContainerImageFullName `
    --cpu 8 --memory 16Gi --environment me-gpullm `
    --registry-server $acrLoginServer `
    --ingress 'external' --target-port 5000 --workload-profile-name NC24-A100 `
    --env-vars NVIDIA_DRIVER_CAPABILITIES=compute,utility VLLM_GPU_MEMORY_UTILIZATION=0.70 VLLM_ENFORCE_EAGER=true `
    --min-replicas 2 --max-replicas 2 `
    --scale-rule-name http-concurrency --scale-rule-http-concurrency 2 `
    --system-assigned
if ($LASTEXITCODE -ne 0) { throw "Container app creation failed" }

# Assign AcrPull role to the container app's managed identity
Write-Host "Assigning AcrPull role..." -ForegroundColor Cyan
$principalId = az containerapp show --name $ContainerAppName --resource-group GPU.LLM.RG --query identity.principalId -o tsv
if ($LASTEXITCODE -ne 0) { throw "Failed to get principal ID" }

$acrId = az acr show --name $acrName --resource-group GPU.LLM.RG --query id -o tsv
if ($LASTEXITCODE -ne 0) { throw "Failed to get ACR ID" }

az role assignment create --assignee $principalId --role AcrPull --scope $acrId
if ($LASTEXITCODE -ne 0) { throw "Failed to assign AcrPull role" }

Write-Host "Deployment completed successfully!" -ForegroundColor Green
