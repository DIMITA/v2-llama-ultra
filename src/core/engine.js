'use strict';

/**
 * engine.js
 * Central orchestrator — ties together hardware detection, quantization,
 * chunking, caching and streaming into one unified inference pipeline.
 */

const path = require('path');
const fs   = require('fs');
const { EventEmitter }    = require('events');
const { detectHardware, detectHardwareSync } = require('./hardware-detect');
const { selectQuantizationLevel, mixedPrecisionStrategy, estimateCompressedSizeGb } = require('./quantization');
const { ModelChunker }    = require('./chunking');
const { PredictiveCache, KVCache } = require('./cache');
const { TokenStreamer }   = require('./streaming');
const ollamaBackend       = require('./backends/ollama');

// ─── Engine ───────────────────────────────────────────────────────────────────

class UltraEngine extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string}  opts.modelsDir       - Root directory for model storage
   * @param {number}  opts.maxCacheSizeMb  - RAM budget for chunk cache
   * @param {string}  opts.quantization    - Override auto-detection: 'auto'|'int4'|'int8'|'fp16'|'fp32'
   * @param {boolean} opts.enableGPU       - Use GPU if available (default: auto)
   * @param {number}  opts.maxRamPercent   - Max RAM usage percentage (default: 80)
   */
  constructor({
    modelsDir       = './models',
    maxCacheSizeMb  = 2048,
    quantization    = 'auto',
    enableGPU       = true,
    maxRamPercent   = 80,
  } = {}) {
    super();
    this.modelsDir      = path.resolve(modelsDir);
    this.maxCacheSizeMb = maxCacheSizeMb;
    this.quantization   = quantization;
    this.enableGPU      = enableGPU;
    this.maxRamPercent  = maxRamPercent;

    this.hardware     = null;
    this.cache        = new PredictiveCache({ maxSizeMb: maxCacheSizeMb, prefetchWindow: 2 });
    this.kvCache      = new KVCache();
    /** @type {Map<string, object>} key = nameOrPath used at load time */
    this.loadedModels = new Map();
    this._ready       = false;
  }

  /** Backward-compat: returns the most recently loaded model, or null. */
  get loadedModel() {
    if (this.loadedModels.size === 0) return null;
    return [...this.loadedModels.values()].at(-1);
  }

  // ─── Init ─────────────────────────────────────────────────────────────────

  async init() {
    this.hardware = await detectHardware();

    // Auto-detect available inference backends
    this._ollamaAvailable = await ollamaBackend.isOllamaRunning();
    this._backend = this._ollamaAvailable ? 'ollama' : 'mock';

    this.emit('engine:init', { hardware: this.hardware, backend: this._backend });
    this._ready = true;
    return this;
  }

  initSync() {
    this.hardware = detectHardwareSync();
    this._ollamaAvailable = false;
    this._backend = 'mock';
    this._ready = true;
    return this;
  }

  get backend() { return this._backend; }

  // ─── Load model ───────────────────────────────────────────────────────────

  /**
   * Load a model by name or path.
   * If the model hasn't been chunked yet, chunk it first.
   */
  async loadModel(nameOrPath, opts = {}) {
    this._assertReady();

    const modelPath = this._resolveModel(nameOrPath);
    const stat      = fs.statSync(modelPath);
    const sizeFp32Gb = stat.size / (1024 ** 3);

    // Determine quantization
    const freeRamGb = this.hardware.ram.freeGb;
    const level     = this.quantization === 'auto'
      ? selectQuantizationLevel(freeRamGb, sizeFp32Gb)
      : this.quantization;

    const compressedSizeGb = estimateCompressedSizeGb(sizeFp32Gb, level);
    const numLayers        = opts.numLayers ?? this.hardware.profile.maxLayers;

    this.emit('model:load:start', {
      modelPath, level, sizeFp32Gb: +sizeFp32Gb.toFixed(2),
      compressedSizeGb: +compressedSizeGb.toFixed(2),
    });

    // Chunk the model
    const chunkDir      = path.join(this.modelsDir, '.chunks', path.basename(modelPath));
    const manifestPath  = path.join(chunkDir, 'manifest.json');

    let chunker;
    if (fs.existsSync(manifestPath)) {
      chunker = ModelChunker.fromManifest(manifestPath);
      this.emit('model:load:cached_chunks', { manifestPath });
    } else {
      chunker = new ModelChunker({
        modelPath,
        chunkSizeMb: this.hardware.profile.chunkSizeMb,
        numLayers,
        outDir: chunkDir,
      });
      chunker.on('split:chunk', meta => this.emit('model:chunk', meta));
      await chunker.split();
    }

    // Mixed precision strategy
    const precisionMap = mixedPrecisionStrategy(numLayers, freeRamGb, sizeFp32Gb);

    // Try to find the Ollama model name from the registry entry
    let ollamaName = null;
    try {
      const { ModelRegistry } = require('../migrate/index');
      const reg = new ModelRegistry(this.modelsDir);
      const entry = reg.list().find(m => m.path === modelPath || m.originalPath === modelPath);
      if (entry?.source === 'ollama') ollamaName = entry.fullName;
    } catch (_) {}

    const entry = {
      key:          nameOrPath,
      path:         modelPath,
      ollamaName,
      chunker,
      numLayers,
      quantization: level,
      precisionMap,
      compressedSizeGb,
      loadedAt:     new Date().toISOString(),
    };

    this.loadedModels.set(nameOrPath, entry);
    this.kvCache.reset();
    this.emit('model:load:done', entry);
    return entry;
  }

  /**
   * Resolve a model key to the loaded entry.
   * Accepts the original nameOrPath, or falls back to the last loaded model.
   * @param {string} [nameOrPath]
   * @returns {object}
   */
  _getLoadedModel(nameOrPath) {
    if (nameOrPath && this.loadedModels.has(nameOrPath)) {
      return this.loadedModels.get(nameOrPath);
    }
    // Try matching by ollamaName or path basename
    if (nameOrPath) {
      for (const m of this.loadedModels.values()) {
        if (
          m.ollamaName === nameOrPath ||
          path.basename(m.path) === nameOrPath ||
          path.basename(m.path, '.gguf') === nameOrPath
        ) return m;
      }
    }
    // Fallback to last loaded
    if (this.loadedModels.size > 0) return [...this.loadedModels.values()].at(-1);
    return null;
  }

  // ─── Inference (streaming) ────────────────────────────────────────────────

  /**
   * Run inference and return a TokenStreamer.
   * @param {string|Array} promptOrMessages  Plain string or [{role,content}] array for multi-turn
   * @param {object} opts
   * @param {string}   opts.system       System prompt (prepended when promptOrMessages is a string)
   * @param {number}   opts.maxTokens
   * @param {number}   opts.temperature
   * @param {number}   opts.topP
   * @param {number}   opts.speed        Target t/s (0 = unlimited)
   * @param {string}   opts.format       'text'|'json'|'sse'
   * @param {AbortSignal} opts.signal
   */
  /**
   * @param {string|Array} promptOrMessages
   * @param {object} opts
   * @param {string} [opts.model]  Which loaded model to use (key or name). Defaults to last loaded.
   */
  infer(promptOrMessages, opts = {}) {
    this._assertReady();
    const model = this._getLoadedModel(opts.model);
    if (!model) throw new Error('No model loaded. Call loadModel() first.');

    const streamer = new TokenStreamer({
      format: opts.format ?? 'text',
      tokensPerSecondTarget: opts.speed ?? 0,
    });

    setImmediate(() => this._runInference(promptOrMessages, opts, streamer, model));
    return streamer;
  }

  async _runInference(promptOrMessages, opts, streamer, model) {
    try {
      if (this._backend === 'ollama') {
        await this._runOllama(promptOrMessages, opts, streamer, model);
      } else {
        await this._runMock(promptOrMessages, opts, streamer, model);
      }
    } catch (err) {
      streamer.destroy(err);
      this.emit('inference:error', err);
    }
  }

  // ─── Ollama backend (real inference) ────────────────────────────────────

  async _runOllama(promptOrMessages, opts, streamer, model) {
    const modelName = model.ollamaName ?? model.path;

    // Accept either a plain string or a pre-built messages array
    let messages;
    if (Array.isArray(promptOrMessages)) {
      messages = promptOrMessages;
    } else {
      messages = [
        ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
        { role: 'user', content: promptOrMessages },
      ];
    }

    const { totalTokens, evalDuration } = await ollamaBackend.streamChat({
      model:    modelName,
      messages,
      options:  {
        maxTokens:   opts.maxTokens   ?? 2048,
        temperature: opts.temperature ?? 0.7,
        topP:        opts.topP        ?? 0.9,
      },
      onToken:  token => streamer.write(token),
      signal:   opts.signal,
    });

    const tps = evalDuration > 0
      ? +( totalTokens / (evalDuration / 1e9) ).toFixed(1)
      : 0;

    this.emit('inference:done', { totalTokens, tps, backend: 'ollama' });
    streamer.end();
  }

  // ─── Mock backend (fallback — no Ollama) ────────────────────────────────

  async _runMock(promptOrMessages, opts, streamer, _model) {
    const prompt    = Array.isArray(promptOrMessages)
      ? promptOrMessages.filter(m => m.role === 'user').pop()?.content ?? ''
      : promptOrMessages;
    const maxTokens = opts.maxTokens ?? 512;
    const tokens    = this._mockTokenize(prompt, maxTokens);
    for (const token of tokens) {
      streamer.write(token);
      await _tick();
    }
    this.emit('inference:done', { totalTokens: tokens.length, tps: 0, backend: 'mock' });
    streamer.end();
  }

  // ─── Unload ───────────────────────────────────────────────────────────────

  /**
   * Unload a specific model by key, or all models if no key is given.
   * @param {string} [nameOrPath]
   */
  unload(nameOrPath) {
    if (nameOrPath) {
      const m = this._getLoadedModel(nameOrPath);
      if (m) {
        m.chunker.unloadAll();
        this.loadedModels.delete(m.key);
        this.emit('model:unload', { path: m.path });
      }
    } else {
      for (const m of this.loadedModels.values()) {
        m.chunker.unloadAll();
        this.emit('model:unload', { path: m.path });
      }
      this.loadedModels.clear();
      this.cache.clear();
      this.kvCache.reset();
    }
  }

  /** List all currently loaded models (summary). */
  listLoadedModels() {
    return [...this.loadedModels.values()].map(m => ({
      key:             m.key,
      path:            m.path,
      ollamaName:      m.ollamaName,
      quantization:    m.quantization,
      compressedSizeGb: m.compressedSizeGb,
      loadedAt:        m.loadedAt,
    }));
  }

  // ─── Status ───────────────────────────────────────────────────────────────

  status() {
    const loadedList = this.listLoadedModels();
    return {
      ready:        this._ready,
      hardware:     this.hardware,
      backend:      this._backend,
      loadedModels: Object.fromEntries(
        loadedList.map(m => [m.key, m])
      ),
      // backward-compat: single loadedModel field
      loadedModel:  loadedList.at(-1) ?? null,
      cache:        this.cache.stats,
    };
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  _resolveModel(nameOrPath) {
    // 1. Absolute path given and exists
    if (path.isAbsolute(nameOrPath) && fs.existsSync(nameOrPath)) return nameOrPath;

    // 2. Check migration registry (~/.llama-ultra/models/models.json)
    try {
      const { ModelRegistry } = require('../migrate/index');
      const registry = new ModelRegistry(this.modelsDir);
      const entries  = registry.list();
      // Match by name, fullName, or id (case-insensitive)
      const entry = entries.find(m =>
        m.name     === nameOrPath ||
        m.fullName === nameOrPath ||
        m.id       === nameOrPath ||
        m.name?.toLowerCase()     === nameOrPath.toLowerCase() ||
        m.fullName?.toLowerCase() === nameOrPath.toLowerCase()
      );
      if (entry && fs.existsSync(entry.path)) return entry.path;
    } catch (_) {}

    // 3. Direct filename in modelsDir
    const candidates = [
      path.join(this.modelsDir, nameOrPath),
      path.join(this.modelsDir, nameOrPath + '.gguf'),
      // sanitized: colons → underscores, slashes → underscores
      path.join(this.modelsDir, nameOrPath.replace(/[:/]/g, '_') + '.gguf'),
      path.join(this.modelsDir, nameOrPath.replace(/[:/]/g, '_')),
    ];

    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }

    throw new Error(
      `Model not found: "${nameOrPath}"\n` +
      `  Searched in: ${this.modelsDir}\n` +
      `  Tip: run 'llama-ultra migrate --list' to see available models\n` +
      `  Tip: use the full path: llama-ultra run /path/to/model.gguf`
    );
  }

  _assertReady() {
    if (!this._ready) throw new Error('Engine not initialized. Call init() first.');
  }

  // Mock tokenizer for demo — replace with real GGML binding
  _mockTokenize(prompt, maxTokens) {
    const words = prompt.split(/\s+/).slice(0, maxTokens);
    return words.flatMap(w => [w, ' ']);
  }
}

function _tick() { return new Promise(r => setImmediate(r)); }

module.exports = { UltraEngine };
