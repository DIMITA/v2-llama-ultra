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

    this.hardware   = null;
    this.cache      = new PredictiveCache({ maxSizeMb: maxCacheSizeMb, prefetchWindow: 2 });
    this.kvCache    = new KVCache();
    this.loadedModel = null;
    this._ready     = false;
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

    this.loadedModel = {
      path:         modelPath,
      ollamaName,
      chunker,
      numLayers,
      quantization: level,
      precisionMap,
      compressedSizeGb,
      loadedAt:     new Date().toISOString(),
    };

    this.kvCache.reset();
    this.emit('model:load:done', this.loadedModel);
    return this.loadedModel;
  }

  // ─── Inference (streaming) ────────────────────────────────────────────────

  /**
   * Run inference and return a TokenStreamer.
   * In a real implementation, the chunk bytes would be fed to a GGML / ONNX runner.
   */
  infer(prompt, opts = {}) {
    this._assertReady();
    if (!this.loadedModel) throw new Error('No model loaded. Call loadModel() first.');

    const streamer = new TokenStreamer({
      format: opts.format ?? 'text',
      tokensPerSecondTarget: opts.speed ?? 0,
    });

    setImmediate(() => this._runInference(prompt, opts, streamer));
    return streamer;
  }

  async _runInference(prompt, opts, streamer) {
    try {
      if (this._backend === 'ollama') {
        await this._runOllama(prompt, opts, streamer);
      } else {
        await this._runMock(prompt, opts, streamer);
      }
    } catch (err) {
      streamer.destroy(err);
      this.emit('inference:error', err);
    }
  }

  // ─── Ollama backend (real inference) ────────────────────────────────────

  async _runOllama(prompt, opts, streamer) {
    const modelName = this.loadedModel.ollamaName ?? this.loadedModel.path;
    const messages  = [
      ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
      { role: 'user', content: prompt },
    ];

    const { totalTokens, evalDuration } = await ollamaBackend.streamChat({
      model:    modelName,
      messages,
      options:  { maxTokens: opts.maxTokens ?? 2048, temperature: opts.temperature },
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

  async _runMock(prompt, opts, streamer) {
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

  unload() {
    if (this.loadedModel) {
      this.loadedModel.chunker.unloadAll();
      this.cache.clear();
      this.kvCache.reset();
      this.emit('model:unload', { path: this.loadedModel.path });
      this.loadedModel = null;
    }
  }

  // ─── Status ───────────────────────────────────────────────────────────────

  status() {
    return {
      ready:       this._ready,
      hardware:    this.hardware,
      loadedModel: this.loadedModel ? {
        path:         this.loadedModel.path,
        quantization: this.loadedModel.quantization,
        compressedSizeGb: this.loadedModel.compressedSizeGb,
        loadedAt:     this.loadedModel.loadedAt,
      } : null,
      cache: this.cache.stats,
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
