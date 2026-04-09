'use strict';

const chalk = require('chalk');
const Table = require('cli-table3');
const { detectHardware } = require('../../core/hardware-detect');

module.exports = function registerStatus(program) {
  program
    .command('status')
    .description('Show system hardware profile and engine status')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      const hw = await detectHardware();

      if (opts.json) {
        console.log(JSON.stringify(hw, null, 2));
        return;
      }

      console.log(chalk.bold.cyan('\n  System Profile\n'));

      const table = new Table({
        head: [chalk.dim('Component'), chalk.dim('Details')],
        style: { head: [], border: ['dim'] },
      });

      table.push(
        ['CPU',     `${hw.cpu.model} · ${hw.cpu.cores} cores`],
        ['RAM',     `${hw.ram.freeGb} GB free / ${hw.ram.totalGb} GB total`],
        ['GPU',     hw.gpu ? `${hw.gpu.model} · ${hw.gpu.vramGb} GB VRAM` : chalk.dim('None detected')],
        ['Profile', chalk.yellow(hw.profile.name) + ' · ' + chalk.cyan(hw.profile.quantization)],
        ['Chunk',   hw.profile.chunkSizeMb + ' MB'],
        ['Device',  chalk.green(hw.recommendedDevice)],
      );

      console.log(table.toString());

      console.log(chalk.dim('\n  Recommended settings for this machine:'));
      console.log(chalk.dim(`  - Quantization : ${hw.profile.quantization}`));
      console.log(chalk.dim(`  - Max layers   : ${hw.profile.maxLayers}`));
      console.log(chalk.dim(`  - Chunk size   : ${hw.profile.chunkSizeMb} MB\n`));
    });
};
