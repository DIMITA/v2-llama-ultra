'use strict';

/**
 * hardware-detect.js
 * Detects CPU, RAM, GPU and returns a hardware profile used by the engine
 * to pick the best execution strategy automatically.
 */

const os = require('os');

// Try to load systeminformation — optional at runtime
let si = null;
try { si = require('systeminformation'); } catch (_) {}

// ─── Profiles ────────────────────────────────────────────────────────────────

const PROFILES = {
  ultra_low:  { label: 'Ultra Low',  ramGb: 2,  quantization: 'int4',  chunkSizeMb: 64,   maxLayers: 8  },
  low:        { label: 'Low',        ramGb: 4,  quantization: 'int4',  chunkSizeMb: 128,  maxLayers: 16 },
  medium:     { label: 'Medium',     ramGb: 8,  quantization: 'int8',  chunkSizeMb: 256,  maxLayers: 32 },
  high:       { label: 'High',       ramGb: 16, quantization: 'int8',  chunkSizeMb: 512,  maxLayers: 48 },
  ultra_high: { label: 'Ultra High', ramGb: 32, quantization: 'fp16', chunkSizeMb: 1024, maxLayers: 80 },
};

// ─── Core detection ──────────────────────────────────────────────────────────

async function detectHardware() {
  const totalRamGb = os.totalmem() / (1024 ** 3);
  const freeRamGb  = os.freemem()  / (1024 ** 3);
  const cpuCores   = os.cpus().length;
  const cpuModel   = os.cpus()[0]?.model ?? 'Unknown';

  let gpuInfo  = null;
  let gpuVramGb = 0;

  if (si) {
    try {
      const graphics = await si.graphics();
      const controllers = graphics.controllers ?? [];
      if (controllers.length > 0) {
        const gpu = controllers[0];
        gpuInfo   = gpu.model ?? 'Unknown GPU';
        gpuVramGb = (gpu.vram ?? 0) / 1024; // si returns MB
      }
    } catch (_) {}
  }

  const profile = pickProfile(freeRamGb, gpuVramGb);

  return {
    cpu: { model: cpuModel, cores: cpuCores },
    ram: { totalGb: +totalRamGb.toFixed(2), freeGb: +freeRamGb.toFixed(2) },
    gpu: gpuInfo ? { model: gpuInfo, vramGb: +gpuVramGb.toFixed(2) } : null,
    profile,
    recommendedDevice: gpuVramGb >= 4 ? 'gpu' : 'cpu',
  };
}

function detectHardwareSync() {
  const totalRamGb = os.totalmem() / (1024 ** 3);
  const freeRamGb  = os.freemem()  / (1024 ** 3);
  const cpuCores   = os.cpus().length;
  const cpuModel   = os.cpus()[0]?.model ?? 'Unknown';
  const profile    = pickProfile(freeRamGb, 0);

  return {
    cpu: { model: cpuModel, cores: cpuCores },
    ram: { totalGb: +totalRamGb.toFixed(2), freeGb: +freeRamGb.toFixed(2) },
    gpu: null,
    profile,
    recommendedDevice: 'cpu',
  };
}

// ─── Profile selector ────────────────────────────────────────────────────────

function pickProfile(freeRamGb, gpuVramGb) {
  const effectiveRam = freeRamGb + gpuVramGb;

  if (effectiveRam >= 24) return { ...PROFILES.ultra_high, name: 'ultra_high' };
  if (effectiveRam >= 12) return { ...PROFILES.high,       name: 'high'       };
  if (effectiveRam >=  6) return { ...PROFILES.medium,     name: 'medium'     };
  if (effectiveRam >=  3) return { ...PROFILES.low,        name: 'low'        };
  return { ...PROFILES.ultra_low, name: 'ultra_low' };
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = { detectHardware, detectHardwareSync, pickProfile, PROFILES };
