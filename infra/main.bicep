// Azure Container Apps with GPU Support for gemma-3-4b-it
// Note: GPU workload profiles in Azure Container Apps are currently in preview
// and may not be available in all regions

targetScope = 'resourceGroup'

@description('Location for all resources')
param location string = resourceGroup().location

@description('Name of the Container App (legacy)')
param containerAppName string = 'gemma3-4b-llm-app'

@description('Name of the Container Apps Environment (legacy)')
param environmentName string = 'gemma3-4b-env'

@description('Name of the Container Apps managed environment')
param managedEnvironments_me_gpullm_name string = environmentName

@description('Name of the Azure Container Registry')
param registries_jvllmcontainers_name string = 'jvllmcontainers'

@description('Name of the Log Analytics workspace')
param workspaces_workspacegpullmrg9013_name string = 'workspacegpullmrg9013'

@description('Container image to deploy')
param containerImageName string = 'mcr.microsoft.com/placeholder:latest' // Replace with your ACR image

@description('CPU cores for the container')
param cpuCores string = '4.0'

@description('Memory for the container')
param memorySize string = '16Gi'

@description('Minimum replicas')
param minReplicas int = 0

@description('Maximum replicas')
param maxReplicas int = 1

// Log Analytics Workspace for monitoring
resource workspaces_workspacegpullmrg9013_name_resource 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: workspaces_workspacegpullmrg9013_name
}

resource registries_jvllmcontainers_name_resource 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registries_jvllmcontainers_name
}

var acrLoginServer = '${registries_jvllmcontainers_name}.azurecr.io'
var acrCredentials = listCredentials(registries_jvllmcontainers_name_resource.id, '2019-05-01')
var acrUsername = acrCredentials.username
var acrPassword = acrCredentials.passwords[0].value

resource managedEnvironments_me_gpullm_name_resource 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: managedEnvironments_me_gpullm_name
}

resource containerapps_gemma_3_4b_gpu_name_resource 'Microsoft.App/containerApps@2024-03-01' = {
  name: containerAppName
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    environmentId: managedEnvironments_me_gpullm_name_resource.id
    // For Consumption GPU, this must match the environment workload profile *name*
    // e.g. "NC24-A100" (type: "Consumption-GPU-NC24-A100")
    workloadProfileName: 'NC24-A100'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 5000
        transport: 'auto'
        allowInsecure: false
      }
      maxInactiveRevisions: 100
      secrets: [
        {
          name: 'container-registry-password'
          value: acrPassword
        }
      ]
      registries: [
        {
          server: acrLoginServer
          username: acrUsername
          passwordSecretRef: 'container-registry-password'
        }
      ]
    }
    template: {
      containers: [
        {
          name: containerAppName
          image: containerImageName
          resources: {
            cpu: json(cpuCores)
            memory: memorySize
          }
          env: [
            {
              name: 'CUDA_VISIBLE_DEVICES'
              value: '0'
            }
            {
              name: 'NVIDIA_VISIBLE_DEVICES'
              value: 'all'
            }
            {
              name: 'NVIDIA_DRIVER_CAPABILITIES'
              value: 'compute,utility'
            }
            {
              name: 'VLLM_GPU_MEMORY_UTILIZATION'
              value: '0.90'
            }
            {
              name: 'VLLM_ENFORCE_EAGER'
              value: 'false'
            }
          ]
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
      }
    }
  }
}

output containerAppUrl string = 'https://${containerapps_gemma_3_4b_gpu_name_resource.properties.configuration.ingress.fqdn}'
output containerAppName string = containerapps_gemma_3_4b_gpu_name_resource.name
output logAnalyticsWorkspaceId string = workspaces_workspacegpullmrg9013_name_resource.id
