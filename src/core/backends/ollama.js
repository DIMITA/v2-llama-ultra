'use strict';

/**
 * backends/ollama.js
 * Real inference via Ollama HTTP API.
 * Streams tokens as they arrive — no mock, no echo.
 *
 * Ollama API used:
 *   POST http://localhost:11434/api/generate   (completion)
 *   POST http://localhost:11434/api/chat       (chat)
 *   GET  http://localhost:11434/api/tags       (list models)
 */

const http = require('http');
const os   = require('os');

const DEFAULT_HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434';

// ─── Connectivity check ───────────────────────────────────────────────────────

async function isOllamaRunning(host = DEFAULT_HOST) {
  return new Promise(resolve => {
    const url = new URL('/api/tags', host);
    const req = http.get({ hostname: url.hostname, port: url.port || 11434, path: url.pathname, timeout: 2000 }, res => {
      resolve(res.statusCode === 200);
    });
    req.on('error',   () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// ─── List models available in Ollama ─────────────────────────────────────────

async function listModels(host = DEFAULT_HOST) {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/tags', host);
    http.get({ hostname: url.hostname, port: url.port || 11434, path: url.pathname }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data).models ?? []); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ─── Streaming generate ───────────────────────────────────────────────────────

/**
 * Calls POST /api/chat with streaming=true.
 * Yields string tokens via the returned async generator.
 *
 * @param {object} params
 * @param {string}   params.model      - Ollama model name (e.g. 'deepseek-coder-v2:latest')
 * @param {Array}    params.messages   - [{role, content}]
 * @param {object}   params.options    - Ollama model params (temperature, num_predict…)
 * @param {string}   params.host       - Ollama base URL
 * @param {Function} params.onToken    - called with each string token
 * @param {AbortSignal} params.signal  - to cancel mid-stream
 * @returns {Promise<{totalTokens: number, evalDuration: number}>}
 */
async function streamChat({ model, messages, options = {}, host = DEFAULT_HOST, onToken, signal }) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      messages,
      stream:  true,
      options: {
        num_predict: options.maxTokens ?? 2048,
        temperature: options.temperature ?? 0.7,
        top_p:       options.topP ?? 0.9,
        ...options.raw,
      },
    });

    const url = new URL('/api/chat', host);
    const req = http.request({
      hostname: url.hostname,
      port:     url.port || 11434,
      path:     '/api/chat',
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      if (res.statusCode !== 200) {
        let err = '';
        res.on('data', c => { err += c; });
        res.on('end',  () => reject(new Error(`Ollama ${res.statusCode}: ${err}`)));
        return;
      }

      let buffer     = '';
      let totalTokens = 0;
      let evalDuration = 0;

      res.on('data', chunk => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const json = JSON.parse(line);
            const token = json.message?.content ?? '';
            if (token) { onToken(token); totalTokens++; }
            if (json.done) {
              evalDuration = json.eval_duration ?? 0;
              resolve({ totalTokens, evalDuration });
            }
          } catch (_) {}
        }
      });

      res.on('end', () => resolve({ totalTokens, evalDuration }));
      res.on('error', reject);
    });

    req.on('error', reject);

    // Handle abort
    if (signal) {
      signal.addEventListener('abort', () => { req.destroy(); reject(new Error('Aborted')); });
    }

    req.write(body);
    req.end();
  });
}

// ─── Simple (non-chat) generate ───────────────────────────────────────────────

async function streamGenerate({ model, prompt, options = {}, host = DEFAULT_HOST, onToken, signal }) {
  return streamChat({
    model,
    messages: [{ role: 'user', content: prompt }],
    options, host, onToken, signal,
  });
}

module.exports = { isOllamaRunning, listModels, streamChat, streamGenerate, DEFAULT_HOST };
