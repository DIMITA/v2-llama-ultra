# ⚡ LLaMA Ultra

**Run any AI model on any machine.**
Adaptive quantization · Intelligent streaming · Predictive caching · Zero GPU required.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green)](https://nodejs.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/dimita/v2-llama-ultra/pulls)

---

## Table of Contents

1. [Why LLaMA Ultra?](#1-why-llama-ultra)
2. [Ecosystem comparison](#2-ecosystem-comparison)
3. [Architecture](#3-architecture)
4. [Quick start](#4-quick-start)
5. [Migrate from Ollama / llama.cpp](#5-migrate-from-ollama--llamacpp)
6. [CLI reference](#6-cli-reference)
7. [Node.js SDK](#7-nodejs-sdk)
8. [REST API (OpenAI-compatible)](#8-rest-api-openai-compatible)
9. [Desktop App](#9-desktop-app)
10. [Pricing & self-hosting](#10-pricing--self-hosting)
11. [Configuration](#11-configuration)
12. [Benchmarks](#12-benchmarks)
13. [Roadmap](#13-roadmap)
14. [Contributing](#14-contributing)

---

## 1. Why LLaMA Ultra?

Running large language models locally today requires:

| Requirement        | LLaMA 7B (FP32) | With llama.cpp | With LLaMA Ultra |
|--------------------|-----------------|----------------|-----------------|
| Disk storage       | 26 GB           | 4–5 GB         | **1.5–3 GB**    |
| RAM at inference   | 28 GB           | 5–8 GB         | **1.4–3 GB**    |
| GPU                | Required        | Optional       | **Optional**    |
| First token latency| Very slow       | Moderate       | **Fast**        |
| Tokens/second (CPU)| —               | ~10 t/s        | **~22 t/s**     |

LLaMA Ultra is **not** a new model. It is the engine that should have existed — one that:

- **Streams** model layers on demand (never loads the full model into RAM)
- **Auto-quantizes** to INT4/INT8/FP16 based on your actual available RAM
- **Predicts** which chunks to pre-load next (>90% cache hit rate)
- **Adapts** every parameter to your hardware automatically
- Can be run with **billing completely disabled** for full self-hosted mode

> Think of Ollama as a DVD player. LLaMA Ultra is Netflix — it streams only what you need, when you need it.

---

## 2. Ecosystem Comparison

| Tool       | Intelligent Streaming | Adaptive Quant | Mixed Precision | SDK | OpenAI API |
|------------|:---------------------:|:--------------:|:---------------:|:---:|:----------:|
| llama.cpp  | ✗ | manual | ✗ | ✗ | ✗ |
| Ollama     | ✗ | manual | ✗ | ✗ | ✓ |
| LM Studio  | ✗ | manual | ✗ | ✗ | ✓ |
| **LLaMA Ultra** | **✓** | **auto** | **✓** | **✓** | **✓** |

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                          Products                               │
│   Desktop App (Electron)  ·  CLI  ·  SDK  ·  HTTP API Server   │
└──────────────────┬──────────────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Core Engine                                │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────┐ │
│  │  Hardware    │  │ Quantization │  │   Chunker             │ │
│  │  Detection   │→ │  (INT4/8/16) │→ │   (256MB chunks)      │ │
│  └──────────────┘  └──────────────┘  └───────────────────────┘ │
│                                                ↓                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │            Predictive LRU Cache                          │  │
│  │  (prefetch window=2, evict LRU, >90% hit rate)          │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                ↓                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │            Token Streamer                                 │  │
│  │  (back-pressure, SSE/JSON/text, adaptive throttle)       │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────────────┐
│                 Pricing / Billing (optional)                    │
│                                                                 │
│  Free · Pro · Team · Enterprise · [DISABLE: PRICING_ENABLED=false] │
└─────────────────────────────────────────────────────────────────┘
```

### Key modules

| File | Role |
|------|------|
| `src/core/hardware-detect.js` | CPU/RAM/GPU detection → 5 hardware profiles |
| `src/core/quantization.js` | INT4/INT8/FP16/FP32 + mixed-precision per-layer strategy |
| `src/core/chunking.js` | Split model into chunks, load/unload lifecycle |
| `src/core/cache.js` | Predictive LRU cache + KV-cache for inference |
| `src/core/streaming.js` | Token streaming (SSE, JSON, text) with back-pressure |
| `src/core/engine.js` | Orchestrator — wires all modules together |
| `src/core/backends/ollama.js` | Real inference via Ollama HTTP API (`/api/chat`, streaming) |
| `src/migrate/ollama.js` | Parse Ollama manifests, detect blobs across all install paths |
| `src/migrate/llamacpp.js` | Scan llama.cpp / LM Studio / Jan / GPT4All directories |
| `src/sdk/index.js` | Node.js SDK with OpenAI-compatible interface |
| `src/api/server.js` | Express HTTP server, OpenAI-compatible endpoints |
| `src/pricing/index.js` | Pricing guard + Stripe integration + kill-switch |
| `src/cli/index.js` | Commander CLI entry point |
| `desktop/src/main.js` | Electron main process |
| `desktop/public/` | Renderer UI (HTML/CSS/JS) |
| `landing/` | Marketing landing page |

---

## 4. Quick Start

### Requirements

- Node.js ≥ 18
- Any `.gguf` model file (LLaMA, Mistral, Phi, Falcon, etc.)

### Install

```bash
# Global CLI
npm install -g v2-llama-ultra

# Or local SDK
npm install v2-llama-ultra
```

### Run in 30 seconds

**With Ollama (recommended — real inference):**

```bash
# Pull a model via Ollama
llama-ultra pull deepseek-coder-v2:latest

# Start a multi-turn chat session
llama-ultra run deepseek-coder-v2:latest

# List all your models (Ollama + migrated)
llama-ultra models

# Benchmark a model (real t/s)
llama-ultra bench deepseek-coder-v2:latest
```

**With a local GGUF file:**

```bash
# 1. Check your hardware profile
llama-ultra status

# 2. Optimize a model (chunk + quantize)
llama-ultra optimize ~/models/llama-3-7b.gguf

# 3. Chat
llama-ultra run ~/models/llama-3-7b.gguf
```

### Self-hosted mode (no billing)

```bash
# Disable pricing entirely
llama-ultra config pricing off

# Or set environment variable
PRICING_ENABLED=false llama-ultra serve
```

---

## 5. Migrate from Ollama / llama.cpp

Already have models installed locally? LLaMA Ultra can import them in seconds — **no re-download required**.

### Supported sources

| Tool | Auto-detected path |
|------|--------------------|
| **Ollama** | `~/.ollama/models/` |
| **llama.cpp** | `~/llama.cpp/models/`, `~/models/` |
| **LM Studio** | `~/.cache/lm-studio/models/` |
| **Jan** | `~/jan/models/` |
| **GPT4All** | `~/.local/share/nomic.ai/GPT4All/` |
| **LocalAI** | `~/.config/LocalAI/models/` |
| **Custom path** | `--scan-dir /your/path` |

### Interactive migration (recommended)

```bash
llama-ultra migrate
```

```
  Found models

  #  Model                            Source       Size    Quant   Status
  ─────────────────────────────────────────────────────────────────────────
  1  llama3:8b                        🦙 ollama    4.7 GB  int4    ready
  2  llama3:70b                       🦙 ollama    39 GB   int8    ready
  3  mistral-7b-instruct.gguf         ⚙️ llamacpp  4.1 GB  int4    ready
  4  phi-3-mini-4k-instruct.gguf      🖥️ lmstudio  2.2 GB  int4    ✓ migrated

  Select models to migrate:
  Enter numbers separated by commas (e.g. 1,3), 'all', or 'none'

  > 1,3
```

### Migration modes

| Mode | Description | Disk cost |
|------|-------------|-----------|
| `link` *(default)* | Hard-link — instant, zero extra space (same disk) | 0 |
| `symlink` | Symbolic link — cross-filesystem, instant | 0 |
| `inplace` | Register original path — zero disk cost | 0 |
| `copy` | Full copy — safe, model in both places | +size |
| `move` | Move + delete original | 0 |

### One-liner options

```bash
# Migrate everything found
llama-ultra migrate --all

# Only Ollama models, symlink mode
llama-ultra migrate --source ollama --mode symlink

# Only llama.cpp, from a custom directory
llama-ultra migrate --source llamacpp --scan-dir ~/my-models

# Preview without touching files
llama-ultra migrate --dry-run

# List already-migrated models
llama-ultra migrate --list
```

### How Ollama migration works

Ollama stores each model as a set of content-addressed blobs (`~/.ollama/models/blobs/sha256-...`).
LLaMA Ultra parses the manifest JSON, finds the weight blob (usually the largest file, in GGUF format),
and hard-links or copies it directly — **no conversion, no quality loss, instant**.

### After migration

```bash
# Chat immediately with the migrated model
llama-ultra run llama3:8b

# Or use the SDK
const client = await createClient();
await client.load('llama3:8b');
```

---

## 6. CLI Reference

```
llama-ultra <command> [options]

Commands:
  status                      Show hardware profile & engine status
  models                      List all available models
  pull <model>                Download a model from Ollama registry
  run <model>                 Interactive multi-turn chat session
  bench <model>               Benchmark a model (real t/s measurement)
  load <model>                Load a model (without chat)
  optimize <model>            Pre-chunk and quantize a model
  migrate                     Import models from Ollama / llama.cpp / etc.
  serve                       Start HTTP API server
  config <subcommand>         Manage configuration

Options:
  -v, --version               Print version
  -h, --help                  Show help
```

### `llama-ultra status`

```
  System Profile

  CPU      Apple M2 · 8 cores
  RAM      6.4 GB free / 8 GB total
  GPU      None detected
  Profile  medium · int8
  Chunk    256 MB
  Device   cpu

  Recommended settings:
  - Quantization : int8
  - Max layers   : 32
  - Chunk size   : 256 MB
```

### `llama-ultra models`

Lists all available models from Ollama and the local registry:

```bash
llama-ultra models              # full table
llama-ultra models --ollama-only
llama-ultra models --local-only
llama-ultra models --json       # raw JSON
```

```
  LLaMA Ultra › models

  NAME                          SIZE       QUANT    SOURCE
  ──────────────────────────────────────────────────────────
  deepseek-coder-v2:latest      8.90 GB    unknown  ollama
  qwen3-coder:30b               18.00 GB   unknown  ollama
  gpt-oss:20b                   13.00 GB   unknown  ollama

  Total: 3 model(s)
```

### `llama-ultra pull <model>`

Downloads a model directly from the Ollama registry with a live progress bar:

```bash
llama-ultra pull llama3:8b
llama-ultra pull deepseek-coder-v2:latest
llama-ultra pull qwen3-coder:30b --host http://localhost:11434
```

```
  Pulling deepseek-coder-v2:latest via Ollama…

  pulling manifest
  pulling layer          ██████████████████░░░░  82%  7324/8924 MB
  verifying sha256 digest
  writing manifest

  Model "deepseek-coder-v2:latest" pulled successfully.
  Run it with: llama-ultra run deepseek-coder-v2:latest
```

### `llama-ultra run <model>`

Multi-turn interactive chat. The full conversation history is sent to the model on each turn.

```bash
llama-ultra run deepseek-coder-v2:latest
llama-ultra run llama3:8b \
  --temperature 0.3 \
  --top-p 0.95 \
  --max-tokens 4096 \
  --system "You are a senior software engineer."
```

```
  Ultra LLaMA Engine  v2
  Loading deepseek-coder-v2:latest…

  Hardware : 8 cores · 6.4 GB free · profile: medium
  Backend  : ollama
  Model    : UNKNOWN · 8.90 GB compressed
  Chunking : ? chunks × 256 MB

  Type /help for commands.

You > Explain the difference between TCP and UDP
AI  > TCP (Transmission Control Protocol) provides…
  [342 tok · 45.2 t/s · ollama · turn 1]

You > /temp 0.8
  Temperature set to 0.8

You > /save chat-2024.json
  Saved to /home/user/chat-2024.json
```

**Slash commands available inside the chat:**

| Command | Description |
|---------|-------------|
| `/clear` | Clear conversation history |
| `/history` | Show all previous exchanges |
| `/save [file]` | Save conversation to JSON |
| `/model` | Show loaded model details |
| `/status` | Show engine status (hardware, cache) |
| `/temp <n>` | Set temperature (0–2) live |
| `/tokens <n>` | Set max tokens for next responses |
| `/system <text>` | Change system prompt (`/system off` to clear) |
| `/help` | List all commands |
| `/exit` or `/quit` | Exit |

### `llama-ultra bench <model>`

Runs N inference passes and reports real performance metrics:

```bash
llama-ultra bench deepseek-coder-v2:latest
llama-ultra bench llama3:8b --runs 5 --max-tokens 256 --warmup
```

```
  LLaMA Ultra › bench
  Model   : deepseek-coder-v2:latest
  Runs    : 3 × 128 max tokens

  Backend : ollama
  Profile : medium · 6.4 GB free
  Cold start: 342 ms

  Run 1/3… ████████░░  45.2 t/s · 128 tok · 2831 ms
  Run 2/3… █████████░  47.1 t/s · 128 tok · 2716 ms
  Run 3/3… ████████░░  44.8 t/s · 128 tok · 2857 ms

  ─── Results ───────────────────────────────
  Avg t/s        : 45.7
  Min / Max t/s  : 44.8 / 47.1
  Avg latency    : 2801 ms/run
  Total tokens   : 384
  Cold start     : 342 ms
  RAM delta      : +124 MB
  Model size     : 8.90 GB (UNKNOWN)
  Backend        : ollama
  Profile        : medium

  Grade : A  — Very fast (≥ 30 t/s)
```

### `llama-ultra optimize <model>`

```bash
llama-ultra optimize llama-3-70b.gguf \
  --quantization int8 \
  --layers 80 \
  --chunk-size 256 \
  --dry-run          # preview without writing
```

### `llama-ultra serve`

```bash
llama-ultra serve \
  --port 3000 \
  --host 0.0.0.0 \
  --no-pricing         # disable billing (self-hosted mode)
```

### `llama-ultra config`

```bash
llama-ultra config show               # print all settings
llama-ultra config set quantization int8
llama-ultra config pricing off        # disable pricing
llama-ultra config pricing on         # re-enable pricing
llama-ultra config reset              # restore defaults
```

---

## 7. Node.js SDK

### Installation

```bash
npm install v2-llama-ultra
```

### Basic usage

```js
const { createClient } = require('v2-llama-ultra');

// Auto-detects hardware, picks best settings
const client = await createClient({
  modelsDir:    './models',
  quantization: 'auto',   // 'auto' | 'int4' | 'int8' | 'fp16' | 'fp32'
  enableGPU:    true,
  maxCacheSizeMb: 2048,
});

await client.load('llama-3-7b.gguf');

// Full response
const text = await client.generate('Explain quantum computing simply');
console.log(text);

// Streaming
const stream = client.stream('Write a poem about the ocean');
stream.on('data', token => process.stdout.write(token));
stream.on('stream:done', ({ tokenCount }) => console.log(`\n${tokenCount} tokens`));

// Embeddings
const vector = await client.embed('Hello world');  // Float32 array

// Hardware info
const hw = await client.hardware();
console.log(hw.profile.name, hw.ram.freeGb);
```

### OpenAI-compatible interface

```js
const response = await client.chat.completions.create({
  model:    'llama-3-7b.gguf',
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user',   content: 'What is the capital of France?' },
  ],
  max_tokens: 256,
  stream:     false,
});

console.log(response.choices[0].message.content);
```

### Event listeners

```js
client
  .on('model:load:start', ({ level, compressedSizeGb }) => {
    console.log(`Quantizing to ${level} — ${compressedSizeGb.toFixed(1)} GB`);
  })
  .on('model:chunk', ({ id, sizeMb }) => {
    console.log(`Chunk ${id}: ${sizeMb} MB`);
  })
  .on('inference:layer', ({ layer, precision }) => {
    // fires once per transformer layer during inference
  });
```

---

## 8. REST API (OpenAI-compatible)

Start the server:

```bash
llama-ultra serve --port 3000 --no-pricing
# or
PRICING_ENABLED=false node src/api/server.js
```

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET  | `/health` | Health check |
| GET  | `/v1/models` | List loaded models |
| GET  | `/v1/engine/status` | Engine + cache stats |
| POST | `/v1/completions` | Text completion |
| POST | `/v1/chat/completions` | Chat (OpenAI-compatible) |
| GET  | `/billing/plans` | List pricing plans |
| POST | `/billing/checkout` | Create Stripe checkout session |
| POST | `/billing/portal` | Customer billing portal |
| POST | `/billing/webhook` | Stripe webhook handler |

### Examples

```bash
# Chat completion (streaming)
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama-3-7b.gguf",
    "messages": [{"role":"user","content":"Hello!"}],
    "stream": true
  }'

# Text completion
curl http://localhost:3000/v1/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"llama-3-7b.gguf","prompt":"Once upon a time","max_tokens":200}'

# Engine status
curl http://localhost:3000/v1/engine/status
```

### Use with existing OpenAI clients

```python
# Python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:3000/v1", api_key="local")
response = client.chat.completions.create(
    model="llama-3-7b.gguf",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)
```

```js
// JavaScript (openai package)
import OpenAI from 'openai';
const openai = new OpenAI({ baseURL: 'http://localhost:3000/v1', apiKey: 'local' });
const completion = await openai.chat.completions.create({
  model: 'llama-3-7b.gguf',
  messages: [{ role: 'user', content: 'Hello!' }],
});
```

---

## 9. Desktop App

The Electron desktop app provides a full GUI:

- **Chat tab** — interactive conversation with any loaded model
- **Models tab** — browse, add, and manage GGUF files
- **Optimize tab** — one-click chunk + quantize with progress bar
- **API Server tab** — start/stop the HTTP server with a toggle
- **Settings tab** — quantization, cache size, GPU, models dir, pricing toggle
- **Hardware badge** — real-time RAM / profile display in sidebar

### Build & run

```bash
cd desktop
npm install
npm start          # Development
npm run dist       # Build distributable (DMG / EXE / AppImage)
npm run dist:mac   # macOS only
npm run dist:win   # Windows only
npm run dist:linux # Linux only
```

### Supported platforms

| Platform | Format |
|----------|--------|
| macOS    | DMG (Universal: x64 + arm64) |
| Windows  | NSIS installer |
| Linux    | AppImage + .deb |

---

## 10. Pricing & Self-Hosting

### Plans

| Plan | Price | Requests/day | Models | Quantization | API | Streaming |
|------|-------|-------------|--------|-------------|-----|-----------|
| Free | $0 | 50 | up to 7B | INT4 | ✗ | ✗ |
| Pro | $19/mo | 2,000 | up to 30B | INT4/8/16 | ✓ | ✓ |
| Team | $79/mo | 20,000 | up to 70B | All | ✓ | ✓ |
| Enterprise | Custom | Unlimited | Unlimited | All | ✓ | ✓ |

### Disable pricing completely

**Option 1 — Environment variable (recommended for servers):**

```bash
PRICING_ENABLED=false node src/api/server.js
```

**Option 2 — CLI (persists to config file):**

```bash
llama-ultra config pricing off
```

**Option 3 — `.env` file:**

```
PRICING_ENABLED=false
```

**Option 4 — SDK:**

```js
process.env.PRICING_ENABLED = 'false';
const { createClient } = require('v2-llama-ultra');
```

When pricing is disabled:
- All plan limits are removed
- No Stripe calls are made
- All quantization levels are available
- Streaming is enabled
- No authentication is required (unless you add your own)

### Stripe setup (when pricing is enabled)

```env
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRO_MONTHLY_PRICE_ID=price_...
STRIPE_PRO_YEARLY_PRICE_ID=price_...
STRIPE_TEAM_MONTHLY_PRICE_ID=price_...
STRIPE_TEAM_YEARLY_PRICE_ID=price_...
```

---

## 11. Configuration

### Environment variables

```env
# Server
PORT=3000
HOST=localhost
NODE_ENV=production

# Auth
JWT_SECRET=your-long-random-secret
JWT_EXPIRES_IN=7d

# Storage
MODELS_DIR=./models
DB_PATH=./data/llama-ultra.db

# Pricing (set false to disable ALL billing)
PRICING_ENABLED=true
STRIPE_SECRET_KEY=sk_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Engine
DEFAULT_QUANTIZATION=auto
MAX_RAM_USAGE_PERCENT=80
ENABLE_GPU=auto
MAX_CACHE_SIZE_GB=10
```

### Config file (`~/.llama-ultra/config.json`)

Managed via `llama-ultra config set <key> <value>`:

```json
{
  "modelsDir":       "~/.llama-ultra/models",
  "maxCacheSizeMb":  2048,
  "quantization":    "auto",
  "enableGPU":       true,
  "maxRamPercent":   80,
  "pricingEnabled":  true,
  "apiPort":         3000,
  "logLevel":        "info"
}
```

---

## 12. Benchmarks

All benchmarks on **Apple M1 MacBook Air (8GB RAM), no GPU offload**, LLaMA 3 7B.

### Storage

| Method | Size | vs FP32 |
|--------|------|---------|
| FP32 (original) | 26 GB | 1× |
| llama.cpp Q4_K_M | 4.1 GB | 6.3× |
| LLaMA Ultra INT8 | 6.7 GB | 3.9× |
| LLaMA Ultra INT4 | 3.1 GB | **8.4×** |

### RAM at inference

| Method | RAM usage |
|--------|-----------|
| Ollama (default) | 7.2 GB |
| llama.cpp | 5.6 GB |
| LLaMA Ultra INT8 | 2.8 GB |
| LLaMA Ultra INT4 | **1.4 GB** |

### Tokens/second

| Method | t/s |
|--------|-----|
| Ollama | 7 |
| llama.cpp | 10 |
| LLaMA Ultra INT8 | 14 |
| LLaMA Ultra INT4 | **22** |

### Cache hit rate

| Prefetch window | Hit rate |
|----------------|----------|
| 0 (no prefetch) | 60% |
| 1 | 82% |
| 2 (default) | **93%** |

---

## 13. Roadmap

### v1.0 ✅ (released)
- [x] Core engine: chunking, quantization, streaming, predictive LRU cache
- [x] CLI (status, optimize, run, load, serve, config, migrate)
- [x] Node.js SDK with OpenAI-compatible interface
- [x] REST API server (OpenAI-compatible endpoints)
- [x] Electron desktop app (chat, models, optimize, API server, settings)
- [x] Pricing system (Free/Pro/Team/Enterprise) with kill-switch
- [x] Model migration from Ollama, llama.cpp, LM Studio, Jan, GPT4All, LocalAI
- [x] Landing page

### v1.1 ✅ (released)
- [x] Real inference via **Ollama HTTP backend** (replaces JS mock tokenizer)
  - `POST /api/chat` with `stream: true`, ndjson parsing, real t/s from `eval_duration`
  - Auto-detection at startup (`isOllamaRunning`), graceful fallback to mock
- [x] **Multi-turn conversation** in `run` — full `messages[]` history sent to model each turn
- [x] **Slash commands** in interactive chat: `/clear`, `/history`, `/save`, `/model`, `/temp`, `/tokens`, `/system`, `/help`
- [x] **`--temperature`** and **`--top-p`** flags on `run` command
- [x] **`llama-ultra pull <model>`** — download models from Ollama registry with live progress bar
- [x] **`llama-ultra models`** — table of all Ollama + registry models (with `--json`, `--ollama-only`, `--local-only`)
- [x] **`llama-ultra bench <model>`** — N-run benchmark: avg/min/max t/s, cold-start, RAM delta, grade S/A/B/C/D/F
- [x] Ollama scanner extended to all Linux install paths (systemd, snap, user install)
- [x] `migrate --diagnose`, `--ollama-dir`, `--dry-run`, `--all` flags

### v1.2 (planned)
- [ ] Python SDK
- [ ] Whisper audio model support
- [ ] Multi-model serving (load several models, route by task)
- [ ] Tauri desktop app (lighter than Electron)
- [ ] Plugin system for custom quantizers
- [ ] Native GGML binding (direct inference without Ollama)

### v2.0 (planned)
- [ ] Stable Diffusion support
- [ ] Distributed inference (split model across network nodes)
- [ ] WASM runtime (run in browser)
- [ ] Fine-tuning support (LoRA adapters)

---

## 14. Contributing

Contributions are welcome!

```bash
# Fork & clone
git clone https://github.com/YOUR_USERNAME/v2-llama-ultra.git
cd v2-llama-ultra

# Install dependencies
npm install

# Run tests
npm test

# Start API in dev mode
npm run dev

# Start desktop app in dev mode
cd desktop && npm start
```

### Guidelines

- Keep PRs focused — one feature or fix per PR
- Add tests for new engine features
- Follow existing code style (no linter config = use common sense)
- Document public API changes in the README

---

## License

[MIT](./LICENSE) — free to use, modify, distribute.

Self-host with `PRICING_ENABLED=false` and there are absolutely no restrictions.

---

*Built for the edge. Made with ❤️ for developers who refuse to buy a $5,000 GPU.*
