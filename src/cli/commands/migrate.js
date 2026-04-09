'use strict';

/**
 * migrate command
 * Scans Ollama, llama.cpp, LM Studio, Jan, GPT4All and lets the user
 * pick which models to import into LLaMA Ultra.
 *
 * Usage:
 *   llama-ultra migrate                         # interactive
 *   llama-ultra migrate --all                   # migrate everything found
 *   llama-ultra migrate --source ollama         # only Ollama models
 *   llama-ultra migrate --mode symlink          # don't copy, just symlink
 *   llama-ultra migrate --scan-dir ~/custom     # extra search dir
 *   llama-ultra migrate --list                  # list already-migrated models
 */

const chalk = require('chalk');
const ora   = require('ora');
const Table = require('cli-table3');
const readline = require('readline');
const { Migrator, SOURCE_ICONS } = require('../../migrate');
const { loadConfig } = require('../../config/loader');

module.exports = function registerMigrate(program) {
  program
    .command('migrate')
    .description('Import models from Ollama, llama.cpp, LM Studio, Jan, GPT4All')
    .option('--all',                  'Migrate all discovered models without prompting')
    .option('--source <src>',         'Filter by source: ollama | llamacpp | lmstudio | jan | gpt4all')
    .option('--mode <mode>',          'Transfer mode: copy | link | symlink | move | inplace', 'link')
    .option('--scan-dir <dir>',       'Extra directory to scan for .gguf files')
    .option('--models-dir <dir>',     'Override destination models directory')
    .option('--list',                 'List already-migrated models and exit')
    .option('--dry-run',              'Show what would happen without making any changes')
    .action(async (opts) => {
      const cfg = loadConfig();

      const migrator = new Migrator({
        modelsDir:      opts.modelsDir ?? cfg.modelsDir,
        mode:           opts.mode,
        extraScanDirs:  opts.scanDir ? [opts.scanDir] : [],
      });

      // ── List migrated ────────────────────────────────────────────────────
      if (opts.list) {
        const migrated = migrator.listMigrated();
        if (migrated.length === 0) {
          console.log(chalk.dim('\n  No models migrated yet.\n'));
          return;
        }
        const table = new Table({
          head: [chalk.dim('Name'), chalk.dim('Source'), chalk.dim('Size'), chalk.dim('Quant'), chalk.dim('Path')],
          style: { head: [], border: ['dim'] },
          colWidths: [30, 12, 8, 8, 50],
        });
        for (const m of migrated) {
          table.push([
            m.name.slice(0, 28),
            `${SOURCE_ICONS[m.source] ?? '📦'} ${m.source}`,
            `${m.sizeGb} GB`,
            m.quantization,
            chalk.dim(m.path.slice(0, 48)),
          ]);
        }
        console.log(chalk.bold.cyan('\n  Migrated models\n'));
        console.log(table.toString());
        console.log();
        return;
      }

      // ── Scan ─────────────────────────────────────────────────────────────
      const spinner = ora('Scanning for models…').start();

      migrator.on('scan:start', () => { spinner.text = 'Scanning Ollama, llama.cpp, LM Studio…'; });

      let allModels;
      try {
        allModels = await migrator.scan();
      } catch (err) {
        spinner.fail(chalk.red('Scan failed: ' + err.message));
        process.exit(1);
      }

      spinner.stop();

      // Filter by source if requested
      if (opts.source) {
        allModels = allModels.filter(m => m.source === opts.source);
      }

      if (allModels.length === 0) {
        console.log(chalk.yellow('\n  No models found.\n'));
        printSearchPaths();
        return;
      }

      // ── Display found models ──────────────────────────────────────────────
      printFoundTable(allModels);

      // Count already migrated
      const newModels = allModels.filter(m => !m.alreadyMigrated && m.available);
      const migrated  = allModels.filter(m => m.alreadyMigrated);
      const unavail   = allModels.filter(m => !m.available);

      if (migrated.length > 0) {
        console.log(chalk.dim(`  ${migrated.length} already migrated (skipped).`));
      }
      if (unavail.length > 0) {
        console.log(chalk.dim(`  ${unavail.length} unavailable (blob missing).`));
      }

      if (newModels.length === 0) {
        console.log(chalk.green('\n  All available models are already migrated.\n'));
        return;
      }

      // ── Select models ─────────────────────────────────────────────────────
      let toMigrate;

      if (opts.all) {
        toMigrate = newModels;
        console.log(chalk.cyan(`\n  Migrating all ${toMigrate.length} new models…\n`));
      } else {
        toMigrate = await promptSelection(newModels);
      }

      if (!toMigrate || toMigrate.length === 0) {
        console.log(chalk.dim('\n  Nothing selected. Exiting.\n'));
        return;
      }

      // ── Dry run ───────────────────────────────────────────────────────────
      if (opts.dryRun) {
        console.log(chalk.yellow('\n  [Dry run] Would migrate:\n'));
        for (const m of toMigrate) {
          const src = m.filePath ?? m.blobPath;
          console.log(`  ${SOURCE_ICONS[m.source] ?? '📦'} ${m.displayName}  ${chalk.dim(src)}`);
        }
        console.log(chalk.dim(`\n  Mode: ${opts.mode}  |  Destination: ${migrator.modelsDir}\n`));
        return;
      }

      // ── Run migration ─────────────────────────────────────────────────────
      console.log(chalk.bold(`\n  Migrating ${toMigrate.length} model(s)  |  mode: ${chalk.cyan(opts.mode)}\n`));
      console.log(chalk.dim(`  Destination: ${migrator.modelsDir}\n`));

      const modeSpinner = {};
      migrator.on('model:start',    ({ model }) => {
        modeSpinner[model.id] = ora(`  ${SOURCE_ICONS[model.source] ?? ''} ${model.displayName}`).start();
      });
      migrator.on('model:progress', ({ model, pct }) => {
        if (modeSpinner[model.id]) modeSpinner[model.id].text = `  ${model.displayName} — ${pct}%`;
      });
      migrator.on('model:done',     ({ model, destPath }) => {
        if (modeSpinner[model.id]) {
          modeSpinner[model.id].succeed(
            `${SOURCE_ICONS[model.source] ?? ''} ${chalk.green(model.displayName)}  ` +
            chalk.dim(`→ ${destPath}`)
          );
        }
      });
      migrator.on('model:skip',     ({ model, reason }) => {
        if (modeSpinner[model.id]) {
          modeSpinner[model.id].info(chalk.dim(`${model.displayName} — ${reason}`));
        }
      });
      migrator.on('model:error',    ({ model, err }) => {
        if (modeSpinner[model.id]) {
          modeSpinner[model.id].fail(chalk.red(`${model.displayName} — ${err.message}`));
        }
      });

      const results = await migrator.migrate(toMigrate);

      const ok   = results.filter(r => r.success);
      const fail = results.filter(r => !r.success);

      console.log();
      if (ok.length)   console.log(chalk.green(`  ✓ ${ok.length} model(s) migrated successfully`));
      if (fail.length) console.log(chalk.red(`  ✗ ${fail.length} model(s) failed`));

      console.log(chalk.dim(`\n  Models directory: ${migrator.modelsDir}`));
      console.log(chalk.dim('  Run \'llama-ultra migrate --list\' to see all migrated models.'));
      console.log(chalk.dim('  Run \'llama-ultra run <model>\' to start chatting.\n'));
    });
};

// ─── Print found table ────────────────────────────────────────────────────────

function printFoundTable(models) {
  console.log(chalk.bold.cyan('\n  Found models\n'));

  const table = new Table({
    head: ['#', chalk.dim('Model'), chalk.dim('Source'), chalk.dim('Size'), chalk.dim('Quant'), chalk.dim('Status')].map(h => h),
    style: { head: [], border: ['dim'] },
    colWidths: [4, 38, 12, 8, 8, 14],
  });

  models.forEach((m, i) => {
    const status = m.alreadyMigrated
      ? chalk.green('✓ migrated')
      : !m.available
        ? chalk.red('✗ missing')
        : chalk.cyan('ready');

    table.push([
      String(i + 1),
      m.displayName.slice(0, 36),
      `${SOURCE_ICONS[m.source] ?? '📦'} ${m.source}`,
      `${m.sizeGb} GB`,
      m.quantization,
      status,
    ]);
  });

  console.log(table.toString());
}

// ─── Interactive selection ────────────────────────────────────────────────────

async function promptSelection(models) {
  console.log(chalk.bold(`\n  Select models to migrate:`));
  console.log(chalk.dim('  Enter numbers separated by commas (e.g. 1,3), \'all\', or \'none\'\n'));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return new Promise(resolve => {
    rl.question(chalk.green('  > '), answer => {
      rl.close();
      const input = answer.trim().toLowerCase();
      if (input === 'all')  return resolve(models);
      if (input === 'none' || input === '') return resolve([]);

      const indices = input.split(',')
        .map(s => parseInt(s.trim(), 10) - 1)
        .filter(i => !isNaN(i) && i >= 0 && i < models.length);

      resolve(indices.map(i => models[i]));
    });
  });
}

// ─── Search paths hint ────────────────────────────────────────────────────────

function printSearchPaths() {
  const { KNOWN_DIRS } = require('../../migrate/llamacpp');
  console.log(chalk.dim('  Scanned directories:'));
  for (const d of KNOWN_DIRS) console.log(chalk.dim(`    ${d}`));
  console.log(chalk.dim('\n  Add custom paths with: llama-ultra migrate --scan-dir /your/path\n'));
}
