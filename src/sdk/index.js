'use strict';

/**
 * LLaMA Ultra Node.js SDK
 * Drop-in replacement for heavy inference runtimes.
 * Works on any machine — auto-adapts to available hardware.
 */

const { UltraEngine }   = require('../core/engine');
const { detectHardware, detectHardwareSync } = require('../core/hardware-detect');
const { PredictiveCache } = require('../core/cache');
const { selectQuantizationLevel, estimateCompressedSizeGb } = require('../core/quantization');

class LlamaUltraClient {
  /**
   * @param {object} opts
   * @param {string}  opts.modelsDir      - Path to model storage (default: ~/.llama-ultra/models)
   * @param {string}  opts.quantization   - 'auto' | 'int4' | 'int8' | 'fp16' | 'fp32'
   * @param {boolean} opts.autoInit       - Auto-initialize on construction (default: true)
   * @param {number}  opts.maxCacheSizeMb - RAM budget for chunk cache
   * @param {boolean} opts.enableGPU      - Use GPU if available
   */
  constructor(opts = {}) {
    this._engine = new UltraEngine({
      modelsDir:      opts.modelsDir,
      maxCacheSizeMb: opts.maxCacheSizeMb ?? 2048,
      quantization:   opts.quantization   ?? 'auto',
      enableGPU:      opts.enableGPU      ?? true,
      maxRamPercent:  opts.maxRamPercent  ?? 80,
    });
    this._initialized = false;
    this._opts = opts;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  async init() {
    if (this._initialized) return this;
    await this._engine.init();
    this._initialized = true;
    return this;
  }

  // ─── Model management ─────────────────────────────────────────────────────

  async load(model, opts = {}) {
    if (!this._initialized) await this.init();
    return this._engine.loadModel(model, opts);
  }

  unload() { this._engine.unload(); }

  // ─── Inference ────────────────────────────────────────────────────────────

  /**
   * Generate text from a prompt.
   * Returns a Promise that resolves to the full text.
   */
  async generate(prompt, opts = {}) {
    if (!this._initialized) await this.init();
    return new Promise((resolve, reject) => {
      let output = '';
      const stream = this._engine.infer(prompt, { ...opts, format: 'text' });
      stream.on('data',         chunk => { output += chunk; });
      stream.on('end',          ()    => resolve(output.trim()));
      stream.on('error',        err   => reject(err));
    });
  }

  /**
   * Stream tokens as they are generated.
   * Returns a NodeJS ReadableStream compatible with async iteration.
   */
  stream(prompt, opts = {}) {
    if (!this._initialized) {
      // Return a lazy stream that auto-inits
      const { PassThrough } = require('stream');
      const pt = new PassThrough({ objectMode: true });
      this.init().then(() => {
        const s = this._engine.infer(prompt, opts);
        s.pipe(pt);
      }).catch(err => pt.destroy(err));
      return pt;
    }
    return this._engine.infer(prompt, opts);
  }

  // ─── Embeddings (stub — plug in a real model) ─────────────────────────────

  async embed(text) {
    if (!this._initialized) await this.init();
    // Placeholder: returns a normalized random vector. Replace with real embedder.
    const dim    = 768;
    const vector = Array.from({ length: dim }, () => Math.random() - 0.5);
    const norm   = Math.sqrt(vector.reduce((s, x) => s + x * x, 0));
    return vector.map(x => x / norm);
  }

  // ─── Hardware info ────────────────────────────────────────────────────────

  async hardware() {
    return detectHardware();
  }

  status() { return this._engine.status(); }

  // ─── Events passthrough ───────────────────────────────────────────────────

  on(event, fn)  { this._engine.on(event, fn);  return this; }
  off(event, fn) { this._engine.off(event, fn); return this; }

  // ─── OpenAI-compatible chat completions ───────────────────────────────────

  get chat() {
    const self = this;
    return {
      completions: {
        /**
         * @param {{ model: string, messages: Array<{role, content}>, stream?: boolean, max_tokens?: number }} params
         */
        async create(params) {
          const prompt = params.messages
            .map(m => `${m.role === 'user' ? 'User' : m.role === 'system' ? 'System' : 'Assistant'}: ${m.content}`)
            .join('\n') + '\nAssistant:';

          if (!self._initialized) await self.init();
          if (!self._engine.loadedModel) await self._engine.loadModel(params.model);

          if (params.stream) {
            const s = self._engine.infer(prompt, {
              maxTokens: params.max_tokens ?? 512,
              format:    'json',
            });
            return s; // async iterable
          }

          const text = await self.generate(prompt, { maxTokens: params.max_tokens ?? 512 });
          return {
            id:      `cmpl-${Date.now()}`,
            object:  'chat.completion',
            model:   params.model,
            choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
            usage:   { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, // fill from real model
          };
        },
      },
    };
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

async function createClient(opts = {}) {
  const client = new LlamaUltraClient(opts);
  await client.init();
  return client;
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  LlamaUltraClient,
  createClient,
  // Named re-exports for advanced use
  UltraEngine,
  detectHardware,
  detectHardwareSync,
  PredictiveCache,
  selectQuantizationLevel,
  estimateCompressedSizeGb,
};
