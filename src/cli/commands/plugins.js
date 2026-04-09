'use strict';

/**
 * plugins.js
 * llama-ultra plugins <subcommand>
 * Manage LLaMA Ultra backend plugins.
 */

const chalk = require('chalk');
const path  = require('path');
const { PluginManager, PLUGINS_DIR } = require('../../core/plugins');

module.exports = function registerPlugins(program) {
  const plugins = program
    .command('plugins')
    .description('Manage LLaMA Ultra backend plugins');

  // ── list ──────────────────────────────────────────────────────────────────
  plugins
    .command('list')
    .alias('ls')
    .description('List all installed plugins')
    .action(async () => {
      const mgr = new PluginManager();
      await mgr.loadAll();
      const list = mgr.list();

      console.log(chalk.bold.cyan('\n  LLaMA Ultra') + chalk.dim(' › plugins list\n'));
      console.log(chalk.dim(`  Plugins directory: ${PLUGINS_DIR}\n`));

      if (list.length === 0) {
        console.log(chalk.dim('  No plugins installed.\n'));
        console.log(chalk.dim('  Scaffold a new plugin:'));
        console.log('  ' + chalk.white('llama-ultra plugins new <name>\n'));
        return;
      }

      for (const p of list) {
        const status = p.available
          ? chalk.green('✓ available')
          : chalk.red('✗ unavailable');
        console.log(`  ${chalk.bold(p.name.padEnd(20))} ${status}  ${chalk.dim('v' + p.version)}`);
        if (p.description) console.log(`  ${chalk.dim(' '.repeat(20) + p.description)}`);
      }
      console.log('');
    });

  // ── new ───────────────────────────────────────────────────────────────────
  plugins
    .command('new <name>')
    .description('Scaffold a new plugin in ~/.llama-ultra/plugins/<name>/')
    .action((name) => {
      const dir = PluginManager.scaffold(name);
      console.log(chalk.green(`\n  Plugin scaffolded at: ${dir}\n`));
      console.log(chalk.dim('  Edit index.js to implement your backend, then:'));
      console.log('  ' + chalk.white('llama-ultra plugins list') + chalk.dim(' to verify it loads\n'));
    });

  // ── dir ───────────────────────────────────────────────────────────────────
  plugins
    .command('dir')
    .description('Print the plugins directory path')
    .action(() => {
      console.log(PLUGINS_DIR);
    });
};
