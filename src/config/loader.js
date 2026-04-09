'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const CONFIG_DIR  = path.join(os.homedir(), '.llama-ultra');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

const DEFAULTS = {
  modelsDir:       path.join(os.homedir(), '.llama-ultra', 'models'),
  maxCacheSizeMb:  2048,
  quantization:    'auto',
  enableGPU:       true,
  maxRamPercent:   80,
  pricingEnabled:  true,
  apiPort:         3000,
  apiHost:         'localhost',
  logLevel:        'info',
};

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return { ...DEFAULTS };
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveConfig(config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

module.exports = { loadConfig, saveConfig, CONFIG_PATH, DEFAULTS };
