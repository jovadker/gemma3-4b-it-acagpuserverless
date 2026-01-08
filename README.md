# 🤖 gemma-3-4b-it GPU-Accelerated LLM Hosting

A production-ready solution for hosting Large Language Models (LLMs) with GPU acceleration on Azure Container Apps. This project demonstrates how to deploy Google's gemma-3-4b-it model downloaded from HuggingFace. It can also be adapted to host custom or fine-tuned models.

## 🎯 Overview

This repository provides a complete stack for serving LLMs with:
- **FastAPI backend** with streaming response support
- **GPU-accelerated inference** using llama-cpp-python with CUDA
- **Modern web interface** with real-time streaming responses
- **Azure Container Apps deployment** with GPU workload profiles
- **Docker containerization** with NVIDIA CUDA support

## ✨ Key Features

- 🚀 **GPU Acceleration**: Utilizes NVIDIA GPUs for fast inference
- 📦 **HuggingFace Integration**: Downloads models directly from HuggingFace Hub
- 🔄 **Streaming Responses**: Real-time token-by-token response generation
- 🎨 **Clean Web UI**: Markdown rendering with syntax highlighting
- ☁️ **Azure Deployment**: Infrastructure as Code with Bicep templates
- 🐳 **Docker Ready**: Multi-stage build for optimized container images

## 🧠 Model Information

This project uses **Google gemma-3-4b-it Instruct** (quantized GGUF format) downloaded from HuggingFace:
- Model: `bartowski/gemma-3-4b-it-GGUF`
- Format: Quantized Q4_K_M GGUF for efficient inference
- Context: 8K tokens
- Size: ~2.7 GB

### 🔧 Using Your Own Model

**This approach works with any GGUF model from HuggingFace or your own fine-tuned models!**

To use a different model:

1. **Update the Dockerfile** (line 30):
   ```dockerfile
   RUN hf download <your-org>/<your-model> <model-file.gguf> --local-dir .
   ```

2. **Update app.py** (line 37) with your model filename:
   ```python
   llm = Llama(
       model_path="./your-model-file.gguf",
       # ... other parameters
   )
   ```

3. **For private models**, pass your HuggingFace token during build:
   ```bash
   docker build --secret id=hf_token,src=hf_token.txt -t your-llm .
   ```

## 🏗️ Architecture

```
┌─────────────────┐
│   Web Browser   │
│  (index.html)   │
└────────┬────────┘
         │ HTTP
         ▼
┌─────────────────┐
│  FastAPI Server │
│    (app.py)     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ llama-cpp-python│
│  (CUDA-enabled) │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   NVIDIA GPU    │
│  (A100/T4/etc)  │
└─────────────────┘
```

## 🚀 Quick Start

### Prerequisites

**Important:** Before downloading the gemma-3-4b-it model, you must:
1. Create a HuggingFace account at https://huggingface.co
2. Visit the model page: https://huggingface.co/google/gemma-3-4b-it
3. Accept the terms and conditions directly on the HuggingFace portal
4. Login to HuggingFace CLI: `hf auth login`

Without accepting the terms, you'll get access errors when attempting to download the model.

### Local Development (Without GPU)

```bash
# Install dependencies
pip install -r requirements.txt

# Login to HuggingFace (required for Gemma models)
hf auth login

# Download the model
hf download google/gemma-3-4b-it --local-dir .

# Run the server
uvicorn app:app --reload --host 0.0.0.0 --port 5000
```

Visit `http://localhost:5000/static/index.html`

### Docker Build (GPU-enabled)

```bash
# Build the image
docker build -t gemma-3-4b-gpu .

# Run with GPU support
docker run --gpus all -p 5000:5000 gemma-3-4b-gpu
```

## ☁️ Azure Deployment

### Prerequisites

- Azure subscription
- Azure CLI installed and logged in
- Azure Container Registry (ACR)

### Deployment Steps

1. **Build and push Docker image**:
   ```powershell
   az acr build --registry <your-acr-name> --image gemma-3-4b-gpu:latest .
   ```

2. **Create GPU-enabled Container Apps environment**:
   ```powershell
   az containerapp env create `
     --name me-gpullm `
     --resource-group GPU.LLM.RG `
     --location eastus `
     --enable-workload-profiles
   
   az containerapp env workload-profile add `
     --name me-gpullm `
     --resource-group GPU.LLM.RG `
     --workload-profile-name NC24-A100 `
     --workload-profile-type NC24-A100
   ```

3. **Deploy the container app**:
   ```powershell
   az containerapp create `
     --name gemma-3-4b-gpu `
     --resource-group GPU.LLM.RG `
     --image <your-acr>.azurecr.io/gemma-3-4b-gpu:latest `
     --cpu 4 --memory 8Gi `
     --environment me-gpullm `
     --registry-server <your-acr>.azurecr.io `
     --ingress 'external' --target-port 5000 `
     --workload-profile-name NC24-A100 `
     --env-vars CUDA_VISIBLE_DEVICES=0 NVIDIA_VISIBLE_DEVICES=all `
     --min-replicas 1 --max-replicas 2 `
     --system-assigned
   ```

See `DEPLOYMENT.md` for detailed deployment instructions.

## 📁 Project Structure

```
gemma-3-4b/
├── app.py                  # FastAPI application
├── requirements.txt        # Python dependencies
├── dockerfile             # Multi-stage Docker build
├── deployment.ps1         # Azure deployment script
├── web/
│   ├── index.html         # Web interface
│   ├── ollama.js          # Streaming response handler
│   ├── style.css          # UI styling
│   └── showdown.min.js    # Markdown renderer
└── infra/
    ├── main.bicep         # Azure infrastructure
    ├── main.json          # ARM template
    └── main.parameters.json
```

## 🔌 API Endpoints

### `POST /predict`
Generate a complete response

### `POST /predictstream`
Generate streaming response (recommended)

### `GET /health`
Health check endpoint

### `GET /static/index.html`
Web interface

## 🎨 Web Interface Features

- **Real-time streaming**: See responses as they're generated
- **Markdown rendering**: Properly formatted code blocks and text
- **Auto-clear input**: Question field clears after each response
- **Keyboard shortcut**: Press Enter to submit

## 🔐 Environment Variables

- `CUDA_VISIBLE_DEVICES`: GPU device IDs to use
- `NVIDIA_VISIBLE_DEVICES`: NVIDIA device visibility
- `NVIDIA_DRIVER_CAPABILITIES`: Driver capabilities (compute, utility)

## 📊 Performance

- **GPU Layers**: All layers offloaded to GPU (`n_gpu_layers=-1`)
- **Batch Size**: Optimized for GPU (`n_batch=512`)
- **Memory Lock**: Model locked in memory for faster inference
- **Context Window**: 8192 tokens

## 🛠️ Customization

### Adjusting Model Parameters

Edit `app.py` to modify:
- `n_ctx`: Context window size
- `n_gpu_layers`: Number of layers on GPU
- `n_batch`: Batch size for processing
- `chat_format`: Chat template format

### Styling the Web Interface

Modify `web/style.css` to customize the UI appearance.

## 📝 License

This project is provided as-is for educational and development purposes.

## 🤝 Contributing

Feel free to submit issues and enhancement requests!

## 📚 Resources

- [Google Gemma 3 Models](https://huggingface.co/bartowski/gemma-3-4b-it-GGUF)
- [llama-cpp-python Documentation](https://llama-cpp-python.readthedocs.io/)
- [Azure Container Apps](https://learn.microsoft.com/azure/container-apps/)
- [HuggingFace Hub](https://huggingface.co/docs/hub/index)

---

**Note**: This solution is perfect for hosting your own fine-tuned models! Simply replace the HuggingFace model download command with your custom model and deploy following the same process.
