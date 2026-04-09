'use strict';

const ora   = require('ora');
const chalk = require('chalk');
const { UltraEngine } = require('../../core/engine');
const { loadConfig }  = require('../../config/loader');

module.exports = function registerLoad(program) {
  program
    .command('load <model>')
    .description('Load and optimize a model for inference')
    .option('-q, --quantization <level>', 'Quantization level: auto | int4 | int8 | fp16 | fp32', 'auto')
    .option('-c, --chunk-size <mb>',      'Chunk size in MB', '256')
    .option('--no-gpu',                   'Disable GPU even if available')
    .option('--max-ram <percent>',        'Max RAM usage %', '80')
    .action(async (model, opts) => {
      const cfg    = await loadConfig();
      const spinner = ora(`Loading model ${chalk.cyan(model)}…`).start();

      const engine = new UltraEngine({
        modelsDir:      cfg.modelsDir,
        maxCacheSizeMb: cfg.maxCacheSizeMb,
        quantization:   opts.quantization,
        enableGPU:      opts.gpu,
        maxRamPercent:  parseInt(opts.maxRam, 10),
      });

      engine.on('model:load:start', ({ level, sizeFp32Gb, compressedSizeGb }) => {
        spinner.text = `Quantizing to ${chalk.yellow(level)} — `
          + `${chalk.red(sizeFp32Gb.toFixed(1)+'GB')} → ${chalk.green(compressedSizeGb.toFixed(1)+'GB')}`;
      });

      engine.on('model:chunk', ({ id, sizeMb }) => {
        spinner.text = `Splitting chunk ${chalk.cyan(id)} (${sizeMb.toFixed(0)} MB)…`;
      });

      try {
        await engine.init();
        const loaded = await engine.loadModel(model, {
          chunkSizeMb: parseInt(opts.chunkSize, 10),
        });

        spinner.succeed(
          `Model ready  ${chalk.dim('|')}  ` +
          `${chalk.cyan(loaded.quantization)}  ${chalk.dim('|')}  ` +
          `${chalk.green(loaded.compressedSizeGb.toFixed(2) + ' GB')}`
        );

        console.log(chalk.dim(`  Layers: ${loaded.numLayers}  |  Chunks: ${loaded.chunker.chunks.length}`));
      } catch (err) {
        spinner.fail(chalk.red(err.message));
        process.exit(1);
      }
    });
};
