'use strict';

const chalk    = require('chalk');
const readline = require('readline');
const { UltraEngine } = require('../../core/engine');
const { loadConfig }  = require('../../config/loader');

module.exports = function registerRun(program) {
  program
    .command('run <model>')
    .description('Interactive chat with a model')
    .option('-q, --quantization <level>', 'Quantization: auto | int4 | int8 | fp16 | fp32', 'auto')
    .option('-t, --max-tokens <n>',       'Max output tokens', '512')
    .option('--system <prompt>',          'System prompt override')
    .option('--speed <tps>',              'Target tokens/second (0 = unlimited)', '0')
    .action(async (model, opts) => {
      const cfg    = await loadConfig();
      const engine = new UltraEngine({
        modelsDir:    cfg.modelsDir,
        quantization: opts.quantization,
      });

      console.log(chalk.bold.cyan('\n  Ultra LLaMA Engine  ') + chalk.dim('v2'));
      console.log(chalk.dim('  Loading ' + model + '…\n'));

      try {
        await engine.init();
        await engine.loadModel(model);
      } catch (err) {
        console.error(chalk.red('Error: ' + err.message));
        process.exit(1);
      }

      const hw       = engine.hardware;
      const loaded   = engine.loadedModel;
      const chunkMb  = hw.profile.chunkSizeMb;
      const totalChunks = loaded.chunker?.chunks?.length ?? '?';

      console.log(
        chalk.dim(`  Hardware : ${hw.cpu.cores} cores · ${hw.ram.freeGb.toFixed(1)} GB free · profile: ${hw.profile.name}`)
      );
      console.log(
        chalk.dim(`  Backend  : `) + (engine.backend === 'ollama' ? chalk.green('ollama') : chalk.yellow('mock'))
      );
      console.log(
        chalk.dim(`  Model    : ${loaded.quantization.toUpperCase()} · `) +
        chalk.green(`${loaded.compressedSizeGb.toFixed(1)} GB`) +
        chalk.dim(` compressed`)
      );
      console.log(
        chalk.dim(`  Chunking : ${totalChunks} chunks × ${chunkMb} MB — 1 chunk in RAM at a time\n`)
      );

      engine.on('inference:chunk', ({ chunkId, ramMb, maxMb }) => {
        process.stdout.write(
          chalk.dim(`\r  [chunk ${chunkId + 1}/${totalChunks} · RAM ${ramMb} MB / ${maxMb} MB]  `)
        );
      });

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: chalk.green('You > '),
      });

      rl.prompt();

      rl.on('line', async (line) => {
        const prompt = line.trim();
        if (!prompt) { rl.prompt(); return; }
        if (prompt === '/exit' || prompt === '/quit') { rl.close(); return; }
        if (prompt === '/status') {
          console.log(JSON.stringify(engine.status(), null, 2));
          rl.prompt();
          return;
        }

        process.stdout.write(chalk.yellow('AI  > '));

        let inferDone = null;
        const inferDoneHandler = (stats) => { inferDone = stats; };
        engine.once('inference:done', inferDoneHandler);

        const stream = engine.infer(prompt, {
          maxTokens: parseInt(opts.maxTokens, 10),
          speed:     parseFloat(opts.speed),
          format:    'text',
        });

        stream.on('data', chunk => process.stdout.write(chunk));
        stream.on('stream:done', ({ tokenCount, elapsed }) => {
          engine.removeListener('inference:done', inferDoneHandler);
          const tps = inferDone?.tps > 0
            ? inferDone.tps
            : (tokenCount / (elapsed / 1000)).toFixed(1);
          const backendLabel = inferDone?.backend ?? engine.backend;
          process.stdout.write(chalk.dim(`\n  [${tokenCount} tokens · ${tps} t/s · ${backendLabel}]\n\n`));
          rl.prompt();
        });
        stream.on('error', err => {
          engine.removeListener('inference:done', inferDoneHandler);
          console.error(chalk.red('\nError: ' + err.message));
          rl.prompt();
        });
      });

      rl.on('close', () => {
        engine.unload();
        console.log(chalk.dim('\n  Goodbye.\n'));
        process.exit(0);
      });
    });
};
