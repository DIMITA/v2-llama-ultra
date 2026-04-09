'use strict';

/**
 * quantization.js
 * Adaptive weight quantization: FP32 → FP16 → INT8 → INT4
 * Pure JS implementation for portability; a native addon can be swapped in.
 */

const QUANTIZATION_LEVELS = ['fp32', 'fp16', 'int8', 'int4'];

// ─── Bit-width map ───────────────────────────────────────────────────────────

const BIT_WIDTH = { fp32: 32, fp16: 16, int8: 8, int4: 4 };

// ─── Compression ratio (relative to FP32) ────────────────────────────────────

function compressionRatio(from, to) {
  return BIT_WIDTH[from] / BIT_WIDTH[to];
}

// ─── Simulated quantize (production: replace with GGML / ONNX quant) ─────────

/**
 * Quantize a Float32Array to a target precision.
 * Returns a quantized buffer and the scale/zero-point needed for dequantization.
 */
function quantize(float32Array, level = 'int8') {
  if (!QUANTIZATION_LEVELS.includes(level)) {
    throw new Error(`Unknown quantization level: ${level}. Valid: ${QUANTIZATION_LEVELS.join(', ')}`);
  }

  if (level === 'fp32') return { data: float32Array, scale: 1, zeroPoint: 0, level };

  const min = Math.min(...float32Array);
  const max = Math.max(...float32Array);
  const maxVal = level === 'int4' ? 15 : level === 'int8' ? 255 : 65535;

  const scale     = (max - min) / maxVal || 1;
  const zeroPoint = Math.round(-min / scale);

  const TypedArray = level === 'fp16' ? Uint16Array : Uint8Array;
  const quantized  = new TypedArray(float32Array.length);

  for (let i = 0; i < float32Array.length; i++) {
    let q = Math.round(float32Array[i] / scale) + zeroPoint;
    q = Math.max(0, Math.min(maxVal, q));
    quantized[i] = q;
  }

  return { data: quantized, scale, zeroPoint, level };
}

/**
 * Dequantize back to Float32.
 */
function dequantize({ data, scale, zeroPoint, level }) {
  if (level === 'fp32') return data;

  const result = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    result[i] = (data[i] - zeroPoint) * scale;
  }
  return result;
}

// ─── Auto-select best level for a given RAM budget ───────────────────────────

function selectQuantizationLevel(freeRamGb, modelSizeFp32Gb) {
  for (const level of ['int4', 'int8', 'fp16', 'fp32']) {
    const ratio   = BIT_WIDTH.fp32 / BIT_WIDTH[level];
    const needed  = modelSizeFp32Gb / ratio;
    if (needed <= freeRamGb * 0.8) return level; // keep 20% headroom
  }
  return 'int4'; // absolute minimum
}

// ─── Estimate compressed size ─────────────────────────────────────────────────

function estimateCompressedSizeGb(originalSizeGb, level) {
  return originalSizeGb / compressionRatio('fp32', level);
}

// ─── Layer-wise mixed quantization ───────────────────────────────────────────

/**
 * Returns per-layer quantization strategy:
 * - First/last layers: higher precision (int8 / fp16) — they carry semantic meaning
 * - Middle layers: more aggressive (int4)
 */
function mixedPrecisionStrategy(numLayers, freeRamGb, modelSizeFp32Gb) {
  const base = selectQuantizationLevel(freeRamGb, modelSizeFp32Gb);
  const up   = base === 'int4' ? 'int8' : base === 'int8' ? 'fp16' : 'fp32';

  return Array.from({ length: numLayers }, (_, i) => {
    const isEdge = i === 0 || i === numLayers - 1;
    const isNearEdge = i <= 2 || i >= numLayers - 3;
    return { layer: i, quantization: isEdge ? up : isNearEdge ? up : base };
  });
}

module.exports = {
  QUANTIZATION_LEVELS,
  BIT_WIDTH,
  compressionRatio,
  quantize,
  dequantize,
  selectQuantizationLevel,
  estimateCompressedSizeGb,
  mixedPrecisionStrategy,
};
