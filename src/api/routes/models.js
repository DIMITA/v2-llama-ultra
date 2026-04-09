'use strict';

/**
 * routes/models.js
 * Model management REST endpoints.
 *
 * GET  /v1/models              — list known models (Ollama + registry)
 * GET  /v1/engine/status       — engine + cache + loaded models
 * POST /v1/models/load         — load a model into the engine
 * POST /v1/models/unload       — unload a specific model (or all)
 */

const express   = require('express');
const router    = express.Router();
const ollamaBackend   = require('../../core/backends/ollama');
const { ModelRegistry } = require('../../migrate/index');
const { loadConfig }    = require('../../config/loader');
const { UltraEngine }   = require('../../core/engine');

// Shared engine instance (created lazily, one per process)
let _engine = null;

async function getEngine() {
  if (_engine) return _engine;
  const cfg = await loadConfig();
  _engine = new UltraEngine({ modelsDir: cfg.modelsDir });
  await _engine.init();
  return _engine;
}

// ─── GET /v1/models ───────────────────────────────────────────────────────────

router.get('/models', async (_req, res) => {
  try {
    const cfg     = await loadConfig();
    const ollama  = [];
    const registry = [];

    // Ollama models
    if (await ollamaBackend.isOllamaRunning()) {
      try {
        const raw = await ollamaBackend.listModels();
        for (const m of raw) {
          ollama.push({
            id:      m.name,
            object:  'model',
            source:  'ollama',
            size:    m.size ?? 0,
            sizeGb:  +((m.size ?? 0) / (1024 ** 3)).toFixed(2),
          });
        }
      } catch (_) {}
    }

    // Registry models
    try {
      const reg = new ModelRegistry(cfg.modelsDir);
      for (const m of reg.list()) {
        registry.push({
          id:      m.fullName ?? m.name,
          object:  'model',
          source:  m.source ?? 'local',
          sizeGb:  m.sizeGb,
          quantization: m.quantization,
        });
      }
    } catch (_) {}

    const engine = await getEngine().catch(() => null);
    const loaded = engine?.listLoadedModels?.() ?? [];
    const loadedKeys = new Set(loaded.map(m => m.ollamaName ?? m.key));

    const all = [...ollama, ...registry].map(m => ({
      ...m,
      loaded: loadedKeys.has(m.id),
    }));

    res.json({ object: 'list', data: all });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /v1/engine/status ────────────────────────────────────────────────────

router.get('/engine/status', async (_req, res) => {
  try {
    const engine = await getEngine();
    res.json(engine.status());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /v1/models/load ─────────────────────────────────────────────────────

router.post('/models/load', async (req, res) => {
  const { model, quantization } = req.body ?? {};
  if (!model) return res.status(400).json({ error: 'model is required' });

  try {
    const engine = await getEngine();
    if (quantization) engine.quantization = quantization;
    const loaded = await engine.loadModel(model);
    res.json({
      object:      'model.loaded',
      model:       loaded.ollamaName ?? loaded.path,
      quantization: loaded.quantization,
      compressedSizeGb: loaded.compressedSizeGb,
      loadedAt:    loaded.loadedAt,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── POST /v1/models/unload ───────────────────────────────────────────────────

router.post('/models/unload', async (req, res) => {
  const { model } = req.body ?? {};
  try {
    const engine = await getEngine();
    engine.unload(model ?? undefined);
    res.json({ object: 'model.unloaded', model: model ?? 'all' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
