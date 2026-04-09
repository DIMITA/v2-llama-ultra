"""
LLaMA Ultra Python SDK
Run AI models on any machine — adaptive, streaming, ultra-light.

Usage:
    from llama_ultra import LlamaUltraClient

    client = LlamaUltraClient(base_url="http://localhost:3000")

    # Simple generation
    text = client.generate("llama3:8b", "Explain quantum computing")
    print(text)

    # Streaming
    for token in client.stream("llama3:8b", "Write a poem"):
        print(token, end="", flush=True)

    # OpenAI-compatible
    response = client.chat.completions.create(
        model="llama3:8b",
        messages=[{"role": "user", "content": "Hello!"}],
    )
    print(response.choices[0].message.content)
"""

from .client import LlamaUltraClient, ChatCompletions, AsyncLlamaUltraClient
from .models import ChatMessage, ChatResponse, ModelInfo, EngineStatus

__version__ = "1.2.0"
__all__ = [
    "LlamaUltraClient",
    "AsyncLlamaUltraClient",
    "ChatCompletions",
    "ChatMessage",
    "ChatResponse",
    "ModelInfo",
    "EngineStatus",
]
