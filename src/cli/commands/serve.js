'use strict';

const chalk = require('chalk');
const { loadConfig } = require('../../config/loader');

module.exports = function registerServe(program) {
  program
    .command('serve')
    .description('Start the HTTP API server')
    .option('-p, --port <port>',   'Port to listen on', '3000')
    .option('-H, --host <host>',   'Host to bind to',   'localhost')
    .option('--no-auth',           'Disable JWT authentication')
    .option('--no-pricing',        'Disable billing/pricing (self-hosted mode)')
    .action(async (opts) => {
      const cfg = await loadConfig();

      // Override config with CLI flags
      if (!opts.pricing) cfg.pricingEnabled = false;

      process.env.PORT            = opts.port;
      process.env.HOST            = opts.host;
      process.env.PRICING_ENABLED = String(cfg.pricingEnabled);

      console.log(chalk.bold.cyan(`\n  Starting API server on ${opts.host}:${opts.port}…`));
      if (!cfg.pricingEnabled) {
        console.log(chalk.yellow('  Pricing: DISABLED (self-hosted / open mode)'));
      }

      require('../../api/server');
    });
};
