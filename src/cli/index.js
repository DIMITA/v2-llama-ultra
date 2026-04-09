#!/usr/bin/env node
'use strict';

const { Command } = require('commander');
const chalk       = require('chalk');
const pkg         = require('../../package.json');

const program = new Command();

program
  .name('llama-ultra')
  .description(chalk.cyan('Ultra-light AI model loader & optimizer'))
  .version(pkg.version, '-v, --version', 'Print version')
  .addHelpText('before', `
${chalk.bold.cyan('  LLaMA Ultra')} ${chalk.dim('v' + pkg.version)}
  ${chalk.dim('Run heavy AI models on any machine — adaptive, streaming, ultra-light')}
`);

// Register all sub-commands
require('./commands/load')(program);
require('./commands/run')(program);
require('./commands/optimize')(program);
require('./commands/migrate')(program);
require('./commands/status')(program);
require('./commands/config')(program);
require('./commands/serve')(program);
require('./commands/pull')(program);
require('./commands/models')(program);
require('./commands/bench')(program);
require('./commands/rm')(program);
require('./commands/profiles')(program);

// Global error handler
program.exitOverride();
try {
  program.parse(process.argv);
} catch (err) {
  if (err.code !== 'commander.helpDisplayed' && err.code !== 'commander.version') {
    console.error(chalk.red('\n  Error: ' + err.message + '\n'));
    process.exit(1);
  }
}
