'use strict';

const express = require('express');
const router  = express.Router();
const { authMiddleware }  = require('../middleware/auth');
const { pricingGuard }    = require('../../pricing');
const { setupSSE }        = require('../../core/streaming');
const { UltraEngine }     = require('../../core/engine');
const { loadConfig }      = require('../../config/loader');

// Shared engine instance (singleton per server process)
let _engine = null;
async function getEngine() {
  if (_engine) return _engine;
  const cfg = loadConfig();
  _engine = new UltraEngine({
    modelsDir:      cfg.modelsDir,
    maxCacheSizeMb: cfg.maxCacheSizeMb,
    quantization:   cfg.quantization,
    enableGPU:      cfg.enableGPU,
  });
  await _engine.init();
  return _engine;
}

// ─── POST /v1/completions ──────────────────────────────────────────────────────

router.post('/completions',
  authMiddleware({ optional: true }),
  pricingGuard('api'),
  async (req, res) => {
    const { model, prompt, max_tokens = 512, stream = false, speed = 0 } = req.body;

    if (!prompt) return res.status(400).json({ error: 'prompt is required' });

    try {
      const engine = await getEngine();
      if (!engine.loadedModel || engine.loadedModel.path !== model) {
        await engine.loadModel(model);
      }

      if (stream) {
        const sse = setupSSE(req, res);
        const inferStream = engine.infer(prompt, { maxTokens: max_tokens, format: 'text', speed });

        inferStream.on('data', token => sse.send({ token }));
        inferStream.on('stream:done', ({ tokenCount }) => {
          sse.send({ done: true, tokenCount });
          sse.done();
        });
        inferStream.on('error', err => sse.error(err.message));
      } else {
        let output = '';
        await new Promise((resolve, reject) => {
          const s = engine.infer(prompt, { maxTokens: max_tokens, format: 'text' });
          s.on('data',  chunk => { output += chunk; });
          s.on('end',   resolve);
          s.on('error', reject);
        });

        res.json({
          id:      `cmpl-${Date.now()}`,
          object:  'text_completion',
          model,
          choices: [{ text: output.trim(), index: 0, finish_reason: 'stop' }],
        });
      }
    } catch (err) {
      res.status(500).json({ error: 'inference_error', message: err.message });
    }
  }
);

// ─── POST /v1/chat/completions (OpenAI-compatible) ────────────────────────────

router.post('/chat/completions',
  authMiddleware({ optional: true }),
  pricingGuard('api'),
  pricingGuard('streaming', req => req.body.stream ? 'streaming' : null),
  async (req, res) => {
    const { model, messages, max_tokens = 512, stream = false } = req.body;

    if (!messages?.length) return res.status(400).json({ error: 'messages array is required' });

    const prompt = messages
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n') + '\nAssistant:';

    try {
      const engine = await getEngine();
      if (!engine.loadedModel) await engine.loadModel(model ?? 'default');

      if (stream) {
        const sse = setupSSE(req, res);
        const inferStream = engine.infer(prompt, { maxTokens: max_tokens, format: 'text' });
        inferStream.on('data', token => sse.send({ choices: [{ delta: { content: token }, index: 0 }] }));
        inferStream.on('stream:done', () => { sse.send({ choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] }); sse.done(); });
        inferStream.on('error', err => sse.error(err.message));
      } else {
        let output = '';
        await new Promise((resolve, reject) => {
          const s = engine.infer(prompt, { maxTokens: max_tokens });
          s.on('data', c => { output += c; });
          s.on('end', resolve);
          s.on('error', reject);
        });

        res.json({
          id:      `chatcmpl-${Date.now()}`,
          object:  'chat.completion',
          model:   model ?? 'default',
          choices: [{ index: 0, message: { role: 'assistant', content: output.trim() }, finish_reason: 'stop' }],
        });
      }
    } catch (err) {
      res.status(500).json({ error: 'inference_error', message: err.message });
    }
  }
);

// ─── GET /v1/models ───────────────────────────────────────────────────────────

router.get('/models', authMiddleware({ optional: true }), async (req, res) => {
  const engine = await getEngine();
  const status = engine.status();
  res.json({
    object: 'list',
    data:   status.loadedModel
      ? [{ id: status.loadedModel.path, object: 'model', quantization: status.loadedModel.quantization }]
      : [],
  });
});

// ─── GET /v1/engine/status ────────────────────────────────────────────────────

router.get('/engine/status', async (_req, res) => {
  const engine = await getEngine();
  res.json(engine.status());
});

module.exports = router;
