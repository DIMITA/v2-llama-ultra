'use strict';

/**
 * models.js
 * llama-ultra models
 * Lists all available models: from Ollama + from the local registry.
 */

const chalk = require('chalk');
const { loadConfig }  = require('../../config/loader');
const ollamaBackend   = require('../../core/backends/ollama');
const { ModelRegistry } = require('../../migrate/index');

module.exports = function registerModels(program) {
  program
    .command('models')
    .description('List all available models (Ollama + migrated registry)')
    .option('--json', 'Output raw JSON')
    .option('--ollama-only', 'Show only Ollama models')
    .option('--local-only',  'Show only locally registered models')
    .action(async (opts) => {
      const cfg = await loadConfig();

      const results = {
        ollama:   [],
        registry: [],
      };

      // ─── Fetch from Ollama ─────────────────────────────────────────────
      if (!opts.localOnly) {
        const running = await ollamaBackend.isOllamaRunning();
        if (running) {
          try {
            const raw = await ollamaBackend.listModels();
            results.ollama = raw.map(m => ({
              name:         m.name,
              size:         m.size,
              sizeGb:       +(m.size / (1024 ** 3)).toFixed(2),
              modifiedAt:   m.modified_at,
              quantization: inferQuant(m.name),
              source:       'ollama',
            }));
          } catch (err) {
            console.error(chalk.dim(`  Warning: could not list Ollama models: ${err.message}`));
          }
        } else {
          if (!opts.json) console.log(chalk.dim('\n  Ollama not running — skipping Ollama models.'));
        }
      }

      // ─── Fetch from local registry ─────────────────────────────────────
      if (!opts.ollamaOnly) {
        try {
          const reg = new ModelRegistry(cfg.modelsDir);
          results.registry = reg.list().map(m => ({ ...m, source: m.source ?? 'registry' }));
        } catch (_) {}
      }

      // ─── JSON mode ────────────────────────────────────────────────────
      if (opts.json) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }

      // ─── Pretty table ─────────────────────────────────────────────────
      console.log(chalk.bold.cyan('\n  LLaMA Ultra') + chalk.dim(' › models\n'));

      const allModels = [
        ...results.ollama.map(m => ({
          name:   m.name,
          size:   m.sizeGb + ' GB',
          quant:  m.quantization,
          source: chalk.green('ollama'),
          ready:  chalk.green('✓'),
        })),
        ...results.registry.map(m => ({
          name:   m.fullName ?? m.name,
          size:   m.sizeGb ? m.sizeGb + ' GB' : '?',
          quant:  m.quantization ?? '?',
          source: chalk.blue(m.source ?? 'local'),
          ready:  chalk.green('✓'),
        })),
      ];

      if (allModels.length === 0) {
        console.log(chalk.dim('  No models found.\n'));
        console.log(chalk.dim('  Pull a model : ') + chalk.white('llama-ultra pull llama3'));
        console.log(chalk.dim('  Migrate local: ') + chalk.white('llama-ultra migrate --all') + '\n');
        return;
      }

      // Column widths
      const maxName  = Math.min(40, Math.max(12, ...allModels.map(m => stripAnsi(m.name).length)));
      const maxSize  = Math.max(8,  ...allModels.map(m => m.size.length));
      const maxQuant = Math.max(6,  ...allModels.map(m => (m.quant ?? '?').length));

      console.log(
        '  ' +
        chalk.dim('NAME'.padEnd(maxName + 2)) +
        chalk.dim('SIZE'.padEnd(maxSize + 2)) +
        chalk.dim('QUANT'.padEnd(maxQuant + 2)) +
        chalk.dim('SOURCE')
      );
      console.log('  ' + chalk.dim('─'.repeat(maxName + maxSize + maxQuant + 18)));

      for (const m of allModels) {
        console.log(
          '  ' +
          chalk.white(stripAnsi(m.name).padEnd(maxName + 2)) +
          chalk.dim(m.size.padEnd(maxSize + 2)) +
          chalk.dim((m.quant ?? '?').padEnd(maxQuant + 2)) +
          m.source
        );
      }

      console.log('');
      console.log(chalk.dim(`  Total: ${allModels.length} model(s)\n`));
      console.log(chalk.dim('  Run  : ') + chalk.white('llama-ultra run <name>'));
      console.log(chalk.dim('  Pull : ') + chalk.white('llama-ultra pull <name>\n'));
    });
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function inferQuant(name) {
  const n = name.toLowerCase();
  if (n.includes('q4')) return 'int4';
  if (n.includes('q8')) return 'int8';
  if (n.includes('f16') || n.includes('fp16')) return 'fp16';
  if (n.includes('f32') || n.includes('fp32')) return 'fp32';
  return 'unknown';
}

// Strip ANSI escape codes for length calculation
function stripAnsi(str) {
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}
