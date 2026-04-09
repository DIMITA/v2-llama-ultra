'use strict';

/**
 * chunking.js
 * Splits a model into logical chunks (by layer groups) and manages
 * load / unload lifecycle so only the required portion lives in RAM.
 */

const fs   = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

class ModelChunker extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string}  opts.modelPath    - Path to the model file or directory
   * @param {number}  opts.chunkSizeMb  - Max size per chunk in MB
   * @param {number}  opts.numLayers    - Total transformer layers in the model
   * @param {string}  opts.outDir       - Where to write chunks
   */
  constructor({ modelPath, chunkSizeMb = 256, numLayers = 32, outDir = null }) {
    super();
    this.modelPath   = modelPath;
    this.chunkSizeMb = chunkSizeMb;
    this.numLayers   = numLayers;
    this.outDir      = outDir ?? path.join(path.dirname(modelPath), '.chunks');
    this.chunks      = [];   // Array<ChunkMeta>
    this.loaded      = new Map(); // chunkId → Buffer
  }

  // ─── Split ────────────────────────────────────────────────────────────────

  async split() {
    fs.mkdirSync(this.outDir, { recursive: true });

    const stat       = fs.statSync(this.modelPath);
    const totalBytes = stat.size;
    const chunkBytes = this.chunkSizeMb * 1024 * 1024;
    const numChunks  = Math.ceil(totalBytes / chunkBytes);

    this.emit('split:start', { totalBytes, numChunks });

    const fd     = fs.openSync(this.modelPath, 'r');
    const chunks = [];

    for (let i = 0; i < numChunks; i++) {
      const offset = i * chunkBytes;
      const size   = Math.min(chunkBytes, totalBytes - offset);
      const buf    = Buffer.alloc(size);

      fs.readSync(fd, buf, 0, size, offset);

      const chunkPath = path.join(this.outDir, `chunk-${String(i).padStart(4, '0')}.bin`);
      fs.writeFileSync(chunkPath, buf);

      const meta = {
        id:         i,
        path:       chunkPath,
        sizeMb:     +(size / (1024 * 1024)).toFixed(2),
        offsetByte: offset,
        layers:     this._layersForChunk(i, numChunks),
      };

      chunks.push(meta);
      this.emit('split:chunk', meta);
    }

    fs.closeSync(fd);
    this.chunks = chunks;

    const manifestPath = path.join(this.outDir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      modelPath:   this.modelPath,
      totalBytes,
      numChunks,
      chunkSizeMb: this.chunkSizeMb,
      numLayers:   this.numLayers,
      chunks,
    }, null, 2));

    this.emit('split:done', { chunks });
    return chunks;
  }

  // ─── Load / unload ────────────────────────────────────────────────────────

  async loadChunk(chunkId) {
    if (this.loaded.has(chunkId)) return this.loaded.get(chunkId);

    const meta = this.chunks[chunkId];
    if (!meta) throw new Error(`Chunk ${chunkId} not found`);

    const buf = fs.readFileSync(meta.path);
    this.loaded.set(chunkId, buf);
    this.emit('chunk:loaded', { chunkId, sizeMb: meta.sizeMb });
    return buf;
  }

  unloadChunk(chunkId) {
    if (this.loaded.has(chunkId)) {
      this.loaded.delete(chunkId);
      this.emit('chunk:unloaded', { chunkId });
    }
  }

  unloadAll() {
    for (const id of this.loaded.keys()) this.unloadChunk(id);
  }

  // ─── Restore from manifest ────────────────────────────────────────────────

  static fromManifest(manifestPath) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const chunker  = new ModelChunker({
      modelPath:   manifest.modelPath,
      chunkSizeMb: manifest.chunkSizeMb,
      numLayers:   manifest.numLayers,
      outDir:      path.dirname(manifestPath),
    });
    chunker.chunks = manifest.chunks;
    return chunker;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  _layersForChunk(chunkIdx, numChunks) {
    const layersPerChunk = Math.ceil(this.numLayers / numChunks);
    const start = chunkIdx * layersPerChunk;
    const end   = Math.min(start + layersPerChunk - 1, this.numLayers - 1);
    return { start, end };
  }

  get loadedSizeMb() {
    return Array.from(this.loaded.values())
      .reduce((sum, buf) => sum + buf.length / (1024 * 1024), 0);
  }
}

module.exports = { ModelChunker };
