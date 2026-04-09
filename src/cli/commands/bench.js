'use strict';

/**
 * bench.js
 * llama-ultra bench <model>
 * Runs N inference passes and reports real tokens/sec, cold-start time,
 * memory delta, and per-run breakdown.
 */

const chalk = require('chalk');
const { UltraEngine } = require('../../core/engine');
const { loadConfig }  = require('../../config/loader');

const BENCH_PROMPTS = [
  'Explain the theory of relativity in simple terms.',
  'Write a recursive function in JavaScript to compute Fibonacci numbers.',
  'What are the main differences between TCP and UDP protocols?',
];

module.exports = function registerBench(program) {
  program
    .command('bench <model>')
    .description('Benchmark a model — measures real t/s, cold-start, memory')
    .option('-n, --runs <n>',          'Number of inference runs', '3')
    .option('-t, --max-tokens <n>',    'Tokens per run', '128')
    .option('-q, --quantization <q>',  'Quantization level', 'auto')
    .option('--warmup',                'Run 1 warm-up pass before measuring')
    .action(async (model, opts) => {
      const cfg   = await loadConfig();
      const runs  = parseInt(opts.runs, 10);
      const maxTokens = parseInt(opts.maxTokens, 10);

      console.log(chalk.bold.cyan('\n  LLaMA Ultra') + chalk.dim(' › bench'));
      console.log(chalk.dim(`  Model   : ${model}`));
      console.log(chalk.dim(`  Runs    : ${runs} × ${maxTokens} max tokens`));
      console.log(chalk.dim(`  Quant   : ${opts.quantization}\n`));

      // ─── Init engine ──────────────────────────────────────────────────
      const engine = new UltraEngine({
        modelsDir:    cfg.modelsDir,
        quantization: opts.quantization,
      });

      const t0 = Date.now();
      try {
        await engine.init();
        await engine.loadModel(model);
      } catch (err) {
        console.error(chalk.red('Error: ' + err.message));
        process.exit(1);
      }
      const coldStartMs = Date.now() - t0;

      const hw     = engine.hardware;
      const loaded = engine.loadedModel;
      console.log(chalk.dim(`  Backend : `) + (engine.backend === 'ollama' ? chalk.green('ollama') : chalk.yellow('mock')));
      console.log(chalk.dim(`  Profile : ${hw.profile.name} · ${hw.ram.freeGb.toFixed(1)} GB free`));
      console.log(chalk.dim(`  Cold start: ${coldStartMs} ms\n`));

      // ─── Warm-up pass ────────────────────────────────────────────────
      if (opts.warmup) {
        process.stdout.write(chalk.dim('  Warm-up…'));
        await runOne(engine, 'Hello.', maxTokens);
        process.stdout.write(chalk.dim(' done\n\n'));
      }

      // ─── Benchmark runs ──────────────────────────────────────────────
      const runResults = [];
      const memBefore  = process.memoryUsage().rss / (1024 ** 2);

      for (let i = 0; i < runs; i++) {
        const prompt = BENCH_PROMPTS[i % BENCH_PROMPTS.length];
        process.stdout.write(chalk.dim(`  Run ${i + 1}/${runs}… `));

        try {
          const result = await runOne(engine, prompt, maxTokens);
          runResults.push(result);

          const bar = speedBar(result.tps, 100);
          process.stdout.write(
            `${bar} ${chalk.green(result.tps.toFixed(1) + ' t/s')} · ${result.totalTokens} tok · ${result.ms} ms\n`
          );
        } catch (err) {
          process.stdout.write(chalk.red('FAILED: ' + err.message + '\n'));
        }
      }

      const memAfter = process.memoryUsage().rss / (1024 ** 2);

      // ─── Summary ─────────────────────────────────────────────────────
      if (runResults.length === 0) {
        console.log(chalk.red('\n  All runs failed.\n'));
        engine.unload();
        process.exit(1);
      }

      const avgTps   = avg(runResults.map(r => r.tps));
      const maxTps   = Math.max(...runResults.map(r => r.tps));
      const minTps   = Math.min(...runResults.map(r => r.tps));
      const avgMs    = avg(runResults.map(r => r.ms));
      const totalTok = runResults.reduce((s, r) => s + r.totalTokens, 0);
      const memDelta = memAfter - memBefore;

      console.log('\n' + chalk.bold('  ─── Results ───────────────────────────────'));
      console.log(`  ${chalk.bold('Avg t/s')}        : ${chalk.green(avgTps.toFixed(1))}`);
      console.log(`  ${chalk.bold('Min / Max t/s')}  : ${minTps.toFixed(1)} / ${maxTps.toFixed(1)}`);
      console.log(`  ${chalk.bold('Avg latency')}    : ${avgMs.toFixed(0)} ms/run`);
      console.log(`  ${chalk.bold('Total tokens')}   : ${totalTok}`);
      console.log(`  ${chalk.bold('Cold start')}     : ${coldStartMs} ms`);
      console.log(`  ${chalk.bold('RAM delta')}      : ${memDelta >= 0 ? '+' : ''}${memDelta.toFixed(0)} MB`);
      console.log(`  ${chalk.bold('Model size')}     : ${loaded.compressedSizeGb.toFixed(2)} GB (${loaded.quantization.toUpperCase()})`);
      console.log(`  ${chalk.bold('Backend')}        : ${engine.backend}`);
      console.log(`  ${chalk.bold('Profile')}        : ${hw.profile.name}`);

      // Grade
      const grade = tpsGrade(avgTps);
      console.log(`\n  ${chalk.bold('Grade')} : ${grade}\n`);

      engine.unload();
    });
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function runOne(engine, prompt, maxTokens) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let inferStats = null;

    engine.once('inference:done', s => { inferStats = s; });

    const stream = engine.infer(prompt, { maxTokens, format: 'text' });
    let totalTokens = 0;

    stream.on('data', () => { /* consume */ });
    stream.on('stream:done', ({ tokenCount }) => {
      const ms  = Date.now() - start;
      const tps = inferStats?.tps > 0
        ? inferStats.tps
        : tokenCount / (ms / 1000);
      resolve({ tps, ms, totalTokens: tokenCount });
    });
    stream.on('error', reject);
  });
}

function avg(arr) {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function speedBar(tps, scale) {
  const pct    = Math.min(1, tps / scale);
  const filled = Math.round(pct * 10);
  const empty  = 10 - filled;
  return chalk.cyan('█'.repeat(filled)) + chalk.dim('░'.repeat(empty));
}

function tpsGrade(tps) {
  if (tps >= 60) return chalk.green('S  — Blazing fast (≥ 60 t/s)');
  if (tps >= 30) return chalk.green('A  — Very fast (≥ 30 t/s)');
  if (tps >= 15) return chalk.yellow('B  — Good (≥ 15 t/s)');
  if (tps >= 7)  return chalk.yellow('C  — Acceptable (≥ 7 t/s)');
  if (tps >= 2)  return chalk.dim('D  — Slow (≥ 2 t/s)');
  return chalk.red('F  — Very slow (< 2 t/s)');
}
