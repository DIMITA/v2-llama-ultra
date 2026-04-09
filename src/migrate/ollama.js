'use strict';

/**
 * migrate/ollama.js
 * Scans the local Ollama installation, parses manifests, and extracts
 * model blobs into standalone .gguf-compatible files for LLaMA Ultra.
 *
 * Ollama model layout:
 *   ~/.ollama/models/
 *   ├── manifests/
 *   │   └── registry.ollama.ai/
 *   │       └── library/
 *   │           └── <model>/
 *   │               └── <tag>          ← JSON manifest
 *   └── blobs/
 *       └── sha256-<hash>              ← raw layer data (often a GGUF)
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { EventEmitter } = require('events');

// ─── Default Ollama paths per platform ───────────────────────────────────────

// All candidate locations where Ollama might store its models
function ollamaCandidates() {
  // 1. Explicit env var always wins
  if (process.env.OLLAMA_MODELS) return [process.env.OLLAMA_MODELS];

  const home = os.homedir();

  switch (process.platform) {
    case 'darwin':
      return [
        path.join(home, '.ollama', 'models'),
      ];
    case 'win32':
      return [
        path.join(home, 'AppData', 'Local', 'ollama', 'models'),
        path.join(home, '.ollama', 'models'),
      ];
    default: // Linux — several install methods
      return [
        path.join(home, '.ollama', 'models'),             // user install / ollama run
        '/usr/share/ollama/.ollama/models',               // systemd service (deb/rpm)
        '/var/lib/ollama/models',                         // alternative service path
        path.join(home, 'snap', 'ollama', 'current', '.ollama', 'models'), // snap
      ];
  }
}

// Return the first candidate that actually exists
function ollamaRoot() {
  for (const candidate of ollamaCandidates()) {
    if (fs.existsSync(path.join(candidate, 'blobs'))) return candidate;
  }
  // Fall back to default even if not present (isInstalled() will return false)
  return ollamaCandidates()[0];
}

// ─── Scanner ─────────────────────────────────────────────────────────────────

class OllamaScanner extends EventEmitter {
  constructor(root = null) {
    super();
    // If a specific root is given use it, otherwise scan all candidates
    this._fixedRoot = root;
    this.root         = root ?? ollamaRoot();
    this.blobsDir     = path.join(this.root, 'blobs');
    this.manifestsDir = path.join(this.root, 'manifests');
  }

  // ─── Detect if Ollama is installed ─────────────────────────────────────

  isInstalled() {
    // Check all candidate paths, not just the first one
    return ollamaCandidates().some(c => fs.existsSync(path.join(c, 'blobs')));
  }

  // ─── Scan all manifests ─────────────────────────────────────────────────

  scan() {
    // Scan every candidate that exists
    const roots = this._fixedRoot
      ? [this._fixedRoot]
      : ollamaCandidates().filter(c => fs.existsSync(path.join(c, 'blobs')));

    if (roots.length === 0) return [];

    const all = [];
    for (const root of roots) {
      this.root         = root;
      this.blobsDir     = path.join(root, 'blobs');
      this.manifestsDir = path.join(root, 'manifests');
      all.push(...this._scanRoot());
    }
    return all;
  }

  _scanRoot() {
    if (!fs.existsSync(this.manifestsDir)) return [];

    const results = [];

    const walkManifests = (dir, parts = []) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          walkManifests(path.join(dir, entry.name), [...parts, entry.name]);
        } else {
          // Leaf = actual manifest file (tag name)
          const manifestPath = path.join(dir, entry.name);
          const tag          = entry.name;
          // parts looks like ['registry.ollama.ai', 'library', 'llama3']
          const modelName = parts.length >= 3 ? parts.slice(2).join('/') : parts.join('/');
          const fullName  = `${modelName}:${tag}`;

          try {
            const model = this._parseManifest(manifestPath, fullName);
            if (model) results.push(model);
          } catch (_) {}
        }
      }
    };

    walkManifests(this.manifestsDir);
    return results;
  }

  // ─── Parse a single manifest ────────────────────────────────────────────

  _parseManifest(manifestPath, fullName) {
    const raw      = fs.readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(raw);

    // Find the model layer (mediaType ends with 'model' or digest points to large blob)
    const layers = manifest.layers ?? [];
    const modelLayer = layers.find(l =>
      l.mediaType?.includes('model') ||
      l.mediaType?.includes('gguf')  ||
      l.size > 100_000_000  // > 100 MB → likely the model weights
    );

    if (!modelLayer) return null;

    const blobHash = (modelLayer.digest ?? '').replace(':', '-'); // sha256:abc → sha256-abc
    const blobPath = path.join(this.blobsDir, blobHash);

    let sizeGb = 0;
    if (fs.existsSync(blobPath)) {
      sizeGb = fs.statSync(blobPath).size / (1024 ** 3);
    } else {
      sizeGb = (modelLayer.size ?? 0) / (1024 ** 3);
    }

    // Try to infer quantization from model name or config layer
    const configLayer = layers.find(l => l.mediaType?.includes('config'));
    let quantization  = inferQuantFromName(fullName);

    if (configLayer) {
      const configHash = (configLayer.digest ?? '').replace(':', '-');
      const configPath = path.join(this.blobsDir, configHash);
      if (fs.existsSync(configPath)) {
        try {
          const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
          if (cfg.quantization_version || cfg.file_type) {
            quantization = cfg.file_type ?? quantization;
          }
        } catch (_) {}
      }
    }

    return {
      source:       'ollama',
      fullName,                       // e.g. "llama3:8b"
      displayName:  fullName,
      blobPath:     fs.existsSync(blobPath) ? blobPath : null,
      manifestPath,
      sizeGb:       +sizeGb.toFixed(2),
      quantization,
      available:    fs.existsSync(blobPath),
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function inferQuantFromName(name) {
  const n = name.toLowerCase();
  if (n.includes('q4_k_m') || n.includes('q4')) return 'int4';
  if (n.includes('q8')     || n.includes('q8_0')) return 'int8';
  if (n.includes('f16')    || n.includes('fp16')) return 'fp16';
  if (n.includes('f32')    || n.includes('fp32')) return 'fp32';
  return 'unknown';
}

module.exports = { OllamaScanner, ollamaRoot, ollamaCandidates };
