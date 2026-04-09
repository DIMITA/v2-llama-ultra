'use strict';

/**
 * pull.js
 * llama-ultra pull <model>
 * Downloads a model via Ollama (POST /api/pull) with live progress.
 */

const http  = require('http');
const chalk = require('chalk');
const { DEFAULT_HOST } = require('../../core/backends/ollama');

module.exports = function registerPull(program) {
  program
    .command('pull <model>')
    .description('Pull a model from Ollama registry (e.g. llama3, deepseek-coder-v2:latest)')
    .option('--host <url>', 'Ollama base URL', DEFAULT_HOST)
    .action(async (model, opts) => {
      const host = opts.host;

      console.log(chalk.bold.cyan('\n  LLaMA Ultra') + chalk.dim(' › pull'));
      console.log(chalk.dim(`  Pulling ${chalk.white(model)} via Ollama…\n`));

      try {
        await pullModel(model, host);
      } catch (err) {
        console.error(chalk.red('\n  Error: ' + err.message));
        if (err.message.includes('ECONNREFUSED')) {
          console.error(chalk.dim('  Make sure Ollama is running: ollama serve\n'));
        }
        process.exit(1);
      }
    });
};

// ─── Pull implementation ───────────────────────────────────────────────────────

function pullModel(model, host = DEFAULT_HOST) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model, stream: true });
    const url  = new URL('/api/pull', host);

    const req = http.request({
      hostname: url.hostname,
      port:     url.port || 11434,
      path:     '/api/pull',
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      if (res.statusCode !== 200) {
        let errBody = '';
        res.on('data', c => { errBody += c; });
        res.on('end',  () => reject(new Error(`Ollama ${res.statusCode}: ${errBody}`)));
        return;
      }

      let buffer        = '';
      let lastStatus    = '';
      let lastPct       = -1;
      let totalBytes    = 0;

      res.on('data', chunk => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const json = JSON.parse(line);

            const status    = json.status ?? '';
            const completed = json.completed ?? 0;
            const total     = json.total ?? 0;
            totalBytes = total || totalBytes;

            if (status !== lastStatus) {
              if (lastPct >= 0) process.stdout.write('\n');
              lastStatus = status;
              lastPct = -1;
            }

            if (total > 0 && completed > 0) {
              const pct  = Math.round((completed / total) * 100);
              const bar  = progressBar(pct, 30);
              const mb   = (completed / (1024 ** 2)).toFixed(0);
              const mbT  = (total / (1024 ** 2)).toFixed(0);
              process.stdout.write(
                `\r  ${chalk.dim(status.padEnd(25))} ${bar} ${chalk.green(pct + '%')} ${chalk.dim(`${mb}/${mbT} MB`)}`
              );
              lastPct = pct;
            } else {
              process.stdout.write(`\r  ${chalk.dim(status)}`);
            }

            if (json.status === 'success') {
              process.stdout.write('\n');
              console.log(chalk.green(`\n  Model "${model}" pulled successfully.\n`));
              console.log(chalk.dim(`  Run it with: ${chalk.white('llama-ultra run ' + model)}\n`));
              resolve();
            }
          } catch (_) {}
        }
      });

      res.on('end', () => {
        if (lastPct >= 0) process.stdout.write('\n');
        resolve();
      });
      res.on('error', reject);
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function progressBar(pct, width) {
  const filled = Math.round((pct / 100) * width);
  const empty  = width - filled;
  return chalk.cyan('█'.repeat(filled)) + chalk.dim('░'.repeat(empty));
}
