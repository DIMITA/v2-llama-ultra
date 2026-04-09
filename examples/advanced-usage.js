'use strict';
/**
 * examples/advanced-usage.js
 * Advanced patterns: OpenAI-compat, event listeners, pricing guard, hardware adapt.
 */

const { createClient, selectQuantizationLevel, detectHardware } = require('../src/sdk');
const { isPricingEnabled, checkLimit, PLANS } = require('../src/pricing');

async function main() {
  console.log('LLaMA Ultra — Advanced usage\n');

  // ── 1. Hardware-adaptive setup ───────────────────────────────────────────
  const hw = await detectHardware();
  console.log(`[HW] Profile: ${hw.profile.name} | Free RAM: ${hw.ram.freeGb} GB`);

  const modelSizeFp32Gb = 13; // LLaMA 7B in FP32
  const autoLevel = selectQuantizationLevel(hw.ram.freeGb, modelSizeFp32Gb);
  console.log(`[HW] Auto-selected quantization: ${autoLevel}\n`);

  // ── 2. Client with rich events ───────────────────────────────────────────
  const client = await createClient({ quantization: autoLevel });

  client
    .on('model:load:start', ({ level, sizeFp32Gb, compressedSizeGb }) => {
      console.log(`[Load] Quantizing: ${level} | ${sizeFp32Gb.toFixed(1)} GB → ${compressedSizeGb.toFixed(1)} GB`);
    })
    .on('model:chunk', ({ id, sizeMb }) => {
      process.stdout.write(`\r[Load] Chunk ${id}: ${sizeMb.toFixed(0)} MB        `);
    })
    .on('model:load:done', () => { console.log('\n[Load] Done'); })
    .on('cache:evict', ({ key, sizeMb }) => {
      console.log(`[Cache] Evicted ${key} (${sizeMb.toFixed(1)} MB)`);
    });

  // ── 3. Load model ────────────────────────────────────────────────────────
  const modelPath = process.argv[2] ?? './models/llama-3-7b.gguf';
  try { await client.load(modelPath); }
  catch { console.log('[Demo] Model not found — continuing in demo mode\n'); }

  // ── 4. OpenAI-compatible chat completions ────────────────────────────────
  console.log('[Chat] OpenAI-compatible API:');
  const response = await client.chat.completions.create({
    model:    modelPath,
    messages: [
      { role: 'system', content: 'You are a concise assistant. Reply in 1 sentence.' },
      { role: 'user',   content: 'What is 2 + 2?' },
    ],
    max_tokens: 64,
  });
  console.log(`[Chat] Response: ${response.choices[0].message.content}\n`);

  // ── 5. Pricing guard demo ────────────────────────────────────────────────
  console.log('[Pricing] Enabled:', isPricingEnabled());

  const freeUser = { planId: 'free' };
  const proUser  = { planId: 'pro'  };

  const streamCheck = checkLimit(freeUser, 'streaming');
  console.log(`[Pricing] Free user can stream: ${streamCheck.allowed} (${streamCheck.reason ?? 'ok'})`);

  const proCheck = checkLimit(proUser, 'streaming');
  console.log(`[Pricing] Pro  user can stream: ${proCheck.allowed}`);

  const quantCheck = checkLimit(freeUser, 'quantization', 'fp16');
  console.log(`[Pricing] Free user fp16: ${quantCheck.allowed} (${quantCheck.reason ?? 'ok'})\n`);

  // ── 6. Available plans ───────────────────────────────────────────────────
  console.log('[Plans] Available:');
  for (const [id, plan] of Object.entries(PLANS)) {
    if (id === 'open') continue;
    const price = plan.priceMonthly != null ? `$${plan.priceMonthly}/mo` : 'Custom';
    console.log(`  ${plan.name.padEnd(12)} ${price.padEnd(10)} ${plan.description}`);
  }

  // ── 7. Embeddings ────────────────────────────────────────────────────────
  const vec = await client.embed('Hello, world!');
  console.log(`\n[Embed] Vector dim: ${vec.length}, norm ≈ 1.0`);

  // ── 8. Status & cache stats ───────────────────────────────────────────────
  const status = client.status();
  console.log('\n[Status] Cache:', JSON.stringify(status.cache));

  client.unload();
  console.log('\nDone.');
}

main().catch(err => { console.error(err); process.exit(1); });
