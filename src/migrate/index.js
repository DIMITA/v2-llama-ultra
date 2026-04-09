'use strict';

/**
 * migrate/index.js
 * Orchestrates model migration from Ollama / llama.cpp / LM Studio / Jan / GPT4All
 * into LLaMA Ultra's model directory, with optional pre-optimization.
 *
 * Migration modes:
 *   - copy    → full copy into modelsDir (safe, uses more disk)
 *   - link    → hard-link (same filesystem, instant, no extra space)
 *   - symlink → symbolic link (cross-filesystem, instant)
 *   - move    → move the file (frees space in source)
 *   - inplace → register without moving (zero disk cost, reads from original path)
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { EventEmitter } = require('events');
const { OllamaScanner } = require('./ollama');
const { LlamaCppScanner } = require('./llamacpp');
const { loadConfig } = require('../config/loader');

const SOURCE_ICONS = {
  ollama:   '🦙',
  llamacpp: '⚙️',
  lmstudio: '🖥️',
  jan:      '🤖',
  gpt4all:  '🌐',
  localai:  '🔧',
  generic:  '📦',
};

// ─── Registry ─────────────────────────────────────────────────────────────────

const REGISTRY_FILENAME = 'models.json';

class ModelRegistry {
  constructor(modelsDir) {
    this.modelsDir    = modelsDir;
    this.registryPath = path.join(modelsDir, REGISTRY_FILENAME);
    this._data        = this._load();
  }

  _load() {
    if (!fs.existsSync(this.registryPath)) return { models: [] };
    try { return JSON.parse(fs.readFileSync(this.registryPath, 'utf8')); }
    catch { return { models: [] }; }
  }

  save() {
    fs.mkdirSync(this.modelsDir, { recursive: true });
    fs.writeFileSync(this.registryPath, JSON.stringify(this._data, null, 2));
  }

  add(entry) {
    const exists = this._data.models.find(m => m.id === entry.id);
    if (exists) {
      Object.assign(exists, entry);
    } else {
      this._data.models.push(entry);
    }
    this.save();
  }

  list() { return this._data.models; }

  has(id) { return this._data.models.some(m => m.id === id); }
}

// ─── Migrator ─────────────────────────────────────────────────────────────────

class Migrator extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string}   opts.modelsDir      Destination directory
   * @param {string[]} opts.extraScanDirs  Extra directories to scan for GGUF files
   * @param {string}   opts.mode           'copy'|'link'|'symlink'|'move'|'inplace'
   * @param {boolean}  opts.optimize       Run chunk+quantize after migration
   */
  constructor(opts = {}) {
    super();
    const cfg = loadConfig();
    this.modelsDir    = opts.modelsDir ?? cfg.modelsDir ?? path.join(os.homedir(), '.llama-ultra', 'models');
    this.mode         = opts.mode ?? 'link';
    this.optimize     = opts.optimize ?? false;
    this.extraDirs    = opts.extraScanDirs ?? [];
    this.registry     = new ModelRegistry(this.modelsDir);
  }

  // ─── Scan all sources ──────────────────────────────────────────────────

  async scan() {
    this.emit('scan:start');

    const ollama  = new OllamaScanner();
    const llamaCpp = new LlamaCppScanner({ extraDirs: this.extraDirs });

    const ollamaModels   = ollama.isInstalled() ? ollama.scan() : [];
    const llamaCppModels = llamaCpp.scan();

    const all = [
      ...ollamaModels,
      ...llamaCppModels,
    ].map(m => ({
      ...m,
      id:           buildId(m),
      alreadyMigrated: this.registry.has(buildId(m)),
    }));

    this.emit('scan:done', { total: all.length, ollama: ollamaModels.length, llamacpp: llamaCppModels.length });
    return all;
  }

  // ─── Migrate a list of selected models ─────────────────────────────────

  async migrate(selectedModels) {
    fs.mkdirSync(this.modelsDir, { recursive: true });

    const results = [];
    for (const model of selectedModels) {
      try {
        const result = await this._migrateOne(model);
        results.push({ ...model, ...result, success: true });
      } catch (err) {
        this.emit('model:error', { model, err });
        results.push({ ...model, success: false, error: err.message });
      }
    }
    return results;
  }

  // ─── Migrate a single model ─────────────────────────────────────────────

  async _migrateOne(model) {
    const srcPath = model.filePath ?? model.blobPath;
    if (!srcPath || !fs.existsSync(srcPath)) {
      throw new Error(`Source file not found: ${srcPath}`);
    }

    const destName = sanitizeFilename(model.displayName) + '.gguf';
    const destPath = path.join(this.modelsDir, destName);

    this.emit('model:start', { model, destPath, mode: this.mode });

    // Skip if already at destination
    if (fs.existsSync(destPath)) {
      const destStat = fs.statSync(destPath);
      const srcStat  = fs.statSync(srcPath);
      if (destStat.size === srcStat.size) {
        this.emit('model:skip', { model, destPath, reason: 'already exists with same size' });
        return { destPath, mode: 'skip' };
      }
    }

    switch (this.mode) {
      case 'inplace':
        // Register the original path as-is
        break;

      case 'symlink':
        fs.symlinkSync(srcPath, destPath);
        break;

      case 'link':
        try {
          fs.linkSync(srcPath, destPath);
        } catch (err) {
          if (err.code === 'EXDEV') {
            // Cross-device — fall back to copy
            this.emit('model:info', { model, msg: 'Cross-device hard link — falling back to copy' });
            await copyWithProgress(srcPath, destPath, (pct) => {
              this.emit('model:progress', { model, pct });
            });
          } else throw err;
        }
        break;

      case 'move':
        try {
          fs.renameSync(srcPath, destPath);
        } catch (err) {
          if (err.code === 'EXDEV') {
            await copyWithProgress(srcPath, destPath, pct => this.emit('model:progress', { model, pct }));
            fs.unlinkSync(srcPath);
          } else throw err;
        }
        break;

      case 'copy':
      default:
        await copyWithProgress(srcPath, destPath, (pct) => {
          this.emit('model:progress', { model, pct });
        });
        break;
    }

    const finalPath = this.mode === 'inplace' ? srcPath : destPath;

    // Register in the local registry
    const registryEntry = {
      id:           model.id,
      name:         model.displayName,
      fullName:     model.fullName,
      source:       model.source,
      originalPath: srcPath,
      path:         finalPath,
      sizeGb:       model.sizeGb,
      quantization: model.quantization,
      paramCount:   model.paramCount ?? null,
      migratedAt:   new Date().toISOString(),
      mode:         this.mode,
    };
    this.registry.add(registryEntry);

    this.emit('model:done', { model, destPath: finalPath });
    return { destPath: finalPath, mode: this.mode };
  }

  // ─── Report ────────────────────────────────────────────────────────────

  listMigrated() { return this.registry.list(); }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildId(model) {
  return `${model.source}::${model.fullName}`;
}

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9_.\-]/g, '_').replace(/_+/g, '_');
}

async function copyWithProgress(src, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const stat      = fs.statSync(src);
    const total     = stat.size;
    let   copied    = 0;
    let   lastPct   = -1;

    const rs = fs.createReadStream(src);
    const ws = fs.createWriteStream(dest);

    rs.on('data', chunk => {
      copied += chunk.length;
      const pct = Math.round((copied / total) * 100);
      if (pct !== lastPct) { lastPct = pct; onProgress(pct); }
    });

    rs.on('error', err => { ws.destroy(); reject(err); });
    ws.on('error', err => { rs.destroy(); reject(err); });
    ws.on('finish', resolve);

    rs.pipe(ws);
  });
}

module.exports = { Migrator, ModelRegistry, SOURCE_ICONS };
