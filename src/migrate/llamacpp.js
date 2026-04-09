'use strict';

/**
 * migrate/llamacpp.js
 * Scans common llama.cpp model directories for .gguf / .bin / .ggml files.
 * Also handles LocalAI, LM Studio, GPT4All, and Jan layouts.
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { EventEmitter } = require('events');

// ─── Well-known search paths ──────────────────────────────────────────────────

const KNOWN_DIRS = [
  // llama.cpp clones
  path.join(os.homedir(), 'llama.cpp', 'models'),
  path.join(os.homedir(), 'llama', 'models'),
  // Generic ~/models
  path.join(os.homedir(), 'models'),
  path.join(os.homedir(), 'Downloads'),
  // LM Studio
  path.join(os.homedir(), '.cache', 'lm-studio', 'models'),
  // Jan
  path.join(os.homedir(), 'jan', 'models'),
  // GPT4All
  path.join(os.homedir(), '.local', 'share', 'nomic.ai', 'GPT4All'),
  path.join(os.homedir(), 'AppData', 'Local', 'nomic.ai', 'GPT4All'),
  // LocalAI
  path.join(os.homedir(), '.config', 'LocalAI', 'models'),
  '/usr/share/ollama/models',
];

const MODEL_EXTENSIONS = new Set(['.gguf', '.ggml', '.bin']);
const MIN_FILE_SIZE = 50 * 1024 * 1024; // 50 MB — ignore tiny files

// ─── Scanner ─────────────────────────────────────────────────────────────────

class LlamaCppScanner extends EventEmitter {
  /**
   * @param {string[]} extraDirs  Additional directories to scan
   * @param {number}   maxDepth   Max recursion depth (default: 3)
   */
  constructor({ extraDirs = [], maxDepth = 3 } = {}) {
    super();
    this.searchDirs = [...KNOWN_DIRS, ...extraDirs];
    this.maxDepth   = maxDepth;
  }

  // ─── Scan ─────────────────────────────────────────────────────────────

  scan() {
    const found  = [];
    const seen   = new Set(); // deduplicate by realpath

    for (const dir of this.searchDirs) {
      if (!fs.existsSync(dir)) continue;
      this._walk(dir, found, seen, 0);
    }

    return found;
  }

  // ─── Recursive walk ────────────────────────────────────────────────────

  _walk(dir, results, seen, depth) {
    if (depth > this.maxDepth) return;

    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isSymbolicLink()) {
        try { entry._real = fs.realpathSync(fullPath); }
        catch { continue; }
      }

      if (entry.isDirectory()) {
        // Skip hidden dirs and node_modules
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        this._walk(fullPath, results, seen, depth + 1);
        continue;
      }

      const ext  = path.extname(entry.name).toLowerCase();
      if (!MODEL_EXTENSIONS.has(ext)) continue;

      let stat;
      try { stat = fs.statSync(fullPath); }
      catch { continue; }

      if (stat.size < MIN_FILE_SIZE) continue;

      const real = entry._real ?? fullPath;
      if (seen.has(real)) continue;
      seen.add(real);

      const model = this._buildModel(fullPath, stat);
      results.push(model);
      this.emit('found', model);
    }
  }

  // ─── Build model descriptor ────────────────────────────────────────────

  _buildModel(filePath, stat) {
    const basename     = path.basename(filePath);
    const sizeGb       = stat.size / (1024 ** 3);
    const quantization = inferQuantFromFilename(basename);
    const paramCount   = inferParamCount(basename);
    const origin       = detectOrigin(path.dirname(filePath));

    return {
      source:      origin,        // 'llamacpp' | 'lmstudio' | 'jan' | 'gpt4all' | 'localai' | 'generic'
      fullName:    basename,
      displayName: basename.replace(/\.(gguf|ggml|bin)$/i, ''),
      filePath,
      sizeGb:      +sizeGb.toFixed(2),
      quantization,
      paramCount,                 // e.g. '7B' | '13B' | '70B' | null
      available:   true,
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function inferQuantFromFilename(name) {
  const n = name.toLowerCase();
  if (/q4_k_m|q4_km|q4(?!_[01])/.test(n)) return 'int4';
  if (/q8_0|q8(?!_)/.test(n))             return 'int8';
  if (/q5/.test(n))                        return 'int8';  // close enough
  if (/f16|fp16/.test(n))                  return 'fp16';
  if (/f32|fp32/.test(n))                  return 'fp32';
  return 'unknown';
}

function inferParamCount(name) {
  const m = name.match(/(\d+\.?\d*)b/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (n < 1) return null;
  return `${n}B`;
}

function detectOrigin(dir) {
  const d = dir.toLowerCase();
  if (d.includes('lm-studio') || d.includes('lmstudio')) return 'lmstudio';
  if (d.includes('jan'))                                  return 'jan';
  if (d.includes('gpt4all') || d.includes('nomic'))      return 'gpt4all';
  if (d.includes('localai'))                              return 'localai';
  if (d.includes('llama.cpp') || d.includes('llamacpp')) return 'llamacpp';
  return 'generic';
}

module.exports = { LlamaCppScanner, KNOWN_DIRS };
