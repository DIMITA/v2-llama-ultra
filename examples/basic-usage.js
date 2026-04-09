'use strict';
/**
 * examples/basic-usage.js
 * Demonstrates the core SDK usage patterns.
 * Run: node examples/basic-usage.js
 */

const { createClient } = require('../src/sdk');

async function main() {
  console.log('LLaMA Ultra — Basic usage example\n');

  // 1. Create client (auto-detects hardware)
  const client = await createClient({
    modelsDir:    './models',
    quantization: 'auto',   // picks best level for your RAM
  });

  // 2. Show hardware profile
  const hw = await client.hardware();
  console.log('Hardware profile:');
  console.log(`  CPU     : ${hw.cpu.model} (${hw.cpu.cores} cores)`);
  console.log(`  RAM     : ${hw.ram.freeGb} GB free / ${hw.ram.totalGb} GB total`);
  console.log(`  Profile : ${hw.profile.name} → ${hw.profile.quantization}\n`);

  // 3. Load a model
  // Replace with a real model path — this example uses a placeholder
  const modelPath = process.argv[2] ?? './models/example.gguf';
  console.log(`Loading model: ${modelPath}`);

  try {
    await client.load(modelPath);
    console.log('Model loaded!\n');
  } catch (err) {
    console.log(`(Model not found at ${modelPath} — running in demo mode)\n`);
    // In demo mode the engine still works but returns mock output
  }

  // 4. Generate text (await full response)
  const prompt = 'Explain quantum entanglement in 2 sentences.';
  console.log(`Prompt: ${prompt}`);
  console.log('Response:');

  const text = await client.generate(prompt, { maxTokens: 256 });
  console.log(text);
  console.log();

  // 5. Stream tokens
  console.log('Streaming response:');
  console.log('---');
  const stream = client.stream('Count from 1 to 10, each number on its own line.', { maxTokens: 64 });
  stream.on('data', tok => process.stdout.write(tok));
  await new Promise(r => stream.on('end', r));
  console.log('\n---');

  // 6. Status
  const status = client.status();
  console.log('\nCache stats:', status.cache);

  client.unload();
  console.log('\nDone.');
}

main().catch(err => { console.error(err); process.exit(1); });
