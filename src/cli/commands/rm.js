'use strict';

/**
 * rm.js
 * llama-ultra rm <model>
 * Remove a model from the local registry, and optionally delete the file.
 */

const fs    = require('fs');
const path  = require('path');
const chalk = require('chalk');
const readline = require('readline');
const { loadConfig }    = require('../../config/loader');
const { ModelRegistry } = require('../../migrate/index');

module.exports = function registerRm(program) {
  program
    .command('rm <model>')
    .description('Remove a model from the registry (optionally delete the file)')
    .option('--delete-file', 'Also delete the model file from disk')
    .option('-y, --yes',     'Skip confirmation prompt')
    .action(async (model, opts) => {
      const cfg = await loadConfig();
      const reg = new ModelRegistry(cfg.modelsDir);
      const entries = reg.list();

      // Find matching entry (by name, fullName, id, or path basename)
      const entry = entries.find(m =>
        m.name        === model ||
        m.fullName    === model ||
        m.id          === model ||
        m.name?.toLowerCase()     === model.toLowerCase() ||
        m.fullName?.toLowerCase() === model.toLowerCase() ||
        path.basename(m.path) === model ||
        path.basename(m.path, '.gguf') === model
      );

      if (!entry) {
        console.log(chalk.red(`\n  Model not found in registry: "${model}"\n`));
        console.log(chalk.dim('  Run ') + chalk.white('llama-ultra models') + chalk.dim(' to see available models.\n'));
        process.exit(1);
      }

      console.log(chalk.bold.cyan('\n  LLaMA Ultra') + chalk.dim(' › rm\n'));
      console.log(`  ${chalk.bold('Name')}   : ${entry.fullName ?? entry.name}`);
      console.log(`  ${chalk.bold('Source')} : ${entry.source}`);
      console.log(`  ${chalk.bold('Path')}   : ${entry.path}`);
      console.log(`  ${chalk.bold('Size')}   : ${entry.sizeGb ?? '?'} GB`);

      if (opts.deleteFile && fs.existsSync(entry.path)) {
        const stat = fs.statSync(entry.path);
        console.log(chalk.yellow(`\n  WARNING: This will also delete ${(stat.size / (1024 ** 3)).toFixed(2)} GB from disk.\n`));
      } else {
        console.log(chalk.dim('\n  Only removing from registry (file kept on disk).\n'));
      }

      // Confirm unless --yes
      if (!opts.yes) {
        const confirmed = await confirm(`  Confirm removal of "${entry.fullName ?? entry.name}"? [y/N] `);
        if (!confirmed) {
          console.log(chalk.dim('\n  Cancelled.\n'));
          return;
        }
      }

      // Remove from registry
      reg._data.models = reg._data.models.filter(m => m.id !== entry.id);
      reg.save();
      console.log(chalk.green(`\n  Removed "${entry.fullName ?? entry.name}" from registry.`));

      // Optionally delete file
      if (opts.deleteFile) {
        if (entry.mode === 'symlink' || entry.mode === 'link' || entry.mode === 'inplace') {
          console.log(chalk.dim(`  Skipping file deletion — mode is "${entry.mode}" (original may be in use by another tool).`));
        } else if (fs.existsSync(entry.path)) {
          fs.unlinkSync(entry.path);
          console.log(chalk.green(`  Deleted file: ${entry.path}`));
        }
      }

      console.log('');
    });
};

// ─── Helper ───────────────────────────────────────────────────────────────────

function confirm(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}
