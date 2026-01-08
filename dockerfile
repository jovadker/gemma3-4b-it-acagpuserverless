# Stage 1: Build stage to download the model
FROM nvidia/cuda:12.4.0-devel-ubuntu22.04 AS builder

WORKDIR /app

# Set timezone non-interactively
ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Etc/UTC

# Install Python 3.11
RUN apt-get update && apt-get install -y \
    software-properties-common \
    git \
    && add-apt-repository ppa:deadsnakes/ppa \
    && apt-get update && apt-get install -y \
    python3.11 \
    python3.11-venv \
    python3.11-dev \
    python3-pip \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Create and activate a virtual environment
RUN python3.11 -m venv /app/venv
ENV PATH="/app/venv/bin:$PATH"

# Copy requirements file
COPY requirements.txt .

# Install dependencies
RUN pip install --upgrade pip && \
    pip install -r requirements.txt

# Use build argument for HuggingFace token
ARG HF_TOKEN
ENV HF_TOKEN=${HF_TOKEN}

# Login to HuggingFace and download the Gemma 3 4B model
RUN if [ -n "$HF_TOKEN" ]; then \
        hf auth login --token $HF_TOKEN --add-to-git-credential; \
    fi && \
    hf download google/gemma-3-4b-it --local-dir /app/models/gemma-3-4b-it


# Stage 2: Final runtime image
FROM nvidia/cuda:12.4.0-runtime-ubuntu22.04

WORKDIR /app

# Set timezone non-interactively
ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Etc/UTC

# Install Python 3.11 and runtime dependencies
RUN apt-get update && apt-get install -y \
    software-properties-common \
    && add-apt-repository ppa:deadsnakes/ppa \
    && apt-get update && apt-get install -y \
    python3.11 \
    python3.11-venv \
    python3.11-dev \
    build-essential \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Ensure Triton/torchinductor can find a compiler at runtime
ENV CC=gcc
ENV CXX=g++

# Copy the virtual environment from builder
COPY --from=builder /app/venv /app/venv
ENV PATH="/app/venv/bin:$PATH"

# Copy the downloaded model from builder
COPY --from=builder /app/models /app/models

# Copy the rest of the application
COPY . /app

# Set build time environment variable
ARG BUILD_TIME
ENV BUILD_TIME=${BUILD_TIME}

# Set environment variables
ENV NAME=World
ENV HF_HOME=/app/.cache/huggingface

# Expose the port the app runs on
EXPOSE 5000

# Define the command to run the app
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "5000"]