from fastapi import FastAPI, HTTPException
from fastapi import File, Form, UploadFile
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, StreamingResponse
from pydantic import BaseModel
from vllm import SamplingParams
from vllm.engine.arg_utils import AsyncEngineArgs
from vllm.engine.async_llm_engine import AsyncLLMEngine
from vllm.utils import random_uuid
import logging
import json
import asyncio
import os
from io import BytesIO
import threading
from typing import List

app = FastAPI()
# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def _env_float(name: str, default: float) -> float:
    value = os.environ.get(name)
    if value is None or value == "":
        return default
    try:
        return float(value)
    except ValueError:
        logger.warning(f"Invalid {name}={value!r}; using default {default}")
        return default


def _env_int(name: str, default: int) -> int:
    value = os.environ.get(name)
    if value is None or value == "":
        return default
    try:
        return int(value)
    except ValueError:
        logger.warning(f"Invalid {name}={value!r}; using default {default}")
        return default


def _env_bool(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None or value == "":
        return default
    normalized = value.strip().lower()
    if normalized in {"1", "true", "t", "yes", "y", "on"}:
        return True
    if normalized in {"0", "false", "f", "no", "n", "off"}:
        return False
    logger.warning(f"Invalid {name}={value!r}; using default {default}")
    return default


VLLM_GPU_MEMORY_UTILIZATION = _env_float("VLLM_GPU_MEMORY_UTILIZATION", 0.6)
VLLM_MAX_MODEL_LEN = _env_int("VLLM_MAX_MODEL_LEN", 4096)
VLLM_MAX_TOKENS = _env_int("VLLM_MAX_TOKENS", 2048)
VLLM_ENFORCE_EAGER = _env_bool("VLLM_ENFORCE_EAGER", True)

_vision_lock = asyncio.Lock()
_vision_processor = None
_vision_model = None
_vision_device = None

# Initialize model immediately on startup
logger.info("Initializing vLLM with gemma-3-4b-it model...")
logger.info(f"CUDA_VISIBLE_DEVICES: {os.environ.get('CUDA_VISIBLE_DEVICES', 'not set')}")
logger.info(f"NVIDIA_VISIBLE_DEVICES: {os.environ.get('NVIDIA_VISIBLE_DEVICES', 'not set')}")

# Initialize vLLM with the gemma-3-4b-it model
try:
    engine_args = AsyncEngineArgs(
        model="/app/models/gemma-3-4b-it",
        tensor_parallel_size=1,  # Adjust based on number of GPUs
        gpu_memory_utilization=VLLM_GPU_MEMORY_UTILIZATION,
        max_model_len=VLLM_MAX_MODEL_LEN,
        enforce_eager=VLLM_ENFORCE_EAGER,
        trust_remote_code=True,
    )
    llm = AsyncLLMEngine.from_engine_args(engine_args)
    logger.info("Model engine initialized successfully with vLLM AsyncLLMEngine!")
except Exception as e:
    logger.error(f"Failed to load model: {e}")
    raise

app.mount("/static", StaticFiles(directory="web"), name="static")


@app.middleware("http")
async def _add_instance_id_header(request, call_next):
    response = await call_next(request)
    # Useful for load testing / verifying scale-out. In Azure Container Apps this is typically unique per replica.
    instance_id = os.environ.get("HOSTNAME") or os.environ.get("CONTAINER_APP_REVISION") or ""
    if instance_id:
        response.headers["x-instance-id"] = instance_id
    return response


async def _get_gemma_vision():
    """Lazy-load multimodal gemma-3-4b-it for image+text -> text generation."""
    global _vision_processor, _vision_model, _vision_device
    if _vision_processor is not None and _vision_model is not None:
        return _vision_processor, _vision_model, _vision_device

    async with _vision_lock:
        if _vision_processor is not None and _vision_model is not None:
            return _vision_processor, _vision_model, _vision_device

        import torch
        from transformers import AutoProcessor, Gemma3ForConditionalGeneration

        model_path = os.environ.get("GEMMA_MODEL_PATH", "/app/models/gemma-3-4b-it")
        device = "cuda" if torch.cuda.is_available() else "cpu"

        processor = AutoProcessor.from_pretrained(model_path)

        if device == "cuda":
            model = Gemma3ForConditionalGeneration.from_pretrained(
                model_path,
                device_map="auto",
                torch_dtype=torch.bfloat16,
            ).eval()
        else:
            model = Gemma3ForConditionalGeneration.from_pretrained(
                model_path,
                device_map="cpu",
            ).eval()

        _vision_processor = processor
        _vision_model = model
        _vision_device = device
        logger.info(f"Gemma vision model ready on {device}: {model_path}")

        return _vision_processor, _vision_model, _vision_device

@app.get("/health")
async def health():
    """Health check endpoint"""
    return {"status": "healthy", "model_loaded": True}

@app.get("/buildinfo")
async def build_info():
    """Build information endpoint"""
    build_time = os.environ.get('BUILD_TIME', 'Unknown')
    return {
        "build_time": build_time,
        "model": "google/gemma-3-4b-it",
        "framework": "vLLM"
    }

@app.get("/", response_class=HTMLResponse)
async def read_index():
    with open("web/index.html") as f:
        return f.read()


class Item(BaseModel):
    prompt: str
    stream: bool = False


@app.post("/predict")
async def predict(item: Item):
    import time
    start_time = time.time()
    
    prompt = item.prompt
    if not prompt:
        logging.info("No prompt provided")
        return {"error": "No prompt provided"}

    # Format the prompt for Gemma
    formatted_prompt = f"<start_of_turn>user\n{prompt}<end_of_turn>\n<start_of_turn>model\n"

    logging.info(f"Received prompt (length: {len(prompt)} chars)")

    # Create sampling parameters
    sampling_params = SamplingParams(
        temperature=0.7,
        top_p=0.9,
        max_tokens=VLLM_MAX_TOKENS,
        stop=["<end_of_turn>"]
    )

    request_id = random_uuid()

    # Run the model (collect the final streamed output)
    output = None
    async for request_output in llm.generate(formatted_prompt, sampling_params, request_id):
        output = request_output

    if output is None or not output.outputs:
        raise HTTPException(status_code=500, detail="No output generated")

    generated_text = output.outputs[0].text
    prompt_tokens = len(output.prompt_token_ids or [])
    completion_tokens = len(output.outputs[0].token_ids or [])
    total_tokens = prompt_tokens + completion_tokens

    # Add timings to the response
    elapsed_time = time.time() - start_time
    tokens_per_second = completion_tokens / elapsed_time if elapsed_time > 0 else 0
    
    logging.info(f"Generated {completion_tokens} tokens in {elapsed_time:.2f}s ({tokens_per_second:.2f} tokens/s)")
    
    response = {
        "response": generated_text,
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": total_tokens,
        },
        "performance": {
            "elapsed_seconds": round(elapsed_time, 2),
            "tokens_per_second": round(tokens_per_second, 2)
        }
    }
    return response

@app.post("/predictstream")
async def predictstream(item: Item):
    prompt = item.prompt
    if not prompt:
        logging.info("No prompt provided")
        return {"error": "No prompt provided"}

    logging.info(f"Received streaming prompt: {prompt}")

    # Format the prompt for Gemma
    formatted_prompt = f"<start_of_turn>user\n{prompt}<end_of_turn>\n<start_of_turn>model\n"

    # Create sampling parameters
    sampling_params = SamplingParams(
        temperature=0.7,
        top_p=0.9,
        max_tokens=VLLM_MAX_TOKENS,
        stop=["<end_of_turn>"]
    )

    request_id = random_uuid()

    async def token_generator():
        previous_text = ""
        try:
            async for request_output in llm.generate(formatted_prompt, sampling_params, request_id):
                if not request_output.outputs:
                    continue

                current_text = request_output.outputs[0].text
                delta = current_text[len(previous_text):]
                previous_text = current_text

                if delta:
                    # Frontend expects repeated JSON objects in the raw stream.
                    yield json.dumps({"response": delta}) + "\n"

        except asyncio.CancelledError:
            logging.info("Streaming cancelled")
            try:
                await llm.abort(request_id)
            except Exception:
                pass
            return

        except Exception as e:
            logging.error(f"Error in token generator: {str(e)}")
            yield json.dumps({"error": str(e)}) + "\n"

    # Keep the same wire format the web UI parses (JSON objects in stream).
    return StreamingResponse(token_generator(), media_type="application/json")


@app.post("/describeimage")
async def describe_image(
    file: UploadFile = File(...),
    prompt: str = Form("Describe this image."),
    max_new_tokens: int = Form(512),
):
    """Upload an image and ask Gemma 3 (multimodal) to describe it."""

    if file is None:
        raise HTTPException(status_code=400, detail="No image uploaded")

    try:
        contents = await file.read()
        if not contents:
            raise HTTPException(status_code=400, detail="Empty image upload")

        max_new_tokens = int(max_new_tokens)
        if max_new_tokens < 1 or max_new_tokens > 2048:
            raise HTTPException(status_code=400, detail="max_new_tokens must be between 1 and 2048")

        import torch
        from PIL import Image

        image = Image.open(BytesIO(contents)).convert("RGB")

        processor, model, device = await _get_gemma_vision()

        messages = [
            {
                "role": "system",
                "content": [{"type": "text", "text": "You are a helpful assistant."}],
            },
            {
                "role": "user",
                "content": [
                    {"type": "image", "image": image},
                    {"type": "text", "text": prompt},
                ],
            },
        ]

        inputs = processor.apply_chat_template(
            messages,
            add_generation_prompt=True,
            tokenize=True,
            return_dict=True,
            return_tensors="pt",
        )

        if device == "cuda":
            inputs = inputs.to("cuda", dtype=torch.bfloat16)
        else:
            inputs = inputs.to("cpu")

        input_len = inputs["input_ids"].shape[-1]

        with torch.inference_mode():
            generation = model.generate(**inputs, max_new_tokens=max_new_tokens, do_sample=False)
            generation = generation[0][input_len:]

        description = processor.decode(generation, skip_special_tokens=True)
        return {
            "response": description,
            "model": "google/gemma-3-4b-it",
            "filename": file.filename,
            "max_new_tokens": max_new_tokens,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Failed to describe image")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/describeimagebatch")
async def describe_image_batch(
    files: List[UploadFile] = File(...),
    prompt: str = Form("Describe these images."),
    max_new_tokens: int = Form(512),
):
    """Upload multiple images and ask Gemma 3 (multimodal) to describe each using the same prompt."""

    if files is None or len(files) == 0:
        raise HTTPException(status_code=400, detail="No images uploaded")

    try:
        max_new_tokens = int(max_new_tokens)
        if max_new_tokens < 1 or max_new_tokens > 2048:
            raise HTTPException(status_code=400, detail="max_new_tokens must be between 1 and 2048")

        import torch
        from PIL import Image

        processor, model, device = await _get_gemma_vision()

        results = []
        for upload in files:
            try:
                contents = await upload.read()
                if not contents:
                    raise HTTPException(status_code=400, detail=f"Empty image upload: {upload.filename}")

                image = Image.open(BytesIO(contents)).convert("RGB")

                messages = [
                    {
                        "role": "system",
                        "content": [{"type": "text", "text": "You are a helpful assistant."}],
                    },
                    {
                        "role": "user",
                        "content": [
                            {"type": "image", "image": image},
                            {"type": "text", "text": prompt},
                        ],
                    },
                ]

                inputs = processor.apply_chat_template(
                    messages,
                    add_generation_prompt=True,
                    tokenize=True,
                    return_dict=True,
                    return_tensors="pt",
                )

                if device == "cuda":
                    inputs = inputs.to("cuda", dtype=torch.bfloat16)
                else:
                    inputs = inputs.to("cpu")

                input_len = inputs["input_ids"].shape[-1]

                with torch.inference_mode():
                    generation = model.generate(**inputs, max_new_tokens=max_new_tokens, do_sample=False)
                    generation = generation[0][input_len:]

                description = processor.decode(generation, skip_special_tokens=True)
                results.append(
                    {
                        "filename": upload.filename,
                        "response": description,
                    }
                )

            except HTTPException as he:
                results.append({"filename": getattr(upload, "filename", None), "error": str(he.detail)})
            except Exception as e:
                logger.exception("Failed to describe one image in batch")
                results.append({"filename": getattr(upload, "filename", None), "error": str(e)})

        return {
            "results": results,
            "model": "google/gemma-3-4b-it",
            "max_new_tokens": max_new_tokens,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Failed to describe image batch")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/describeimagebatchstream")
async def describe_image_batch_stream(
    files: List[UploadFile] = File(...),
    prompt: str = Form("Describe these images."),
    max_new_tokens: int = Form(512),
):
    """Upload multiple images and stream one result per image as NDJSON.

    This is sequential (one image at a time) but provides incremental results so
    the UI can update as each image completes.
    """

    if files is None or len(files) == 0:
        raise HTTPException(status_code=400, detail="No images uploaded")

    try:
        max_new_tokens = int(max_new_tokens)
        if max_new_tokens < 1 or max_new_tokens > 2048:
            raise HTTPException(status_code=400, detail="max_new_tokens must be between 1 and 2048")

        import torch
        from PIL import Image

        processor, model, device = await _get_gemma_vision()

        async def event_stream():
            # Initial metadata
            yield json.dumps(
                {
                    "type": "meta",
                    "count": len(files),
                    "model": "google/gemma-3-4b-it",
                    "max_new_tokens": max_new_tokens,
                }
            ) + "\n"

            for idx, upload in enumerate(files):
                filename = getattr(upload, "filename", None)
                yield json.dumps(
                    {
                        "type": "progress",
                        "index": idx,
                        "filename": filename,
                        "status": "started",
                    }
                ) + "\n"

                try:
                    contents = await upload.read()
                    if not contents:
                        raise HTTPException(status_code=400, detail=f"Empty image upload: {filename}")

                    image = Image.open(BytesIO(contents)).convert("RGB")

                    messages = [
                        {
                            "role": "system",
                            "content": [{"type": "text", "text": "You are a helpful assistant."}],
                        },
                        {
                            "role": "user",
                            "content": [
                                {"type": "image", "image": image},
                                {"type": "text", "text": prompt},
                            ],
                        },
                    ]

                    inputs = processor.apply_chat_template(
                        messages,
                        add_generation_prompt=True,
                        tokenize=True,
                        return_dict=True,
                        return_tensors="pt",
                    )

                    if device == "cuda":
                        inputs = inputs.to("cuda", dtype=torch.bfloat16)
                    else:
                        inputs = inputs.to("cpu")

                    input_len = inputs["input_ids"].shape[-1]

                    with torch.inference_mode():
                        generation = model.generate(**inputs, max_new_tokens=max_new_tokens, do_sample=False)
                        generation = generation[0][input_len:]

                    description = processor.decode(generation, skip_special_tokens=True)

                    yield json.dumps(
                        {
                            "type": "result",
                            "index": idx,
                            "filename": filename,
                            "response": description,
                        }
                    ) + "\n"

                except HTTPException as he:
                    yield json.dumps(
                        {
                            "type": "result",
                            "index": idx,
                            "filename": filename,
                            "error": str(he.detail),
                        }
                    ) + "\n"
                except Exception as e:
                    logger.exception("Failed to describe one image in batch stream")
                    yield json.dumps(
                        {
                            "type": "result",
                            "index": idx,
                            "filename": filename,
                            "error": str(e),
                        }
                    ) + "\n"

            yield json.dumps({"type": "done"}) + "\n"

        return StreamingResponse(event_stream(), media_type="application/json")

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Failed to stream image batch")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/describeimagestream")
async def describe_image_stream(
    file: UploadFile = File(...),
    prompt: str = Form("Describe this image."),
    max_new_tokens: int = Form(512),
):
    """Upload an image and stream Gemma 3 (multimodal) output tokens."""

    if file is None:
        raise HTTPException(status_code=400, detail="No image uploaded")

    contents = await file.read()
    if not contents:
        raise HTTPException(status_code=400, detail="Empty image upload")

    max_new_tokens = int(max_new_tokens)
    if max_new_tokens < 1 or max_new_tokens > 2048:
        raise HTTPException(status_code=400, detail="max_new_tokens must be between 1 and 2048")

    try:
        import torch
        from PIL import Image
        from transformers import TextIteratorStreamer

        image = Image.open(BytesIO(contents)).convert("RGB")
        processor, model, device = await _get_gemma_vision()

        messages = [
            {
                "role": "system",
                "content": [{"type": "text", "text": "You are a helpful assistant."}],
            },
            {
                "role": "user",
                "content": [
                    {"type": "image", "image": image},
                    {"type": "text", "text": prompt},
                ],
            },
        ]

        inputs = processor.apply_chat_template(
            messages,
            add_generation_prompt=True,
            tokenize=True,
            return_dict=True,
            return_tensors="pt",
        )

        if device == "cuda":
            inputs = inputs.to(model.device, dtype=torch.bfloat16)
        else:
            inputs = inputs.to(model.device)

        streamer = TextIteratorStreamer(
            processor.tokenizer,
            skip_prompt=True,
            skip_special_tokens=True,
        )

        generation_error = None

        def _run_generation():
            nonlocal generation_error
            try:
                with torch.inference_mode():
                    model.generate(
                        **inputs,
                        max_new_tokens=max_new_tokens,
                        do_sample=False,
                        streamer=streamer,
                    )
            except Exception as e:
                generation_error = str(e)
                logger.error(f"Gemma vision generation error: {e}")
            finally:
                # Ensure the streamer terminates so the HTTP response can close.
                try:
                    if hasattr(streamer, "end"):
                        streamer.end()
                except Exception:
                    pass

        threading.Thread(target=_run_generation, daemon=True).start()

        async def token_generator():
            iterator = iter(streamer)
            try:
                while True:
                    try:
                        chunk = await asyncio.to_thread(next, iterator)
                    except StopIteration:
                        break

                    if chunk:
                        yield json.dumps({"response": chunk}) + "\n"

            except asyncio.CancelledError:
                logging.info("Image streaming cancelled")
                return

            # If generation failed, emit an error record at the end.
            if generation_error:
                yield json.dumps({"error": generation_error}) + "\n"

        return StreamingResponse(token_generator(), media_type="application/json")

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Failed to stream image description")
        raise HTTPException(status_code=500, detail=str(e))
