"""
LLaMA Ultra Python SDK — synchronous and async clients.
Wraps the LLaMA Ultra REST API (OpenAI-compatible).
"""

import json
import httpx
from typing import Iterator, AsyncIterator, List, Optional, Dict, Any, Union

from .models import ChatMessage, ChatResponse, ModelInfo, EngineStatus

DEFAULT_BASE_URL = "http://localhost:3000"
DEFAULT_TIMEOUT  = 120.0


# ─── Synchronous client ───────────────────────────────────────────────────────

class LlamaUltraClient:
    """
    Synchronous Python client for LLaMA Ultra.

    Args:
        base_url: Base URL of the running LLaMA Ultra server.
        api_key:  Optional API key (if auth is enabled on the server).
        timeout:  Request timeout in seconds (default: 120).

    Example::

        from llama_ultra import LlamaUltraClient

        client = LlamaUltraClient("http://localhost:3000")

        # One-shot generation
        print(client.generate("llama3:8b", "Hello!"))

        # Streaming
        for token in client.stream("llama3:8b", "Tell me a joke"):
            print(token, end="", flush=True)

        # OpenAI-compatible
        resp = client.chat.completions.create(
            model="llama3:8b",
            messages=[{"role": "user", "content": "Hi"}],
        )
        print(resp.choices[0].message.content)
    """

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        api_key: Optional[str] = None,
        timeout: float = DEFAULT_TIMEOUT,
    ):
        self.base_url = base_url.rstrip("/")
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        self._http = httpx.Client(
            base_url=self.base_url,
            headers=headers,
            timeout=timeout,
        )
        self.chat = ChatCompletions(self)

    # ─── Health / status ──────────────────────────────────────────────────

    def health(self) -> dict:
        """Check if the server is running."""
        return self._get("/health")

    def status(self) -> EngineStatus:
        """Return engine status: hardware, loaded models, cache stats."""
        return EngineStatus.from_dict(self._get("/v1/engine/status"))

    # ─── Models ───────────────────────────────────────────────────────────

    def models(self) -> List[ModelInfo]:
        """List all models known to the server."""
        data = self._get("/v1/models")
        return [ModelInfo.from_dict(m) for m in data.get("data", [])]

    def load(self, model: str, quantization: str = "auto") -> dict:
        """Load a model on the server (if not already loaded)."""
        return self._post("/v1/models/load", {"model": model, "quantization": quantization})

    def unload(self, model: str) -> dict:
        """Unload a model from server memory."""
        return self._post("/v1/models/unload", {"model": model})

    # ─── Inference ────────────────────────────────────────────────────────

    def generate(
        self,
        model: str,
        prompt: str,
        *,
        max_tokens: int = 1024,
        temperature: float = 0.7,
        top_p: float = 0.9,
        system: Optional[str] = None,
    ) -> str:
        """
        Generate a completion and return the full text.

        Args:
            model:       Model name (e.g. 'llama3:8b', 'deepseek-coder-v2:latest')
            prompt:      User prompt
            max_tokens:  Maximum tokens to generate
            temperature: Sampling temperature (0–2)
            top_p:       Nucleus sampling threshold (0–1)
            system:      Optional system prompt

        Returns:
            Generated text as a string.
        """
        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})

        resp = self._post("/v1/chat/completions", {
            "model":       model,
            "messages":    messages,
            "max_tokens":  max_tokens,
            "temperature": temperature,
            "top_p":       top_p,
            "stream":      False,
        })
        return ChatResponse.from_dict(resp).choices[0].message.content

    def stream(
        self,
        model: str,
        prompt: str,
        *,
        max_tokens: int = 1024,
        temperature: float = 0.7,
        top_p: float = 0.9,
        system: Optional[str] = None,
        messages: Optional[List[Dict]] = None,
    ) -> Iterator[str]:
        """
        Stream tokens as they are generated.

        Yields:
            String tokens as they arrive.

        Example::

            for token in client.stream("llama3:8b", "Write a haiku"):
                print(token, end="", flush=True)
        """
        msgs = list(messages) if messages else []
        if not messages:
            if system:
                msgs.append({"role": "system", "content": system})
            msgs.append({"role": "user", "content": prompt})

        with self._http.stream("POST", "/v1/chat/completions", json={
            "model":       model,
            "messages":    msgs,
            "max_tokens":  max_tokens,
            "temperature": temperature,
            "top_p":       top_p,
            "stream":      True,
        }) as resp:
            resp.raise_for_status()
            for line in resp.iter_lines():
                line = line.strip()
                if not line or line == "data: [DONE]":
                    continue
                if line.startswith("data: "):
                    line = line[6:]
                try:
                    chunk = json.loads(line)
                    delta = chunk.get("choices", [{}])[0].get("delta", {})
                    token = delta.get("content", "")
                    if token:
                        yield token
                except (json.JSONDecodeError, IndexError, KeyError):
                    continue

    def embed(self, model: str, text: str) -> List[float]:
        """
        Generate an embedding vector for the given text.

        Returns:
            List of floats (embedding vector).
        """
        resp = self._post("/v1/embeddings", {"model": model, "input": text})
        return resp.get("data", [{}])[0].get("embedding", [])

    # ─── Internal HTTP helpers ────────────────────────────────────────────

    def _get(self, path: str) -> dict:
        resp = self._http.get(path)
        resp.raise_for_status()
        return resp.json()

    def _post(self, path: str, body: dict) -> dict:
        resp = self._http.post(path, json=body)
        resp.raise_for_status()
        return resp.json()

    def close(self):
        self._http.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


# ─── OpenAI-compatible namespace ─────────────────────────────────────────────

class ChatCompletions:
    """client.chat.completions — mirrors the OpenAI Python SDK interface."""

    def __init__(self, client: LlamaUltraClient):
        self._client = client

    def create(
        self,
        *,
        model: str,
        messages: List[Dict],
        max_tokens: int = 1024,
        temperature: float = 0.7,
        top_p: float = 0.9,
        stream: bool = False,
        **kwargs,
    ) -> Union[ChatResponse, Iterator[str]]:
        """
        Create a chat completion (OpenAI-compatible).

        Args:
            model:    Model name
            messages: List of {role, content} dicts
            stream:   If True, returns a token iterator instead of ChatResponse

        Example::

            resp = client.chat.completions.create(
                model="llama3:8b",
                messages=[
                    {"role": "system", "content": "You are helpful."},
                    {"role": "user",   "content": "Hello!"},
                ],
            )
            print(resp.choices[0].message.content)
        """
        if stream:
            return self._client.stream(
                model=model,
                prompt="",
                messages=messages,
                max_tokens=max_tokens,
                temperature=temperature,
                top_p=top_p,
            )

        resp = self._client._post("/v1/chat/completions", {
            "model":       model,
            "messages":    messages,
            "max_tokens":  max_tokens,
            "temperature": temperature,
            "top_p":       top_p,
            "stream":      False,
        })
        return ChatResponse.from_dict(resp)


# ─── Async client ─────────────────────────────────────────────────────────────

class AsyncLlamaUltraClient:
    """
    Async Python client for LLaMA Ultra (uses httpx.AsyncClient).

    Example::

        import asyncio
        from llama_ultra import AsyncLlamaUltraClient

        async def main():
            async with AsyncLlamaUltraClient() as client:
                text = await client.generate("llama3:8b", "Hello!")
                print(text)

                async for token in client.stream("llama3:8b", "Tell me a joke"):
                    print(token, end="", flush=True)

        asyncio.run(main())
    """

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        api_key: Optional[str] = None,
        timeout: float = DEFAULT_TIMEOUT,
    ):
        self.base_url = base_url.rstrip("/")
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        self._http = httpx.AsyncClient(
            base_url=self.base_url,
            headers=headers,
            timeout=timeout,
        )

    async def health(self) -> dict:
        return await self._get("/health")

    async def status(self) -> EngineStatus:
        return EngineStatus.from_dict(await self._get("/v1/engine/status"))

    async def models(self) -> List[ModelInfo]:
        data = await self._get("/v1/models")
        return [ModelInfo.from_dict(m) for m in data.get("data", [])]

    async def generate(
        self,
        model: str,
        prompt: str,
        *,
        max_tokens: int = 1024,
        temperature: float = 0.7,
        top_p: float = 0.9,
        system: Optional[str] = None,
    ) -> str:
        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})

        resp = await self._post("/v1/chat/completions", {
            "model": model, "messages": messages,
            "max_tokens": max_tokens, "temperature": temperature,
            "top_p": top_p, "stream": False,
        })
        return ChatResponse.from_dict(resp).choices[0].message.content

    async def stream(
        self,
        model: str,
        prompt: str,
        *,
        max_tokens: int = 1024,
        temperature: float = 0.7,
        top_p: float = 0.9,
        system: Optional[str] = None,
        messages: Optional[List[Dict]] = None,
    ) -> AsyncIterator[str]:
        msgs = list(messages) if messages else []
        if not messages:
            if system:
                msgs.append({"role": "system", "content": system})
            msgs.append({"role": "user", "content": prompt})

        async with self._http.stream("POST", "/v1/chat/completions", json={
            "model": model, "messages": msgs,
            "max_tokens": max_tokens, "temperature": temperature,
            "top_p": top_p, "stream": True,
        }) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                line = line.strip()
                if not line or line == "data: [DONE]":
                    continue
                if line.startswith("data: "):
                    line = line[6:]
                try:
                    chunk = json.loads(line)
                    delta = chunk.get("choices", [{}])[0].get("delta", {})
                    token = delta.get("content", "")
                    if token:
                        yield token
                except (json.JSONDecodeError, IndexError, KeyError):
                    continue

    async def _get(self, path: str) -> dict:
        resp = await self._http.get(path)
        resp.raise_for_status()
        return resp.json()

    async def _post(self, path: str, body: dict) -> dict:
        resp = await self._http.post(path, json=body)
        resp.raise_for_status()
        return resp.json()

    async def close(self):
        await self._http.aclose()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        await self.close()
