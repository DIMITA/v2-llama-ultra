'use strict';

const ora   = require('ora');
const chalk = require('chalk');
const path  = require('path');
const { selectQuantizationLevel, estimateCompressedSizeGb, mixedPrecisionStrategy } = require('../../core/quantization');
const { detectHardware } = require('../../core/hardware-detect');
const { ModelChunker }   = require('../../core/chunking');
const { loadConfig }     = require('../../config/loader');

module.exports = function registerOptimize(program) {
  program
    .command('optimize <model>')
    .description('Pre-optimize a model: chunk it, quantize it, build manifest')
    .option('-q, --quantization <level>', 'Force quantization level (default: auto-detect)')
    .option('-l, --layers <n>',           'Number of transformer layers', '32')
    .option('-c, --chunk-size <mb>',      'Chunk size in MB', '256')
    .option('--dry-run',                  'Show what would happen, without writing files')
    .action(async (model, opts) => {
      const cfg     = await loadConfig();
      const spinner = ora('Detecting hardware…').start();

      const hw         = await detectHardware();
      const modelPath  = path.resolve(model);

      spinner.succeed(`Hardware: ${hw.profile.name} profile — ${hw.ram.freeGb} GB free RAM`);

      const fs      = require('fs');
      const stat    = fs.statSync(modelPath);
      const sizeFp32Gb = stat.size / (1024 ** 3);

      const level = opts.quantization ?? selectQuantizationLevel(hw.ram.freeGb, sizeFp32Gb);
      const compGb = estimateCompressedSizeGb(sizeFp32Gb, level);
      const layers = parseInt(opts.layers, 10);
      const prec   = mixedPrecisionStrategy(layers, hw.ram.freeGb, sizeFp32Gb);

      console.log(chalk.bold('\n  Optimization plan:\n'));
      console.log(`  Original size   : ${chalk.red(sizeFp32Gb.toFixed(2) + ' GB')}`);
      console.log(`  Quantization    : ${chalk.yellow(level)}`);
      console.log(`  Compressed size : ${chalk.green(compGb.toFixed(2) + ' GB')}`);
      console.log(`  Reduction       : ${chalk.cyan((sizeFp32Gb / compGb).toFixed(1) + 'x')}`);
      console.log(`  Layers          : ${layers}`);
      console.log(`  Chunk size      : ${opts.chunkSize} MB\n`);

      const edgeLayers = prec.filter(p => p.quantization !== level);
      if (edgeLayers.length) {
        console.log(chalk.dim(`  Mixed precision: layers ${edgeLayers.map(p => p.layer).join(', ')} → higher precision\n`));
      }

      if (opts.dryRun) {
        console.log(chalk.dim('  [Dry run — no files written]\n'));
        return;
      }

      const chunkDir = path.join(path.dirname(modelPath), '.chunks', path.basename(modelPath));
      const chunker  = new ModelChunker({
        modelPath,
        chunkSizeMb: parseInt(opts.chunkSize, 10),
        numLayers:   layers,
        outDir:      chunkDir,
      });

      const chunkSpinner = ora('Splitting model into chunks…').start();
      chunker.on('split:chunk', ({ id, sizeMb }) => {
        chunkSpinner.text = `Chunk ${chalk.cyan(id)} — ${sizeMb.toFixed(0)} MB`;
      });

      const chunks = await chunker.split();
      chunkSpinner.succeed(`Split into ${chalk.green(chunks.length)} chunks → ${chalk.dim(chunkDir)}`);

      console.log(chalk.green('\n  Model optimized and ready.\n'));
    });
};
