"""Data models for the LLaMA Ultra Python SDK."""

from dataclasses import dataclass, field
from typing import List, Optional, Dict, Any


@dataclass
class ChatMessage:
    role: str      # 'system' | 'user' | 'assistant'
    content: str

    def to_dict(self) -> dict:
        return {"role": self.role, "content": self.content}


@dataclass
class ChatChoice:
    index: int
    message: ChatMessage
    finish_reason: Optional[str] = None

    @classmethod
    def from_dict(cls, d: dict) -> "ChatChoice":
        return cls(
            index=d.get("index", 0),
            message=ChatMessage(
                role=d.get("message", {}).get("role", "assistant"),
                content=d.get("message", {}).get("content", ""),
            ),
            finish_reason=d.get("finish_reason"),
        )


@dataclass
class ChatUsage:
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0

    @classmethod
    def from_dict(cls, d: dict) -> "ChatUsage":
        return cls(
            prompt_tokens=d.get("prompt_tokens", 0),
            completion_tokens=d.get("completion_tokens", 0),
            total_tokens=d.get("total_tokens", 0),
        )


@dataclass
class ChatResponse:
    id: str
    object: str
    created: int
    model: str
    choices: List[ChatChoice]
    usage: Optional[ChatUsage] = None

    @classmethod
    def from_dict(cls, d: dict) -> "ChatResponse":
        return cls(
            id=d.get("id", ""),
            object=d.get("object", "chat.completion"),
            created=d.get("created", 0),
            model=d.get("model", ""),
            choices=[ChatChoice.from_dict(c) for c in d.get("choices", [])],
            usage=ChatUsage.from_dict(d["usage"]) if "usage" in d else None,
        )


@dataclass
class ModelInfo:
    id: str
    name: str
    size_gb: float
    quantization: str
    source: str
    loaded: bool = False

    @classmethod
    def from_dict(cls, d: dict) -> "ModelInfo":
        return cls(
            id=d.get("id", d.get("name", "")),
            name=d.get("name", ""),
            size_gb=d.get("sizeGb", d.get("size_gb", 0)),
            quantization=d.get("quantization", "unknown"),
            source=d.get("source", "unknown"),
            loaded=d.get("loaded", False),
        )


@dataclass
class HardwareInfo:
    profile: str
    cpu_cores: int
    ram_free_gb: float
    ram_total_gb: float
    gpu: Optional[str] = None

    @classmethod
    def from_dict(cls, d: dict) -> "HardwareInfo":
        cpu = d.get("cpu", {})
        ram = d.get("ram", {})
        return cls(
            profile=d.get("profile", {}).get("name", "unknown"),
            cpu_cores=cpu.get("cores", 0),
            ram_free_gb=ram.get("freeGb", 0),
            ram_total_gb=ram.get("totalGb", 0),
            gpu=d.get("gpu", {}).get("name"),
        )


@dataclass
class EngineStatus:
    ready: bool
    hardware: Optional[HardwareInfo]
    loaded_models: List[str]
    cache_hits: int = 0
    cache_misses: int = 0

    @classmethod
    def from_dict(cls, d: dict) -> "EngineStatus":
        hw = HardwareInfo.from_dict(d["hardware"]) if d.get("hardware") else None
        # Support both single loadedModel and loadedModels map
        loaded = []
        if d.get("loadedModels"):
            loaded = list(d["loadedModels"].keys())
        elif d.get("loadedModel"):
            loaded = [d["loadedModel"].get("path", "")]
        cache = d.get("cache", {})
        return cls(
            ready=d.get("ready", False),
            hardware=hw,
            loaded_models=loaded,
            cache_hits=cache.get("hits", 0),
            cache_misses=cache.get("misses", 0),
        )
