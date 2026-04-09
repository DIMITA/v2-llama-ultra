'use strict';

/**
 * streaming.js
 * Intelligent token-by-token streaming with back-pressure and adaptive throttle.
 * Works as a Node.js Transform stream so it composes naturally with HTTP / stdio.
 */

const { Transform, Readable } = require('stream');

// ─── Token streamer ───────────────────────────────────────────────────────────

class TokenStreamer extends Transform {
  /**
   * @param {object} opts
   * @param {number} opts.tokensPerSecondTarget  - Desired output speed (0 = unlimited)
   * @param {string} opts.format                 - 'text' | 'json' | 'sse'
   * @param {boolean} opts.echo                  - Whether to echo prompt tokens
   */
  constructor({ tokensPerSecondTarget = 0, format = 'text', echo = false } = {}) {
    super({ objectMode: true });
    this.tokensPerSecondTarget = tokensPerSecondTarget;
    this.format   = format;
    this.echo     = echo;
    this.tokenCount = 0;
    this._startTime = null;
    this._finished = false;
  }

  _transform(token, _enc, cb) {
    if (!this._startTime) this._startTime = Date.now();
    this.tokenCount++;

    const payload = this._formatToken(token);

    if (this.tokensPerSecondTarget > 0) {
      const elapsed   = (Date.now() - this._startTime) / 1000;
      const expected  = this.tokenCount / this.tokensPerSecondTarget;
      const delay     = Math.max(0, (expected - elapsed) * 1000);
      setTimeout(() => { this.push(payload); cb(); }, delay);
    } else {
      this.push(payload);
      cb();
    }
  }

  _flush(cb) {
    this._finished = true;
    if (this.format === 'sse') {
      this.push('data: [DONE]\n\n');
    } else if (this.format === 'json') {
      this.push(JSON.stringify({ done: true, tokenCount: this.tokenCount }) + '\n');
    }
    this.emit('stream:done', { tokenCount: this.tokenCount, elapsed: Date.now() - this._startTime });
    cb();
  }

  _formatToken(token) {
    if (this.format === 'sse') {
      return `data: ${JSON.stringify({ token, index: this.tokenCount })}\n\n`;
    }
    if (this.format === 'json') {
      return JSON.stringify({ token, index: this.tokenCount }) + '\n';
    }
    return token; // plain text
  }

  get tokensPerSecond() {
    if (!this._startTime || this.tokenCount === 0) return 0;
    return +(this.tokenCount / ((Date.now() - this._startTime) / 1000)).toFixed(1);
  }
}

// ─── Inference stream builder ─────────────────────────────────────────────────

/**
 * Wraps a generator function into a readable token stream.
 * generatorFn should be an async generator yielding string tokens.
 */
function createInferenceStream(generatorFn, options = {}) {
  const readable = new Readable({ objectMode: true, read() {} });
  const streamer = new TokenStreamer(options);

  (async () => {
    try {
      for await (const token of generatorFn()) {
        readable.push(token);
      }
      readable.push(null);
    } catch (err) {
      readable.destroy(err);
    }
  })();

  return readable.pipe(streamer);
}

// ─── SSE helper for Express ───────────────────────────────────────────────────

function setupSSE(req, res) {
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(':ok\n\n');

  const heartbeat = setInterval(() => res.write(':ping\n\n'), 15000);
  req.on('close', () => clearInterval(heartbeat));

  return {
    send(data) { res.write(`data: ${JSON.stringify(data)}\n\n`); },
    done()     { res.write('data: [DONE]\n\n'); res.end(); clearInterval(heartbeat); },
    error(msg) { res.write(`data: ${JSON.stringify({ error: msg })}\n\n`); res.end(); clearInterval(heartbeat); },
  };
}

module.exports = { TokenStreamer, createInferenceStream, setupSSE };
