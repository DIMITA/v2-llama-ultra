'use strict';

/**
 * transcribe.js
 * llama-ultra transcribe <audio-file>
 *
 * Transcribe audio using, in priority order:
 *   1. Ollama whisper model (if available)
 *   2. Local whisper-cpp binary
 *   3. Local whisper Python CLI
 *   4. OpenAI Whisper API (if OPENAI_API_KEY is set)
 */

const fs    = require('fs');
const path  = require('path');
const http  = require('http');
const https = require('https');
const { execFile, execFileSync } = require('child_process');
const chalk = require('chalk');
const { DEFAULT_HOST } = require('../../core/backends/ollama');

const SUPPORTED_FORMATS = ['.wav', '.mp3', '.m4a', '.ogg', '.flac', '.webm', '.mp4'];
const WHISPER_MODELS    = ['whisper', 'openai-whisper', 'whisper3', 'whisper:large'];

module.exports = function registerTranscribe(program) {
  program
    .command('transcribe <file>')
    .description('Transcribe audio to text (uses Whisper via Ollama, local binary, or OpenAI API)')
    .option('--model <model>',   'Whisper model name (for Ollama backend)', 'whisper')
    .option('--backend <name>',  'Force backend: ollama | local | openai')
    .option('--language <lang>', 'Language hint (e.g. en, fr, es)')
    .option('--output <file>',   'Write transcript to file instead of stdout')
    .option('--json',            'Output full JSON result')
    .action(async (file, opts) => {
      // ─── Validate input ─────────────────────────────────────────────────
      const absFile = path.resolve(file);
      if (!fs.existsSync(absFile)) {
        console.error(chalk.red(`\n  File not found: ${absFile}\n`));
        process.exit(1);
      }
      const ext = path.extname(absFile).toLowerCase();
      if (!SUPPORTED_FORMATS.includes(ext)) {
        console.error(chalk.red(`\n  Unsupported format: ${ext}`));
        console.error(chalk.dim(`  Supported: ${SUPPORTED_FORMATS.join(', ')}\n`));
        process.exit(1);
      }

      console.log(chalk.bold.cyan('\n  LLaMA Ultra') + chalk.dim(' › transcribe'));
      console.log(chalk.dim(`  File     : ${absFile}`));
      console.log(chalk.dim(`  Format   : ${ext}\n`));

      let result;
      const backend = opts.backend;

      try {
        if (backend === 'openai' || (!backend && process.env.OPENAI_API_KEY && !await isOllamaWhisperAvailable(opts.model))) {
          result = await transcribeOpenAI(absFile, opts);
        } else if (backend === 'local' || (!backend && !await isOllamaWhisperAvailable(opts.model) && hasLocalWhisper())) {
          result = await transcribeLocal(absFile, opts);
        } else {
          result = await transcribeOllama(absFile, opts);
        }
      } catch (err) {
        console.error(chalk.red('\n  Transcription failed: ' + err.message));
        console.error(chalk.dim('\n  Tips:'));
        console.error(chalk.dim('  • Pull whisper in Ollama : ollama pull whisper'));
        console.error(chalk.dim('  • Install whisper.cpp    : brew install whisper-cpp'));
        console.error(chalk.dim('  • Set OPENAI_API_KEY     : for cloud transcription\n'));
        process.exit(1);
      }

      // ─── Output ───────────────────────────────────────────────────────
      const output = opts.json ? JSON.stringify(result, null, 2) : result.text;

      if (opts.output) {
        fs.writeFileSync(path.resolve(opts.output), output + '\n');
        console.log(chalk.green(`  Saved to: ${opts.output}\n`));
      } else {
        console.log('\n' + chalk.white(result.text) + '\n');
        if (result.language) console.log(chalk.dim(`  Language : ${result.language}`));
        if (result.duration) console.log(chalk.dim(`  Duration : ${result.duration}s`));
        if (result.backend)  console.log(chalk.dim(`  Backend  : ${result.backend}\n`));
      }
    });
};

// ─── Backends ─────────────────────────────────────────────────────────────────

async function isOllamaWhisperAvailable(model) {
  // Check if the whisper model is pulled in Ollama
  return new Promise(resolve => {
    const url = new URL('/api/tags', DEFAULT_HOST);
    http.get({ hostname: url.hostname, port: url.port || 11434, path: url.pathname, timeout: 2000 }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const models = (json.models ?? []).map(m => m.name);
          resolve(models.some(m => m.startsWith('whisper') || m === model));
        } catch { resolve(false); }
      });
    }).on('error', () => resolve(false)).on('timeout', function() { this.destroy(); resolve(false); });
  });
}

function hasLocalWhisper() {
  for (const bin of ['whisper-cpp', 'whisper', 'main']) {
    try { execFileSync('which', [bin], { stdio: 'ignore' }); return true; } catch (_) {}
  }
  return false;
}

async function transcribeOllama(filePath, opts) {
  // Ollama whisper endpoint: POST /api/generate with audio file as base64
  const audioData = fs.readFileSync(filePath).toString('base64');
  const model     = opts.model ?? 'whisper';

  process.stdout.write(chalk.dim('  Using backend: ollama\n'));

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      prompt: '',
      images: [audioData],  // Ollama multimodal format
      stream: false,
      options: opts.language ? { language: opts.language } : {},
    });

    const url = new URL('/api/generate', DEFAULT_HOST);
    const req = http.request({
      hostname: url.hostname, port: url.port || 11434,
      path: '/api/generate', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode !== 200) return reject(new Error(`Ollama ${res.statusCode}: ${data}`));
          resolve({ text: json.response ?? '', backend: 'ollama', language: opts.language });
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function transcribeLocal(filePath, opts) {
  // Try whisper-cpp first, then python whisper CLI
  const bins = ['whisper-cpp', 'whisper'];
  let bin = null;
  for (const b of bins) {
    try { execFileSync('which', [b], { stdio: 'ignore' }); bin = b; break; } catch (_) {}
  }
  if (!bin) throw new Error('No local whisper binary found');

  process.stdout.write(chalk.dim(`  Using backend: local (${bin})\n`));

  return new Promise((resolve, reject) => {
    const args = [filePath, '--output_format', 'txt', '--output_dir', '/tmp'];
    if (opts.language) args.push('--language', opts.language);
    if (opts.model && opts.model !== 'whisper') args.push('--model', opts.model);

    execFile(bin, args, { timeout: 120_000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));

      // whisper writes a .txt file
      const txtPath = path.join('/tmp', path.basename(filePath, path.extname(filePath)) + '.txt');
      const text = fs.existsSync(txtPath)
        ? fs.readFileSync(txtPath, 'utf8').trim()
        : stdout.trim();

      resolve({ text, backend: `local:${bin}`, language: opts.language });
    });
  });
}

async function transcribeOpenAI(filePath, opts) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY environment variable not set');

  process.stdout.write(chalk.dim('  Using backend: openai (whisper-1)\n'));

  // Multipart form upload to OpenAI
  return new Promise((resolve, reject) => {
    const boundary  = '----LlamaUltraBoundary' + Date.now();
    const fileData  = fs.readFileSync(filePath);
    const filename  = path.basename(filePath);
    const mimeType  = mimeForExt(path.extname(filePath));

    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`),
      ...(opts.language ? [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${opts.language}\r\n`)] : []),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`),
      fileData,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const req = https.request({
      hostname: 'api.openai.com', port: 443,
      path: '/v1/audio/transcriptions', method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode !== 200) return reject(new Error(`OpenAI ${res.statusCode}: ${data}`));
          resolve({ text: json.text ?? '', backend: 'openai', language: json.language, duration: json.duration });
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function mimeForExt(ext) {
  return { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
           '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.webm': 'audio/webm',
           '.mp4': 'video/mp4' }[ext] ?? 'application/octet-stream';
}
