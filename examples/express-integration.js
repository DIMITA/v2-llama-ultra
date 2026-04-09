'use strict';
/**
 * examples/express-integration.js
 * Embed LLaMA Ultra directly into an Express app with SSE streaming.
 */

const express  = require('express');
const { createClient } = require('../src/sdk');
const { setupSSE }     = require('../src/core/streaming');

const app = express();
app.use(express.json());

let client = null;

// Init once on startup
async function init() {
  client = await createClient({ quantization: 'auto' });
  console.log('LLaMA Ultra ready');
}

// POST /chat — returns full JSON
app.post('/chat', async (req, res) => {
  const { prompt, model } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  if (!client.status().loadedModel) await client.load(model ?? './models/llama-3-7b.gguf');

  const text = await client.generate(prompt, { maxTokens: 512 });
  res.json({ text });
});

// GET /chat/stream?prompt=... — SSE stream
app.get('/chat/stream', async (req, res) => {
  const { prompt, model } = req.query;
  if (!prompt) return res.status(400).json({ error: 'prompt query param required' });

  const sse = setupSSE(req, res);

  if (!client.status().loadedModel) await client.load(model ?? './models/llama-3-7b.gguf');

  const stream = client.stream(prompt, { maxTokens: 512 });
  stream.on('data',         token => sse.send({ token }));
  stream.on('stream:done',  ()    => sse.done());
  stream.on('error',        err   => sse.error(err.message));
});

init().then(() => {
  app.listen(4000, () => console.log('http://localhost:4000'));
}).catch(err => { console.error(err); process.exit(1); });
