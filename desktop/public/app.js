'use strict';

/**
 * app.js — Renderer process application logic
 * Communicates with main process via window.llamaUltra (preload bridge).
 */

const api = window.llamaUltra;

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  currentPage:  'chat',
  models:       [],      // Array<{ name, path, sizeMb, quantization, loaded }>
  activeModel:  null,
  apiRunning:   false,
  hw:           null,
  settings:     {},
};

// ─── Notify ───────────────────────────────────────────────────────────────────

function notify(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `notif notif--${type}`;
  el.textContent = msg;
  document.getElementById('notifications').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ─── Navigation ───────────────────────────────────────────────────────────────

function navigate(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById(`page-${page}`)?.classList.add('active');
  document.querySelector(`[data-page="${page}"]`)?.classList.add('active');
  state.currentPage = page;
}

document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => navigate(item.dataset.page));
});

// ─── Hardware badge ───────────────────────────────────────────────────────────

async function loadHardware() {
  if (!api) return;
  const hw = await api.hw.detect();
  state.hw = hw;
  document.getElementById('hwRam').textContent     = hw.ram?.freeGb ? `${hw.ram.freeGb} GB` : '—';
  document.getElementById('hwProfile').textContent = pickProfile(hw.ram?.freeGb ?? 0);
  document.getElementById('hwQuant').textContent   = pickQuant(hw.ram?.freeGb ?? 0);
}

function pickProfile(freeGb) {
  if (freeGb >= 24) return 'ultra_high';
  if (freeGb >= 12) return 'high';
  if (freeGb >=  6) return 'medium';
  if (freeGb >=  3) return 'low';
  return 'ultra_low';
}
function pickQuant(freeGb) {
  if (freeGb >= 24) return 'FP16';
  if (freeGb >=  6) return 'INT8';
  return 'INT4';
}

// ─── Settings ─────────────────────────────────────────────────────────────────

const App = {};

App.settings = {
  async load() {
    if (!api) return;
    const cfg = await api.store.getAll();
    state.settings = cfg;

    const q = document.getElementById('settQuant');
    const c = document.getElementById('settCache');
    const g = document.getElementById('settGPU');
    const p = document.getElementById('settPricing');
    const d = document.getElementById('settModelsDirDisplay');

    if (q) q.value = cfg.quantization ?? 'auto';
    if (c) c.value = cfg.maxCacheSizeMb ?? 2048;
    if (g) g.checked = cfg.enableGPU !== false;
    if (p) p.checked = cfg.pricingEnabled !== false;
    if (d) d.textContent = cfg.modelsDir ?? '~/.llama-ultra/models';
  },
  async save() {
    if (!api) return;
    const cfg = {
      quantization:   document.getElementById('settQuant')?.value    ?? 'auto',
      maxCacheSizeMb: parseInt(document.getElementById('settCache')?.value ?? '2048', 10),
      enableGPU:      document.getElementById('settGPU')?.checked    ?? true,
      pricingEnabled: document.getElementById('settPricing')?.checked ?? true,
    };
    for (const [k, v] of Object.entries(cfg)) await api.store.set(k, v);
    state.settings = { ...state.settings, ...cfg };
    notify('Settings saved', 'success');
  },
  async browseModelsDir() {
    if (!api) return;
    const dir = await api.dialog.openDir();
    if (!dir) return;
    await api.store.set('modelsDir', dir);
    document.getElementById('settModelsDirDisplay').textContent = dir;
    notify('Models directory updated', 'success');
  },
};

// ─── Models ───────────────────────────────────────────────────────────────────

App.models = {
  async load() {
    await this.render();
  },
  async add() {
    if (!api) { notify('Desktop bridge not available', 'error'); return; }
    const filePath = await api.dialog.openModel();
    if (!filePath) return;

    const name   = filePath.split('/').pop().split('\\').pop();
    const model  = { name, path: filePath, sizeMb: 0, quantization: 'unknown', loaded: false };
    state.models.push(model);
    await this.render();
    notify(`Model added: ${name}`, 'success');
  },
  async load_model(idx) {
    const model = state.models[idx];
    if (!model) return;
    state.models.forEach(m => m.loaded = false);
    model.loaded = true;
    state.activeModel = model;
    document.getElementById('chatModelTag').textContent = model.name;
    document.getElementById('sendBtn').disabled = false;
    document.getElementById('engineDot').className = 'status-dot green';
    document.getElementById('engineStatus').textContent = `Model: ${model.name}`;
    await this.render();
    navigate('chat');
    notify(`Model loaded: ${model.name}`, 'success');
  },
  async render() {
    const list = document.getElementById('modelList');
    if (!list) return;
    list.innerHTML = '';

    if (state.models.length === 0) {
      list.innerHTML = '<div style="color:var(--dim);text-align:center;padding:32px">No models yet. Click "Add model" to load a GGUF file.</div>';
      return;
    }

    state.models.forEach((model, idx) => {
      const el = document.createElement('div');
      el.className = 'model-item';
      el.innerHTML = `
        <span class="model-item__icon">🧠</span>
        <div class="model-item__info">
          <div class="model-item__name">${model.name}</div>
          <div class="model-item__meta">${model.path}</div>
        </div>
        <span class="model-item__badge ${model.loaded ? 'badge--green' : 'badge--dim'}">
          ${model.loaded ? '✓ Loaded' : 'Click to load'}
        </span>
      `;
      el.addEventListener('click', () => App.models.load_model(idx));
      list.appendChild(el);
    });
  },
};

App.pages = {
  models: () => navigate('models'),
};

// ─── Chat ─────────────────────────────────────────────────────────────────────

App.chat = {
  async send() {
    const input = document.getElementById('chatInput');
    const text  = input?.value.trim();
    if (!text || !state.activeModel) return;

    input.value = '';
    input.style.height = 'auto';
    document.getElementById('sendBtn').disabled = true;

    this.appendMessage('user', text);

    const aiMsgEl = this.appendMessage('ai', '');
    const bubble  = aiMsgEl.querySelector('.msg__bubble');
    bubble.innerHTML = '<span class="spinner"></span>';

    document.getElementById('engineDot').className = 'status-dot yellow';
    document.getElementById('engineStatus').textContent = 'Generating…';

    try {
      // In a real integration, call the engine via IPC.
      // Here we simulate a streaming response for the UI demo.
      await this._simulateStream(bubble, `[Demo response] You said: "${text}". In production, this streams from the LLaMA Ultra engine running locally. Load a model and start the API server to get real responses.`);
    } finally {
      document.getElementById('sendBtn').disabled = false;
      document.getElementById('engineDot').className = 'status-dot green';
      document.getElementById('engineStatus').textContent = `Model: ${state.activeModel.name}`;
    }
  },

  appendMessage(role, text) {
    const container = document.getElementById('chatMessages');
    const div = document.createElement('div');
    div.className = `msg msg--${role}`;
    div.innerHTML = `
      <div class="msg__avatar">${role === 'user' ? '👤' : '⚡'}</div>
      <div class="msg__bubble">${this._escape(text)}</div>
    `;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
    return div;
  },

  async _simulateStream(bubble, fullText) {
    bubble.textContent = '';
    const words = fullText.split(' ');
    let i = 0;
    return new Promise(resolve => {
      const timer = setInterval(() => {
        if (i >= words.length) { clearInterval(timer); resolve(); return; }
        bubble.textContent += (i === 0 ? '' : ' ') + words[i++];
        document.getElementById('chatMessages').scrollTop = 99999;
        document.getElementById('tpsStatus').textContent = `${Math.round(Math.random()*5+10)} t/s`;
      }, 60);
    });
  },

  _escape(str) {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  },
};

// Enter to send
document.getElementById('chatInput')?.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); App.chat.send(); }
});

// Auto-resize textarea
document.getElementById('chatInput')?.addEventListener('input', function () {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 160) + 'px';
});

// ─── Optimize ─────────────────────────────────────────────────────────────────

App.optimize = {
  async browse() {
    if (!api) return;
    const p = await api.dialog.openModel();
    if (p) document.getElementById('optimizeModelPath').value = p;
  },
  async run() {
    const modelPath = document.getElementById('optimizeModelPath')?.value.trim();
    if (!modelPath) { notify('Please select a model file', 'error'); return; }

    const output = document.getElementById('optimizeOutput');
    const log    = document.getElementById('optimizeLog');
    const bar    = document.getElementById('optimizeProgress');
    output.style.display = 'block';
    log.innerHTML = '';
    bar.style.width = '0%';

    const steps = [
      { msg: '  Detecting hardware…',         pct: 10 },
      { msg: '  Reading model file…',         pct: 20 },
      { msg: '  Auto-selecting quantization…', pct: 30 },
      { msg: '  Splitting into chunks…',       pct: 50 },
      { msg: '  Quantizing chunks…',           pct: 75 },
      { msg: '  Building manifest…',           pct: 90 },
      { msg: '  ✓ Optimization complete!',     pct: 100 },
    ];

    for (const step of steps) {
      await new Promise(r => setTimeout(r, 400));
      log.innerHTML += `<div>${step.msg}</div>`;
      bar.style.width = step.pct + '%';
    }
    notify('Model optimized successfully!', 'success');
  },
};

// ─── API Server ───────────────────────────────────────────────────────────────

App.api = {
  toggle() {
    state.apiRunning = !state.apiRunning;
    const btn = document.getElementById('apiStartBtn');
    const txt = document.getElementById('apiStatusText');
    const dot = document.getElementById('engineDot');
    if (state.apiRunning) {
      const port = document.getElementById('apiPort')?.value ?? '3000';
      btn.textContent = 'Stop';
      btn.style.background = 'var(--red)';
      txt.innerHTML = `Running on <code style="font-family:var(--mono)">http://localhost:${port}</code>`;
      dot.className = 'status-dot green';
      notify(`API server started on port ${port}`, 'success');
    } else {
      btn.textContent = 'Start';
      btn.style.background = 'var(--green)';
      txt.textContent = 'Stopped';
      dot.className = 'status-dot';
      notify('API server stopped');
    }
  },
};

// ─── Listen for main process events ──────────────────────────────────────────

if (api) {
  api.on('navigate', (page) => navigate(page));
  api.on('trigger',  (action) => {
    if (action === 'openModel') App.models.add();
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  await App.settings.load();
  await App.models.load();
  await loadHardware();
}

init();
