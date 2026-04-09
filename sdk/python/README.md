# llama-ultra (Python SDK)

Python SDK for **LLaMA Ultra** — run AI models on any machine.

## Install

```bash
pip install llama-ultra
```

Requires a running LLaMA Ultra server:

```bash
llama-ultra serve --port 3000 --no-pricing
```

## Quick Start

```python
from llama_ultra import LlamaUltraClient

client = LlamaUltraClient("http://localhost:3000")

# One-shot generation
text = client.generate("llama3:8b", "Explain quantum computing simply")
print(text)

# Streaming
for token in client.stream("llama3:8b", "Write a haiku about the sea"):
    print(token, end="", flush=True)
print()

# OpenAI-compatible interface
resp = client.chat.completions.create(
    model="llama3:8b",
    messages=[
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user",   "content": "What is the capital of France?"},
    ],
)
print(resp.choices[0].message.content)
```

## Async

```python
import asyncio
from llama_ultra import AsyncLlamaUltraClient

async def main():
    async with AsyncLlamaUltraClient("http://localhost:3000") as client:
        # One-shot
        text = await client.generate("llama3:8b", "Hello!")
        print(text)

        # Streaming
        async for token in client.stream("deepseek-coder-v2:latest", "Write a sort function"):
            print(token, end="", flush=True)

asyncio.run(main())
```

## All methods

### `client.generate(model, prompt, *, max_tokens, temperature, top_p, system)`

Returns the full generated text as a string.

### `client.stream(model, prompt, *, max_tokens, temperature, top_p, system, messages)`

Returns a token iterator. Pass `messages=[...]` for multi-turn conversation.

### `client.chat.completions.create(*, model, messages, max_tokens, temperature, stream)`

OpenAI-compatible. Returns `ChatResponse` or a token iterator when `stream=True`.

### `client.models()`

Returns `List[ModelInfo]` — all models known to the server.

### `client.status()`

Returns `EngineStatus` — hardware info, loaded models, cache stats.

### `client.embed(model, text)`

Returns `List[float]` — embedding vector.

## Use with OpenAI Python package

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3000/v1",
    api_key="local",  # any string, auth is optional
)

response = client.chat.completions.create(
    model="llama3:8b",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(response.choices[0].message.content)
```

## License

MIT
