'use strict';

const chalk   = require('chalk');
const fs      = require('fs');
const path    = require('path');
const { loadConfig, CONFIG_PATH, saveConfig } = require('../../config/loader');

module.exports = function registerConfig(program) {
  const cfg = program.command('config').description('Manage configuration');

  // config show
  cfg
    .command('show')
    .description('Print current configuration')
    .action(async () => {
      const config = await loadConfig();
      console.log(chalk.bold.cyan('\n  Configuration\n'));
      for (const [k, v] of Object.entries(config)) {
        const display = typeof v === 'boolean'
          ? (v ? chalk.green('true') : chalk.red('false'))
          : chalk.yellow(String(v));
        console.log(`  ${chalk.dim(k.padEnd(24))} ${display}`);
      }
      console.log(chalk.dim(`\n  File: ${CONFIG_PATH}\n`));
    });

  // config set <key> <value>
  cfg
    .command('set <key> <value>')
    .description('Set a configuration value')
    .action(async (key, value) => {
      const config = await loadConfig();
      const parsed = value === 'true' ? true : value === 'false' ? false : isNaN(value) ? value : Number(value);
      config[key] = parsed;
      saveConfig(config);
      console.log(chalk.green(`  ✓ ${key} = ${parsed}`));
    });

  // config reset
  cfg
    .command('reset')
    .description('Reset configuration to defaults')
    .action(async () => {
      if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
      console.log(chalk.green('  ✓ Configuration reset to defaults'));
    });

  // config pricing <on|off>
  cfg
    .command('pricing <state>')
    .description('Enable or disable the pricing/billing system (on | off)')
    .action(async (state) => {
      const enabled = state === 'on' || state === 'true' || state === '1';
      const config  = await loadConfig();
      config.pricingEnabled = enabled;
      saveConfig(config);
      console.log(
        enabled
          ? chalk.green('  ✓ Pricing enabled')
          : chalk.yellow('  ✓ Pricing disabled — running in open/self-hosted mode')
      );
    });
};
