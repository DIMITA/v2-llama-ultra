'use strict';

/**
 * vision.js
 * llama-ultra vision <image> [prompt]
 *
 * Multimodal inference — send an image + text prompt to a vision-capable
 * Ollama model (llava, moondream, bakllava, llava-phi3, etc.)
 *
 * Ollama multimodal API: POST /api/chat with images array (base64).
 */

const fs    = require('fs');
const path  = require('path');
const http  = require('http');
const chalk = require('chalk');
const { DEFAULT_HOST } = require('../../core/backends/ollama');

const SUPPORTED_IMAGE_FORMATS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
const DEFAULT_VISION_MODELS   = ['llava', 'moondream', 'llava-phi3', 'bakllava', 'llava:13b'];

module.exports = function registerVision(program) {
  program
    .command('vision <image> [prompt]')
    .description('Multimodal image analysis (llava, moondream, bakllava…)')
    .option('-m, --model <model>',        'Vision model to use (default: auto-detect)')
    .option('-t, --max-tokens <n>',       'Max output tokens', '1024')
    .option('--temperature <n>',          'Temperature (0–2)', '0.7')
    .option('--system <prompt>',          'System prompt')
    .option('--host <url>',              'Ollama base URL', DEFAULT_HOST)
    .action(async (image, prompt, opts) => {
      // ─── Validate image ────────────────────────────────────────────────
      const absImage = path.resolve(image);
      if (!fs.existsSync(absImage)) {
        console.error(chalk.red(`\n  Image not found: ${absImage}\n`));
        process.exit(1);
      }
      const ext = path.extname(absImage).toLowerCase();
      if (!SUPPORTED_IMAGE_FORMATS.includes(ext)) {
        console.error(chalk.red(`\n  Unsupported format: ${ext}`));
        console.error(chalk.dim(`  Supported: ${SUPPORTED_IMAGE_FORMATS.join(', ')}\n`));
        process.exit(1);
      }

      const userPrompt = prompt ?? 'Describe this image in detail.';
      const host       = opts.host;

      console.log(chalk.bold.cyan('\n  LLaMA Ultra') + chalk.dim(' › vision'));
      console.log(chalk.dim(`  Image  : ${path.basename(absImage)}`));
      console.log(chalk.dim(`  Prompt : ${userPrompt}\n`));

      // ─── Pick model ────────────────────────────────────────────────────
      let model = opts.model;
      if (!model) {
        model = await detectVisionModel(host);
        if (!model) {
          console.error(chalk.red('  No vision model found in Ollama.\n'));
          console.error(chalk.dim('  Pull one with:'));
          for (const m of DEFAULT_VISION_MODELS.slice(0, 3)) {
            console.error(chalk.dim(`    ollama pull ${m}`));
          }
          console.error('');
          process.exit(1);
        }
        console.log(chalk.dim(`  Model  : ${model} (auto-detected)\n`));
      } else {
        console.log(chalk.dim(`  Model  : ${model}\n`));
      }

      // ─── Encode image ──────────────────────────────────────────────────
      const imageBase64 = fs.readFileSync(absImage).toString('base64');

      // ─── Run inference ─────────────────────────────────────────────────
      process.stdout.write(chalk.yellow('AI  > '));

      try {
        const { totalTokens, evalDuration } = await visionChat({
          model,
          imageBase64,
          prompt:      userPrompt,
          system:      opts.system,
          maxTokens:   parseInt(opts.maxTokens, 10),
          temperature: parseFloat(opts.temperature),
          host,
          onToken: token => process.stdout.write(token),
        });

        const tps = evalDuration > 0
          ? (totalTokens / (evalDuration / 1e9)).toFixed(1)
          : '?';

        process.stdout.write(chalk.dim(`\n\n  [${totalTokens} tok · ${tps} t/s · ${model}]\n\n`));
      } catch (err) {
        console.error(chalk.red('\n  Error: ' + err.message));
        if (err.message.includes('ECONNREFUSED')) {
          console.error(chalk.dim('  Make sure Ollama is running: ollama serve\n'));
        }
        process.exit(1);
      }
    });
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function detectVisionModel(host) {
  return new Promise(resolve => {
    const url = new URL('/api/tags', host);
    http.get({ hostname: url.hostname, port: url.port || 11434, path: url.pathname, timeout: 2000 }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const models = JSON.parse(data).models ?? [];
          const names  = models.map(m => m.name);
          const found  = DEFAULT_VISION_MODELS.find(m => names.some(n => n.startsWith(m)));
          resolve(found ?? names.find(n => n.includes('llava') || n.includes('vision') || n.includes('moon')) ?? null);
        } catch { resolve(null); }
      });
    }).on('error', () => resolve(null)).on('timeout', function() { this.destroy(); resolve(null); });
  });
}

function visionChat({ model, imageBase64, prompt, system, maxTokens, temperature, host, onToken }) {
  return new Promise((resolve, reject) => {
    const messages = [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: prompt, images: [imageBase64] },
    ];

    const body = JSON.stringify({
      model,
      messages,
      stream: true,
      options: { num_predict: maxTokens, temperature },
    });

    const url = new URL('/api/chat', host);
    const req = http.request({
      hostname: url.hostname, port: url.port || 11434,
      path: '/api/chat', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      if (res.statusCode !== 200) {
        let err = '';
        res.on('data', c => { err += c; });
        res.on('end', () => reject(new Error(`Ollama ${res.statusCode}: ${err}`)));
        return;
      }

      let buffer = '', totalTokens = 0, evalDuration = 0;

      res.on('data', chunk => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
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
    req.write(body);
    req.end();
  });
}
