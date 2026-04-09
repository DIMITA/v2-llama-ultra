'use strict';

/**
 * cache.js
 * Predictive LRU cache for model chunks + KV-cache for inference.
 * Keeps a RAM budget and evicts least-recently-used chunks automatically.
 */

const { EventEmitter } = require('events');

// ─── LRU Node ────────────────────────────────────────────────────────────────

class LRUNode {
  constructor(key, value, sizeMb) {
    this.key   = key;
    this.value = value;
    this.sizeMb = sizeMb;
    this.hits  = 0;
    this.prev  = null;
    this.next  = null;
    this.ts    = Date.now();
  }
}

// ─── Predictive LRU Cache ────────────────────────────────────────────────────

class PredictiveCache extends EventEmitter {
  /**
   * @param {object} opts
   * @param {number} opts.maxSizeMb      - Hard RAM budget in MB
   * @param {number} opts.prefetchWindow - How many future chunks to prefetch
   */
  constructor({ maxSizeMb = 2048, prefetchWindow = 2 } = {}) {
    super();
    this.maxSizeMb      = maxSizeMb;
    this.prefetchWindow = prefetchWindow;
    this.usedMb         = 0;
    this.map            = new Map();  // key → LRUNode
    this.head           = new LRUNode('head', null, 0); // sentinel
    this.tail           = new LRUNode('tail', null, 0); // sentinel
    this.head.next = this.tail;
    this.tail.prev = this.head;
    this.hits   = 0;
    this.misses = 0;
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  get(key) {
    const node = this.map.get(key);
    if (!node) { this.misses++; return null; }
    this.hits++;
    node.hits++;
    this._moveToFront(node);
    this.emit('cache:hit', { key, hits: node.hits });
    return node.value;
  }

  set(key, value, sizeMb = 0) {
    if (this.map.has(key)) {
      const node = this.map.get(key);
      node.value = value;
      this._moveToFront(node);
      return;
    }

    while (this.usedMb + sizeMb > this.maxSizeMb && this.map.size > 0) {
      this._evictLRU();
    }

    const node = new LRUNode(key, value, sizeMb);
    this.map.set(key, node);
    this._addToFront(node);
    this.usedMb += sizeMb;
    this.emit('cache:set', { key, sizeMb, usedMb: this.usedMb });
  }

  has(key) { return this.map.has(key); }

  delete(key) {
    const node = this.map.get(key);
    if (!node) return false;
    this._removeNode(node);
    this.map.delete(key);
    this.usedMb -= node.sizeMb;
    this.emit('cache:delete', { key });
    return true;
  }

  clear() {
    this.map.clear();
    this.head.next = this.tail;
    this.tail.prev = this.head;
    this.usedMb = 0;
    this.emit('cache:clear');
  }

  // ─── Predictive prefetch ──────────────────────────────────────────────────

  /**
   * Schedule prefetch of `count` chunks ahead using a loader function.
   * @param {number}   currentChunk
   * @param {number}   totalChunks
   * @param {Function} loaderFn  async (chunkId) → { data, sizeMb }
   */
  async prefetch(currentChunk, totalChunks, loaderFn) {
    const targets = [];
    for (let i = 1; i <= this.prefetchWindow; i++) {
      const next = currentChunk + i;
      if (next < totalChunks && !this.has(`chunk:${next}`)) {
        targets.push(next);
      }
    }

    for (const chunkId of targets) {
      try {
        const { data, sizeMb } = await loaderFn(chunkId);
        this.set(`chunk:${chunkId}`, data, sizeMb);
        this.emit('cache:prefetch', { chunkId });
      } catch (err) {
        this.emit('cache:prefetch:error', { chunkId, err });
      }
    }
  }

  // ─── Stats ────────────────────────────────────────────────────────────────

  get stats() {
    const total = this.hits + this.misses;
    return {
      hits:      this.hits,
      misses:    this.misses,
      hitRate:   total > 0 ? +(this.hits / total * 100).toFixed(1) : 0,
      usedMb:    +this.usedMb.toFixed(2),
      maxSizeMb: this.maxSizeMb,
      entries:   this.map.size,
    };
  }

  // ─── Doubly-linked list helpers ───────────────────────────────────────────

  _addToFront(node) {
    node.prev = this.head;
    node.next = this.head.next;
    this.head.next.prev = node;
    this.head.next = node;
  }

  _removeNode(node) {
    node.prev.next = node.next;
    node.next.prev = node.prev;
  }

  _moveToFront(node) {
    this._removeNode(node);
    this._addToFront(node);
  }

  _evictLRU() {
    const lru = this.tail.prev;
    if (lru === this.head) return;
    this._removeNode(lru);
    this.map.delete(lru.key);
    this.usedMb -= lru.sizeMb;
    this.emit('cache:evict', { key: lru.key, sizeMb: lru.sizeMb });
  }
}

// ─── KV-cache (for autoregressive inference) ─────────────────────────────────

class KVCache {
  constructor({ maxTokens = 2048, numLayers = 32, headDim = 64, numHeads = 8 } = {}) {
    this.maxTokens = maxTokens;
    this.numLayers = numLayers;
    this.headDim   = headDim;
    this.numHeads  = numHeads;
    this.keys   = new Array(numLayers).fill(null);
    this.values = new Array(numLayers).fill(null);
    this.seqLen = 0;
  }

  update(layer, keySlice, valueSlice) {
    if (!this.keys[layer])   this.keys[layer]   = [];
    if (!this.values[layer]) this.values[layer] = [];
    this.keys[layer].push(keySlice);
    this.values[layer].push(valueSlice);
    this.seqLen = this.keys[layer].length;
  }

  get(layer) {
    return { keys: this.keys[layer] ?? [], values: this.values[layer] ?? [] };
  }

  reset() {
    this.keys   = new Array(this.numLayers).fill(null);
    this.values = new Array(this.numLayers).fill(null);
    this.seqLen = 0;
  }

  get memoryEstimateMb() {
    // 2 (K+V) × layers × seqLen × numHeads × headDim × 2 bytes (fp16)
    return (2 * this.numLayers * this.seqLen * this.numHeads * this.headDim * 2) / (1024 * 1024);
  }
}

module.exports = { PredictiveCache, KVCache };
