from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, StreamingResponse
from pydantic import BaseModel
from llama_cpp import Llama
import logging
import json
import asyncio

# huggingface-cli download bartowski/gemma-3-4b-it-GGUF gemma-3-4b-it-Q4_K_M.gguf
# Moving file to /home/vscode/.cache/huggingface/hub/models--bartowski--gemma-3-4b-it-GGUF/blobs/...
# uvicorn app:app --host 0.0.0.0 --port 5000

# Initialize the model
llm = Llama(
    model_path="/home/vscode/.cache/huggingface/hub/models--bartowski--gemma-3-4b-it-GGUF/snapshots/.../gemma-3-4b-it-Q4_K_M.gguf",
    n_ctx=8192,
    chat_format="gemma",
    n_threads=8,
    n_gpu_layers=-1,  # Set to 0 for CPU-only inference, or -1 for full GPU inference.
)

output = llm.create_chat_completion(
    messages=[
        { "role": "system", "content": "You are a helpful assistant." },
        { "role": "user", "content": "2+2=?",}
            ], stream=True)

for chunk in output:
        delta = chunk['choices'][0]['delta']
        logging.info(f"Delta: {delta}")
        #print(f"Delta: {delta}")
        if 'role' in delta:
            logging.info(delta['role'], end=': ')
            #print(delta['role'], end=': ')
        elif 'content' in delta:
            logging.info(delta['content'], end='')
            #print(delta['content'], end='')
            res = json.dumps({"response": delta['content']})
            print(res)

print("done")




