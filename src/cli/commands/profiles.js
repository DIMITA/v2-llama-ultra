'use strict';

/**
 * profiles.js
 * llama-ultra profiles <subcommand>
 * Save and load named chat configuration profiles (system prompt, temperature, etc.)
 *
 * Profiles are stored in ~/.llama-ultra/profiles.json
 */

const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const chalk = require('chalk');

const PROFILES_PATH = path.join(os.homedir(), '.llama-ultra', 'profiles.json');

// ─── Registry helpers ─────────────────────────────────────────────────────────

function loadProfiles() {
  if (!fs.existsSync(PROFILES_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf8')); }
  catch { return {}; }
}

function saveProfiles(profiles) {
  fs.mkdirSync(path.dirname(PROFILES_PATH), { recursive: true });
  fs.writeFileSync(PROFILES_PATH, JSON.stringify(profiles, null, 2));
}

// ─── Command ─────────────────────────────────────────────────────────────────

module.exports = function registerProfiles(program) {
  const profiles = program
    .command('profiles')
    .description('Manage named chat profiles (system prompt, temperature, model…)');

  // ── list ──────────────────────────────────────────────────────────────────
  profiles
    .command('list')
    .alias('ls')
    .description('List all saved profiles')
    .action(() => {
      const data = loadProfiles();
      const names = Object.keys(data);

      console.log(chalk.bold.cyan('\n  LLaMA Ultra') + chalk.dim(' › profiles list\n'));

      if (names.length === 0) {
        console.log(chalk.dim('  No profiles saved yet.\n'));
        console.log(chalk.dim('  Create one: ') + chalk.white('llama-ultra profiles save <name>\n'));
        return;
      }

      for (const name of names) {
        const p = data[name];
        console.log(`  ${chalk.bold.green(name)}`);
        if (p.model)       console.log(`    model       : ${p.model}`);
        if (p.system)      console.log(`    system      : ${chalk.dim(p.system.slice(0, 80))}${p.system.length > 80 ? '…' : ''}`);
        if (p.temperature) console.log(`    temperature : ${p.temperature}`);
        if (p.topP)        console.log(`    top-p       : ${p.topP}`);
        if (p.maxTokens)   console.log(`    max-tokens  : ${p.maxTokens}`);
        if (p.savedAt)     console.log(`    saved       : ${chalk.dim(p.savedAt)}`);
        console.log('');
      }
    });

  // ── save ──────────────────────────────────────────────────────────────────
  profiles
    .command('save <name>')
    .description('Save a new profile')
    .option('--model <model>',           'Default model for this profile')
    .option('--system <prompt>',         'System prompt')
    .option('--temperature <n>',         'Temperature (0–2)', parseFloat)
    .option('--top-p <n>',              'Top-p (0–1)', parseFloat)
    .option('--max-tokens <n>',          'Max tokens per response', parseInt)
    .action((name, opts) => {
      const data = loadProfiles();

      if (data[name]) {
        console.log(chalk.yellow(`\n  Overwriting existing profile "${name}".\n`));
      }

      const profile = {
        savedAt: new Date().toISOString(),
      };
      if (opts.model)       profile.model       = opts.model;
      if (opts.system)      profile.system      = opts.system;
      if (!isNaN(opts.temperature)) profile.temperature = opts.temperature;
      if (!isNaN(opts.topP))        profile.topP        = opts.topP;
      if (opts.maxTokens)   profile.maxTokens   = opts.maxTokens;

      if (Object.keys(profile).length === 1) {
        console.log(chalk.red('\n  Error: provide at least one option (--model, --system, --temperature…)\n'));
        process.exit(1);
      }

      data[name] = profile;
      saveProfiles(data);

      console.log(chalk.green(`\n  Profile "${name}" saved.\n`));
      console.log(chalk.dim('  Use it: ') + chalk.white(`llama-ultra profiles use ${name}\n`));
    });

  // ── use ───────────────────────────────────────────────────────────────────
  profiles
    .command('use <name>')
    .description('Print the run command for a profile (copy & paste to use)')
    .action((name) => {
      const data = loadProfiles();
      const p = data[name];

      if (!p) {
        console.log(chalk.red(`\n  Profile not found: "${name}"\n`));
        process.exit(1);
      }

      const parts = ['llama-ultra run'];
      if (p.model)       parts.push(p.model);
      else               parts.push('<model>');
      if (p.system)      parts.push(`--system ${JSON.stringify(p.system)}`);
      if (p.temperature) parts.push(`--temperature ${p.temperature}`);
      if (p.topP)        parts.push(`--top-p ${p.topP}`);
      if (p.maxTokens)   parts.push(`--max-tokens ${p.maxTokens}`);

      console.log(chalk.bold.cyan('\n  LLaMA Ultra') + chalk.dim(` › profiles use "${name}"\n`));
      console.log('  ' + chalk.white(parts.join(' ')) + '\n');
    });

  // ── show ──────────────────────────────────────────────────────────────────
  profiles
    .command('show <name>')
    .description('Show full details of a profile')
    .action((name) => {
      const data = loadProfiles();
      const p = data[name];
      if (!p) {
        console.log(chalk.red(`\n  Profile not found: "${name}"\n`));
        process.exit(1);
      }
      console.log(chalk.bold.cyan('\n  ' + name + '\n'));
      console.log(JSON.stringify(p, null, 2) + '\n');
    });

  // ── rm ────────────────────────────────────────────────────────────────────
  profiles
    .command('rm <name>')
    .description('Delete a profile')
    .action((name) => {
      const data = loadProfiles();
      if (!data[name]) {
        console.log(chalk.red(`\n  Profile not found: "${name}"\n`));
        process.exit(1);
      }
      delete data[name];
      saveProfiles(data);
      console.log(chalk.green(`\n  Profile "${name}" deleted.\n`));
    });
};
