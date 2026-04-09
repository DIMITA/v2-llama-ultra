'use strict';

/**
 * core/plugins.js
 * Plugin system for LLaMA Ultra.
 * Plugins live in ~/.llama-ultra/plugins/<name>/index.js
 *
 * A plugin must export:
 *   {
 *     name:        string            // unique identifier
 *     description: string
 *     version:     string
 *     test():      Promise<boolean>  // return true if plugin is usable
 *     infer(messages, opts, streamer): Promise<{totalTokens, tps}>
 *   }
 *
 * Optional:
 *   onLoad(engine):  called after plugin is registered
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const PLUGINS_DIR = path.join(os.homedir(), '.llama-ultra', 'plugins');

class PluginManager {
  constructor() {
    /** @type {Map<string, object>} */
    this.plugins = new Map();
  }

  // ─── Discovery ─────────────────────────────────────────────────────────────

  /**
   * Scan PLUGINS_DIR and load every valid plugin.
   * Non-blocking — invalid plugins are skipped with a warning.
   */
  async loadAll() {
    if (!fs.existsSync(PLUGINS_DIR)) return;

    const entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const indexPath = path.join(PLUGINS_DIR, entry.name, 'index.js');
      if (!fs.existsSync(indexPath)) continue;

      try {
        const plugin = require(indexPath);
        await this.register(plugin);
      } catch (err) {
        console.error(`[plugins] Failed to load "${entry.name}": ${err.message}`);
      }
    }
  }

  /**
   * Register a plugin object directly (useful for testing or built-in plugins).
   * @param {object} plugin
   */
  async register(plugin) {
    if (!plugin.name || typeof plugin.infer !== 'function') {
      throw new Error('Plugin must export { name, infer() }');
    }

    let available = false;
    try {
      available = await plugin.test?.() ?? true;
    } catch (_) {}

    this.plugins.set(plugin.name, { ...plugin, available });
    return available;
  }

  // ─── Lookup ────────────────────────────────────────────────────────────────

  /** Return the first available plugin, or null. */
  firstAvailable() {
    for (const p of this.plugins.values()) {
      if (p.available) return p;
    }
    return null;
  }

  /** Return plugin by name. */
  get(name) {
    return this.plugins.get(name) ?? null;
  }

  list() {
    return [...this.plugins.values()].map(p => ({
      name:        p.name,
      description: p.description ?? '',
      version:     p.version ?? '?',
      available:   p.available,
    }));
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  static get pluginsDir() { return PLUGINS_DIR; }

  /** Create the plugins directory and write a starter template. */
  static scaffold(pluginName) {
    const dir = path.join(PLUGINS_DIR, pluginName);
    fs.mkdirSync(dir, { recursive: true });

    const template = `'use strict';

/**
 * LLaMA Ultra plugin: ${pluginName}
 * Place this folder in ~/.llama-ultra/plugins/${pluginName}/
 */

module.exports = {
  name:        '${pluginName}',
  description: 'My custom backend plugin',
  version:     '1.0.0',

  /** Return true if this plugin is available/configured. */
  async test() {
    // e.g. check if a binary exists or an API key is set
    return true;
  },

  /**
   * Run inference.
   * @param {Array<{role,content}>} messages
   * @param {object}  opts   — maxTokens, temperature, topP, signal
   * @param {object}  streamer — call streamer.write(token: string)
   * @returns {Promise<{totalTokens: number, tps: number}>}
   */
  async infer(messages, opts, streamer) {
    const userContent = messages.filter(m => m.role === 'user').at(-1)?.content ?? '';

    // Replace this with your actual backend call
    streamer.write('[${pluginName}] Echo: ' + userContent);

    return { totalTokens: 1, tps: 0 };
  },
};
`;

    fs.writeFileSync(path.join(dir, 'index.js'), template);
    return dir;
  }
}

module.exports = { PluginManager, PLUGINS_DIR };
