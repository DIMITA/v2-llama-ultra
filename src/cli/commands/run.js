'use strict';

const chalk    = require('chalk');
const readline = require('readline');
const fs       = require('fs');
const path     = require('path');
const { UltraEngine } = require('../../core/engine');
const { loadConfig }  = require('../../config/loader');

const HELP_TEXT = `
  ${chalk.bold('Slash commands:')}
  ${chalk.cyan('/clear')}          Clear conversation history
  ${chalk.cyan('/history')}        Show full conversation history
  ${chalk.cyan('/save [file]')}    Save conversation to JSON file
  ${chalk.cyan('/model')}          Show loaded model info
  ${chalk.cyan('/status')}         Show engine status (hardware, cache)
  ${chalk.cyan('/temp <n>')}       Set temperature (0–2, default 0.7)
  ${chalk.cyan('/tokens <n>')}     Set max tokens for next responses
  ${chalk.cyan('/system <text>')}  Change system prompt (use /system off to clear)
  ${chalk.cyan('/help')}           Show this help
  ${chalk.cyan('/exit')} ${chalk.dim('or')} ${chalk.cyan('/quit')}   Exit
`;

module.exports = function registerRun(program) {
  program
    .command('run <model>')
    .description('Interactive chat with a model (multi-turn)')
    .option('-q, --quantization <level>', 'Quantization: auto | int4 | int8 | fp16 | fp32', 'auto')
    .option('-t, --max-tokens <n>',       'Max output tokens per response', '2048')
    .option('--system <prompt>',          'System prompt')
    .option('--temperature <n>',          'Sampling temperature (0–2)', '0.7')
    .option('--top-p <n>',               'Top-p nucleus sampling (0–1)', '0.9')
    .option('--speed <tps>',             'Target tokens/second (0 = unlimited)', '0')
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

      const hw          = engine.hardware;
      const loaded      = engine.loadedModel;
      const chunkMb     = hw.profile.chunkSizeMb;
      const totalChunks = loaded.chunker?.chunks?.length ?? '?';

      console.log(chalk.dim(`  Hardware : ${hw.cpu.cores} cores · ${hw.ram.freeGb.toFixed(1)} GB free · profile: ${hw.profile.name}`));
      console.log(chalk.dim(`  Backend  : `) + (engine.backend === 'ollama' ? chalk.green('ollama') : chalk.yellow('mock (no Ollama)')));
      console.log(chalk.dim(`  Model    : ${loaded.quantization.toUpperCase()} · `) + chalk.green(`${loaded.compressedSizeGb.toFixed(1)} GB`) + chalk.dim(' compressed'));
      console.log(chalk.dim(`  Chunking : ${totalChunks} chunks × ${chunkMb} MB\n`));
      console.log(chalk.dim('  Type /help for commands.\n'));

      // ─── Session state ────────────────────────────────────────────────────
      /** @type {Array<{role: string, content: string}>} */
      const history = [];
      let systemPrompt = opts.system ?? null;
      let temperature  = parseFloat(opts.temperature);
      let maxTokens    = parseInt(opts.maxTokens, 10);
      let busy         = false;

      if (systemPrompt) {
        console.log(chalk.dim(`  System   : ${systemPrompt}\n`));
      }

      // ─── Hardware chunk progress ──────────────────────────────────────────
      engine.on('inference:chunk', ({ chunkId, ramMb, maxMb }) => {
        process.stdout.write(chalk.dim(`\r  [chunk ${chunkId + 1}/${totalChunks} · RAM ${ramMb}/${maxMb} MB]  `));
      });

      // ─── Readline interface ───────────────────────────────────────────────
      const rl = readline.createInterface({
        input:  process.stdin,
        output: process.stdout,
        prompt: chalk.green('You > '),
      });

      rl.prompt();

      rl.on('line', async (line) => {
        const input = line.trim();
        if (!input) { rl.prompt(); return; }

        // ─── Slash commands ─────────────────────────────────────────────
        if (input.startsWith('/')) {
          const [cmd, ...args] = input.slice(1).split(' ');

          switch (cmd.toLowerCase()) {
            case 'exit':
            case 'quit':
              rl.close();
              return;

            case 'help':
              console.log(HELP_TEXT);
              break;

            case 'clear':
              history.length = 0;
              console.log(chalk.dim('  Conversation cleared.\n'));
              break;

            case 'history': {
              if (history.length === 0) {
                console.log(chalk.dim('  No history yet.\n'));
              } else {
                console.log('');
                for (const msg of history) {
                  const label = msg.role === 'user'
                    ? chalk.green('You')
                    : chalk.yellow('AI ');
                  const preview = msg.content.length > 120
                    ? msg.content.slice(0, 120) + chalk.dim('…')
                    : msg.content;
                  console.log(`  ${label} › ${preview}`);
                }
                console.log('');
              }
              break;
            }

            case 'save': {
              const filename = args[0] ?? `chat-${Date.now()}.json`;
              const filepath = path.resolve(filename);
              const data = {
                model:       model,
                systemPrompt,
                temperature,
                maxTokens,
                savedAt:     new Date().toISOString(),
                messages:    history,
              };
              fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
              console.log(chalk.dim(`  Saved to ${filepath}\n`));
              break;
            }

            case 'model':
              console.log('');
              console.log(`  ${chalk.bold('Model')}     : ${loaded.ollamaName ?? path.basename(loaded.path)}`);
              console.log(`  ${chalk.bold('Quant')}     : ${loaded.quantization.toUpperCase()}`);
              console.log(`  ${chalk.bold('Size')}      : ${loaded.compressedSizeGb.toFixed(2)} GB`);
              console.log(`  ${chalk.bold('Chunks')}    : ${totalChunks} × ${chunkMb} MB`);
              console.log(`  ${chalk.bold('Loaded at')}: ${loaded.loadedAt}`);
              console.log('');
              break;

            case 'status':
              console.log(JSON.stringify(engine.status(), null, 2));
              break;

            case 'temp': {
              const val = parseFloat(args[0]);
              if (isNaN(val) || val < 0 || val > 2) {
                console.log(chalk.red('  Temperature must be 0–2\n'));
              } else {
                temperature = val;
                console.log(chalk.dim(`  Temperature set to ${temperature}\n`));
              }
              break;
            }

            case 'tokens': {
              const val = parseInt(args[0], 10);
              if (isNaN(val) || val < 1) {
                console.log(chalk.red('  Max tokens must be ≥ 1\n'));
              } else {
                maxTokens = val;
                console.log(chalk.dim(`  Max tokens set to ${maxTokens}\n`));
              }
              break;
            }

            case 'system': {
              const text = args.join(' ').trim();
              if (!text || text === 'off') {
                systemPrompt = null;
                console.log(chalk.dim('  System prompt cleared.\n'));
              } else {
                systemPrompt = text;
                console.log(chalk.dim(`  System prompt updated.\n`));
              }
              break;
            }

            default:
              console.log(chalk.red(`  Unknown command: /${cmd}  (type /help)\n`));
          }

          rl.prompt();
          return;
        }

        // ─── Regular chat turn ──────────────────────────────────────────
        if (busy) {
          console.log(chalk.dim('  (still generating…)\n'));
          rl.prompt();
          return;
        }

        busy = true;

        // Build messages array for this turn
        const userMsg = { role: 'user', content: input };
        history.push(userMsg);

        const messages = [
          ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
          ...history,
        ];

        process.stdout.write(chalk.yellow('AI  > '));

        let inferDone = null;
        const inferDoneHandler = (stats) => { inferDone = stats; };
        engine.once('inference:done', inferDoneHandler);

        const stream = engine.infer(messages, {
          maxTokens:   maxTokens,
          temperature: temperature,
          topP:        parseFloat(opts.topP),
          speed:       parseFloat(opts.speed),
          format:      'text',
        });

        let assistantReply = '';

        stream.on('data', chunk => {
          assistantReply += chunk;
          process.stdout.write(chunk);
        });

        stream.on('stream:done', ({ tokenCount, elapsed }) => {
          engine.removeListener('inference:done', inferDoneHandler);

          // Record assistant reply in history
          history.push({ role: 'assistant', content: assistantReply.trim() });

          const tps = inferDone?.tps > 0
            ? inferDone.tps
            : (tokenCount / (elapsed / 1000)).toFixed(1);
          const backendLabel = inferDone?.backend ?? engine.backend;
          const turns = Math.floor(history.filter(m => m.role === 'user').length);

          process.stdout.write(
            chalk.dim(`\n  [${tokenCount} tok · ${tps} t/s · ${backendLabel} · turn ${turns}]\n\n`)
          );
          busy = false;
          rl.prompt();
        });

        stream.on('error', err => {
          engine.removeListener('inference:done', inferDoneHandler);
          history.pop(); // remove the user message that failed
          console.error(chalk.red('\nError: ' + err.message));
          busy = false;
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
