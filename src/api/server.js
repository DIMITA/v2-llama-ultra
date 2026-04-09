'use strict';

require('dotenv').config();

const express     = require('express');
const cors        = require('cors');
const helmet      = require('helmet');
const rateLimit   = require('express-rate-limit');
const chalk       = require('chalk');
const path        = require('path');
const { isPricingEnabled } = require('../pricing');

const inferenceRouter = require('./routes/inference');
const billingRouter   = require('./routes/billing');
const modelsRouter    = require('./routes/models');

const app  = express();
const PORT = parseInt(process.env.PORT ?? '3000', 10);
const HOST = process.env.HOST ?? 'localhost';

// ─── Security middleware ──────────────────────────────────────────────────────

// Relax CSP for the built-in Web UI (inline scripts)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'"],
      styleSrc:   ["'self'", "'unsafe-inline'"],
    },
  },
}));
app.use(cors({
  origin:  process.env.ALLOWED_ORIGINS?.split(',') ?? '*',
  methods: ['GET', 'POST', 'DELETE'],
}));

// Raw body needed for Stripe webhook — must come before json()
app.use('/billing/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '1mb' }));

// ─── Rate limiting ────────────────────────────────────────────────────────────

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max:      isPricingEnabled() ? 60 : 1000,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'rate_limit_exceeded', message: 'Too many requests' },
});
app.use('/v1', limiter);

// ─── Health check ─────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({
  status:  'ok',
  version: require('../../package.json').version,
  pricing: isPricingEnabled(),
  ts:      new Date().toISOString(),
}));

// ─── Web UI ───────────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use('/v1',      inferenceRouter);
app.use('/v1',      modelsRouter);
app.use('/billing', billingRouter);

// ─── 404 handler ─────────────────────────────────────────────────────────────

app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

// ─── Error handler ────────────────────────────────────────────────────────────

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'internal_error', message: err.message });
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, HOST, () => {
  console.log(chalk.bold.cyan(`\n  LLaMA Ultra API  `) + chalk.dim(`v${require('../../package.json').version}`));
  console.log(chalk.dim(`  http://${HOST}:${PORT}`));
  console.log(`  Pricing: ${isPricingEnabled() ? chalk.green('enabled') : chalk.yellow('disabled (open mode)')}`);
  console.log(chalk.dim(`  Web UI   : http://${HOST}:${PORT}/`));
  console.log(chalk.dim(`  Routes   : /v1/chat/completions  /v1/models  /v1/models/load  /v1/engine/status\n`));
});

module.exports = app;
