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
    this.emit('engine:init', { hardware: this.hardware });
    this._ready = true;
    return this;
  }

  initSync() {
    this.hardware = detectHardwareSync();
    this._ready = true;
    return this;
  }

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

    this.loadedModel = {
      path:         modelPath,
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
    const { chunker, numLayers, precisionMap } = this.loadedModel;
    const maxTokens = opts.maxTokens ?? 512;

    try {
      // Load chunks layer by layer with prefetch
      for (let layer = 0; layer < numLayers; layer++) {
        const chunkId = Math.floor(layer / Math.ceil(numLayers / chunker.chunks.length));

        // Check cache first
        const cacheKey = `chunk:${chunkId}`;
        if (!this.cache.has(cacheKey)) {
          const buf    = await chunker.loadChunk(chunkId);
          const sizeMb = buf.length / (1024 * 1024);
          this.cache.set(cacheKey, buf, sizeMb);
        }

        // Prefetch next chunks
        await this.cache.prefetch(chunkId, chunker.chunks.length, async (id) => {
          const buf = await chunker.loadChunk(id);
          return { data: buf, sizeMb: buf.length / (1024 * 1024) };
        });

        this.emit('inference:layer', { layer, precision: precisionMap[layer]?.quantization });
      }

      // Simulate token generation
      const tokens = this._mockTokenize(prompt, maxTokens);
      for (const token of tokens) {
        streamer.write(token);
        await _tick();
      }

      streamer.end();
    } catch (err) {
      streamer.destroy(err);
      this.emit('inference:error', err);
    }
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
