/**
 * Consoleena — Developer Console Agent
 * Version: 2.0.0
 * Author: Surya Sai Varakala
 * License: MIT
 * Repository: https://github.com/suryasticsai/Consoleena
 *
 * A drop-in, console-powered agent that gives ANY web project a Unix-like
 * shell, Playwright-style browser automation, an LLM coding/debugging agent,
 * and the ability to open a GitHub Pull Request from a single prompt.
 *
 *   <script src="consoleena.js"></script>
 *
 *   // Unix-like shell (virtual filesystem over your live page)
 *   cona.sh('ls /')
 *   cona.sh('cat /js/vars | grep version')
 *   cona.sh('find /dom -name button')
 *
 *   // Mini-Playwright automation (works with React controlled inputs)
 *   await cona.$('#email').fill('hi@example.com')
 *   await cona.$('text=Sign in').click()
 *   await cona.page.waitForSelector('.dashboard')
 *   cona.sh('record start')   // …interact…  then:
 *   cona.sh('codegen playwright')   // emits a runnable Playwright test
 *
 *   // AI agent (drives the shell + automation by natural language)
 *   await cona.ai('log in as test@x.com / hunter2 and confirm the dashboard loads')
 *   await cona.sh('fix --apply')     // diagnose recent errors and propose a fix
 *
 *   // Raise a PR by prompt
 *   cona.sh('gh login ghp_xxx')
 *   cona.sh('gh repo suryasticsai/Consoleena#main')
 *   await cona.pr('add a dark-mode toggle to the navbar')
 *
 *   // Keyboard: Ctrl+Shift+K to toggle the panel
 *
 * SAFETY: this is a developer tool. The shell can read/modify the page,
 * execute JS, send page context to an LLM endpoint, and (with a token) push
 * to GitHub. Load it in dev/staging only. The AI agent will NOT run
 * token-touching commands (gh / pr) on its own unless you set
 * CONFIG.agent.autoApprove = true.
 */

(function () {
  'use strict';

  // ============================================================
  // 0. PRESERVE ORIGINALS (so our patches never recurse)
  // ============================================================
  const _console = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: (console.debug || console.log).bind(console),
  };
  const _fetch = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;

  // ============================================================
  // 1. CONFIGURATION
  // ============================================================
  const CONFIG = {
    version: '2.0.0',
    // LLM (OpenAI-compatible chat completions, or Pollinations by default)
    llm: {
      endpoint: 'https://text.pollinations.ai/openai',
      model: 'openai',
      apiKey: null,              // set to use OpenAI/Groq/OpenRouter/etc.
      headers: {},               // extra headers if your gateway needs them
      timeout: 90000,
      temperature: 0.3,
    },
    agent: {
      maxSteps: 6,               // planning iterations
      autoApprove: false,        // if false, agent will not run gh/pr by itself
    },
    github: {
      token: null,               // set via `gh login <token>` (never logged)
      owner: null,
      repo: null,
      base: null,                // defaults to repo default branch
      persistToken: false,       // if true, token is saved to localStorage (less safe)
    },
    automation: {
      defaultTimeout: 5000,      // ms for waits/auto-waiting actions
      typeDelay: 20,             // ms between keystrokes for `type`
      highlightMs: 1800,
    },
    limits: {
      dom: 400, css: 200, vars: 300, funcs: 80, classes: 40,
      logBuffer: 500, netBuffer: 300,
    },
    accent: '#6C63FF',
    storageKey: 'consoleena.config',
  };

  // ============================================================
  // 2. STATE
  // ============================================================
  const state = {
    context: null,
    history: [],          // command history (shell)
    chat: [],             // agent chat history
    logs: [],             // captured console logs
    errors: [],           // captured errors
    network: [],          // captured requests
    recording: false,
    recorded: [],         // recorded interaction steps
    cwd: ['/'],           // shell working directory (array of segments, [/] = root)
    env: { USER: 'dev', SHELL: 'consoleena', PWD: '/' },
    aliases: {},
    lastSelector: null,
    busy: false,
    mode: 'sh',           // 'sh' | 'ai'
  };

  // load persisted config (endpoint/model/repo + token if user opted in)
  try {
    const saved = JSON.parse(localStorage.getItem(CONFIG.storageKey) || 'null');
    if (saved) {
      if (saved.llm) Object.assign(CONFIG.llm, saved.llm);
      if (saved.agent) Object.assign(CONFIG.agent, saved.agent);
      if (saved.github) Object.assign(CONFIG.github, saved.github);
    }
  } catch (e) { /* ignore */ }

  // ============================================================
  // 3. UTILITIES
  // ============================================================
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isEl = (x) => x instanceof Element;
  const esc = (s) =>
    String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function clip(s, n = 200) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  function persistConfig() {
    try {
      const out = {
        llm: { endpoint: CONFIG.llm.endpoint, model: CONFIG.llm.model, apiKey: CONFIG.llm.apiKey },
        agent: { autoApprove: CONFIG.agent.autoApprove },
        github: {
          owner: CONFIG.github.owner, repo: CONFIG.github.repo, base: CONFIG.github.base,
          persistToken: CONFIG.github.persistToken,
          token: CONFIG.github.persistToken ? CONFIG.github.token : null,
        },
      };
      localStorage.setItem(CONFIG.storageKey, JSON.stringify(out));
    } catch (e) { /* ignore */ }
  }

  // Extract a JSON object/array from a (possibly fenced/noisy) LLM string.
  function extractJSON(s) {
    if (s == null) return null;
    let t = String(s).trim().replace(/^```(?:json)?/i, '').replace(/```$/m, '').trim();
    const cands = ['{', '['].map((c) => { const i = t.indexOf(c); return i === -1 ? Infinity : i; });
    const start = Math.min(...cands);
    if (!isFinite(start)) return null;
    const open = t[start], close = open === '{' ? '}' : ']';
    let depth = 0, end = -1, inStr = false, esc2 = false, q = '';
    for (let i = start; i < t.length; i++) {
      const c = t[i];
      if (inStr) {
        if (esc2) esc2 = false;
        else if (c === '\\') esc2 = true;
        else if (c === q) inStr = false;
        continue;
      }
      if (c === '"' || c === "'") { inStr = true; q = c; continue; }
      if (c === open) depth++;
      else if (c === close) { depth--; if (depth === 0) { end = i; break; } }
    }
    let sub = end === -1 ? t.slice(start) : t.slice(start, end + 1);
    sub = sub.replace(/,\s*([}\]])/g, '$1'); // strip trailing commas
    try { return JSON.parse(sub); }
    catch (e) { try { return JSON.parse(sub.replace(/'/g, '"')); } catch (e2) { return null; } }
  }

  // Build a reasonably stable, unique CSS selector for an element.
  function uniqueSelector(el) {
    if (!isEl(el)) return null;
    if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + CSS.escape(el.id);
    const testid = el.getAttribute && (el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-cy'));
    if (testid) return `[data-testid="${testid}"]`;
    const aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria) { const s = `${el.tagName.toLowerCase()}[aria-label="${aria}"]`; if (document.querySelectorAll(s).length === 1) return s; }
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      let part = node.tagName.toLowerCase();
      const cls = (node.className && typeof node.className === 'string')
        ? node.className.trim().split(/\s+/).filter((c) => c && !/\d{3,}|active|open|hover|focus/.test(c)).slice(0, 2)
        : [];
      if (cls.length) part += '.' + cls.map((c) => CSS.escape(c)).join('.');
      const parent = node.parentNode;
      if (parent) {
        const sibs = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      if (document.querySelectorAll(parts.join(' > ')).length === 1) break;
      node = parent;
    }
    return parts.join(' > ');
  }

  function visibleText(el) {
    if (!isEl(el)) return '';
    return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function isVisible(el) {
    if (!isEl(el)) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  }

  // ============================================================
  // 4. SELECTOR ENGINE (CSS + text= + aria= + role=)
  // ============================================================
  function queryAll(selector, root) {
    root = root || document;
    if (isEl(selector)) return [selector];
    if (Array.isArray(selector)) return selector.filter(isEl);
    let sel = String(selector || '').trim();

    if (sel.startsWith('css=')) sel = sel.slice(4).trim();

    if (sel.startsWith('text=')) {
      const needle = sel.slice(5).trim().replace(/^["'`]|["'`]$/g, '');
      const exact = [], partial = [];
      root.querySelectorAll('body *').forEach((el) => {
        if (el.closest('#consoleena-panel,#consoleena-toggle')) return;
        const own = ownText(el);
        if (!own) return;
        if (own === needle) exact.push(el);
        else if (own.includes(needle)) partial.push(el);
      });
      const pick = exact.length ? exact : partial;
      // most specific = fewest element descendants
      return pick.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);
    }

    if (sel.startsWith('aria=')) {
      const needle = sel.slice(5).trim().replace(/^["'`]|["'`]$/g, '');
      return [...root.querySelectorAll('[aria-label]')].filter((el) => el.getAttribute('aria-label') === needle);
    }

    if (sel.startsWith('role=')) {
      const role = sel.slice(5).trim().replace(/^["'`]|["'`]$/g, '');
      const map = { button: 'button,[role=button]', link: 'a,[role=link]', textbox: 'input,textarea,[role=textbox]', checkbox: 'input[type=checkbox],[role=checkbox]', heading: 'h1,h2,h3,h4,h5,h6,[role=heading]' };
      return [...root.querySelectorAll(map[role] || `[role=${CSS.escape(role)}]`)];
    }

    try { return [...root.querySelectorAll(sel)]; }
    catch (e) { return []; }
  }

  function ownText(el) {
    // text directly in this element (not from element children) — better for text= matching
    let t = '';
    el.childNodes.forEach((n) => { if (n.nodeType === 3) t += n.textContent; });
    t = t.replace(/\s+/g, ' ').trim();
    return t || visibleText(el);
  }

  // ============================================================
  // 5. EVENT SIMULATION (React-friendly)
  // ============================================================
  function fireMouse(el, type) {
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, view: window,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
    }));
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  const KEYCODES = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, ' ': 32, Space: 32 };
  function fireKey(el, key) {
    const code = KEYCODES[key] || (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
    const init = { bubbles: true, cancelable: true, key, keyCode: code, which: code, view: window };
    el.dispatchEvent(new KeyboardEvent('keydown', init));
    if (key.length === 1) el.dispatchEvent(new KeyboardEvent('keypress', init));
    el.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  function flash(el, ok = true) {
    if (!isEl(el)) return;
    const o = el.style.outline, b = el.style.background, t = el.style.transition;
    el.style.transition = 'all .25s ease';
    el.style.outline = `3px solid ${ok ? CONFIG.accent : '#ff5c6c'}`;
    el.style.outlineOffset = '2px';
    el.style.background = ok ? 'rgba(108,99,255,.10)' : 'rgba(255,92,108,.10)';
    setTimeout(() => { el.style.outline = o || ''; el.style.background = b || ''; el.style.transition = t || ''; }, CONFIG.automation.highlightMs);
  }

  // ============================================================
  // 6. LOCATOR (Playwright-style, chainable, auto-waiting)
  // ============================================================
  class Locator {
    constructor(selector, opts = {}) {
      this.selector = selector;
      this.opts = opts;
      state.lastSelector = typeof selector === 'string' ? selector : state.lastSelector;
    }
    all() { return queryAll(this.selector); }
    el() { const a = this.all(); return this.opts.index != null ? a[this.opts.index] : a[0]; }
    nth(i) { return new Locator(this.selector, { ...this.opts, index: i }); }
    first() { return this.nth(0); }
    last() { return new Locator(this.selector, { ...this.opts, index: this.all().length - 1 }); }
    count() { return this.all().length; }

    async waitFor({ visible = true, timeout = CONFIG.automation.defaultTimeout } = {}) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        const el = this.el();
        if (el && (!visible || isVisible(el))) return el;
        await sleep(60);
      }
      const el = this.el();
      if (el) return el; // present but maybe not "visible"
      throw new Error(`Timeout ${timeout}ms waiting for ${this.selector}`);
    }
    async _ready() { const el = await this.waitFor(); el.scrollIntoView({ block: 'center', behavior: 'instant' }); return el; }

    async click() {
      const el = await this._ready();
      fireMouse(el, 'mouseover'); fireMouse(el, 'mousedown'); fireMouse(el, 'mouseup');
      el.focus && el.focus();
      el.click();
      flash(el);
      record('click', el);
      return this;
    }
    async dblclick() { const el = await this._ready(); el.click(); fireMouse(el, 'dblclick'); record('dblclick', el); return this; }
    async hover() { const el = await this._ready(); fireMouse(el, 'mouseover'); fireMouse(el, 'mousemove'); flash(el); return this; }

    async fill(value) {
      const el = await this._ready();
      el.focus && el.focus();
      setNativeValue(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      setNativeValue(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      flash(el);
      record('fill', el, value);
      return this;
    }
    async type(text, { delay = CONFIG.automation.typeDelay } = {}) {
      const el = await this._ready();
      el.focus && el.focus();
      for (const ch of String(text)) {
        setNativeValue(el, (el.value || '') + ch);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        fireKey(el, ch);
        if (delay) await sleep(delay);
      }
      el.dispatchEvent(new Event('change', { bubbles: true }));
      record('fill', el, text);
      return this;
    }
    async press(key) { const el = await this._ready(); fireKey(el, key); record('press', el, key); return this; }
    async clear() { return this.fill(''); }

    async check() { const el = await this._ready(); if (!el.checked) { el.click(); } record('check', el); return this; }
    async uncheck() { const el = await this._ready(); if (el.checked) { el.click(); } record('uncheck', el); return this; }
    async selectOption(value) {
      const el = await this._ready();
      setNativeValue(el, value);
      [...el.options || []].forEach((o) => { o.selected = (o.value === value || o.text === value); });
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      record('select', el, value);
      return this;
    }
    async scrollIntoView() { const el = await this.waitFor(); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); return this; }
    highlight() { const el = this.el(); flash(el); return this; }

    text() { const el = this.el(); return el ? visibleText(el) : null; }
    getAttribute(name) { const el = this.el(); return el ? el.getAttribute(name) : null; }
    value() { const el = this.el(); return el ? el.value : null; }
    isVisible() { return isVisible(this.el()); }
    isChecked() { const el = this.el(); return !!(el && el.checked); }

    async assertVisible() { const el = await this.waitFor({ visible: true }).catch(() => null); if (!isVisible(el)) throw new Error(`Assertion failed: ${this.selector} is not visible`); return true; }
    async assertHidden() { await sleep(0); if (isVisible(this.el())) throw new Error(`Assertion failed: ${this.selector} is visible`); return true; }
    async assertText(expected) {
      await this.waitFor().catch(() => null);
      const t = this.text() || '';
      if (!t.includes(expected)) throw new Error(`Assertion failed: "${clip(t, 60)}" does not contain "${expected}"`);
      return true;
    }
    assertCount(n) { const c = this.count(); if (c !== n) throw new Error(`Assertion failed: expected ${n} got ${c} for ${this.selector}`); return true; }
  }

  // ============================================================
  // 7. PAGE API (Playwright-style)
  // ============================================================
  const page = {
    url: () => location.href,
    title: () => document.title,
    goto: (url) => { location.href = url; return `navigating to ${url} (page will reload)`; },
    reload: () => { location.reload(); },
    back: () => { history.back(); },
    forward: () => { history.forward(); },
    scrollTo: (x, y) => { window.scrollTo(x || 0, y || 0); },
    scrollBy: (x, y) => { window.scrollBy(x || 0, y || 0); },
    waitForTimeout: (ms) => sleep(ms),
    waitForSelector: (sel, opts) => new Locator(sel).waitFor(opts),
    locator: (sel) => new Locator(sel),
    evaluate: (fn) => (typeof fn === 'function' ? fn() : eval(String(fn))),
    async screenshot(opts = {}) {
      const el = opts.selector ? new Locator(opts.selector).el() : document.body;
      if (!el) throw new Error('screenshot target not found');
      if (typeof window.html2canvas === 'function') {
        const canvas = await window.html2canvas(el, { logging: false, useCORS: true });
        return canvas.toDataURL('image/png');
      }
      // fallback: SVG foreignObject (same-origin styles only; best-effort)
      try {
        const r = el.getBoundingClientRect();
        const html = new XMLSerializer().serializeToString(el);
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(r.width)}" height="${Math.ceil(r.height)}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml">${html}</div></foreignObject></svg>`;
        return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      } catch (e) {
        throw new Error('screenshot needs html2canvas for pixel-perfect output (include it on the page). Falling back failed: ' + e.message);
      }
    },
    // Compact, LLM-friendly snapshot of what is currently visible/interactive.
    snapshot() {
      const out = [];
      const sel = 'a,button,input,textarea,select,[role=button],[onclick],h1,h2,h3,[data-testid]';
      document.querySelectorAll(sel).forEach((el) => {
        if (el.closest('#consoleena-panel,#consoleena-toggle')) return;
        if (!isVisible(el)) return;
        const tag = el.tagName.toLowerCase();
        const label = visibleText(el) || el.getAttribute('aria-label') || el.placeholder || el.name || el.value || '';
        out.push({ tag, sel: uniqueSelector(el), label: clip(label, 50), type: el.type || undefined, disabled: el.disabled || undefined });
      });
      return out.slice(0, 80);
    },
  };

  // ============================================================
  // 8. INSPECTOR / DEBUGGER (console, errors, network)
  // ============================================================
  function installInspector() {
    ['log', 'info', 'warn', 'error', 'debug'].forEach((level) => {
      const orig = _console[level];
      console[level] = function (...args) {
        try {
          state.logs.push({ level, ts: Date.now(), text: args.map(fmtArg).join(' ') });
          if (state.logs.length > CONFIG.limits.logBuffer) state.logs.shift();
          renderTabIfVisible('logs');
        } catch (e) { /* ignore */ }
        return orig(...args);
      };
    });

    window.addEventListener('error', (e) => {
      state.errors.push({ ts: Date.now(), message: e.message, source: e.filename, line: e.lineno, col: e.colno, stack: e.error && e.error.stack });
      if (state.errors.length > 100) state.errors.shift();
      renderTabIfVisible('logs');
    });
    window.addEventListener('unhandledrejection', (e) => {
      const reason = e.reason || {};
      state.errors.push({ ts: Date.now(), message: 'Unhandled promise rejection: ' + (reason.message || reason), stack: reason.stack });
      if (state.errors.length > 100) state.errors.shift();
    });

    if (_fetch) {
      window.fetch = async function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const method = (init && init.method) || (input && input.method) || 'GET';
        const t0 = performance.now();
        try {
          const res = await _fetch(input, init);
          pushNet({ method, url, status: res.status, ok: res.ok, ms: Math.round(performance.now() - t0), type: 'fetch' });
          return res;
        } catch (err) {
          pushNet({ method, url, status: 0, ok: false, ms: Math.round(performance.now() - t0), type: 'fetch', error: err.message });
          throw err;
        }
      };
    }
    // XHR
    const _open = XMLHttpRequest.prototype.open, _send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) { this.__cona = { method: m, url: u, t0: 0 }; return _open.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function () {
      if (this.__cona) {
        this.__cona.t0 = performance.now();
        this.addEventListener('loadend', () => {
          pushNet({ method: this.__cona.method, url: this.__cona.url, status: this.status, ok: this.status >= 200 && this.status < 400, ms: Math.round(performance.now() - this.__cona.t0), type: 'xhr' });
        });
      }
      return _send.apply(this, arguments);
    };
  }
  function pushNet(rec) { state.network.push(rec); if (state.network.length > CONFIG.limits.netBuffer) state.network.shift(); renderTabIfVisible('network'); }
  function fmtArg(a) {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack || a.message;
    try { return JSON.stringify(a); } catch (e) { return String(a); }
  }

  // ============================================================
  // 9. CONTEXT EXTRACTION
  // ============================================================
  function extractProjectContext() {
    const ctx = {
      variables: extractVariables(),
      functions: extractFunctions(),
      classes: extractClasses(),
      domElements: extractDOM(),
      cssRules: extractCSS(),
      storage: extractStorage(),
      cookies: document.cookie,
      metadata: {
        title: document.title, url: location.href, referrer: document.referrer,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        readyState: document.readyState, charset: document.characterSet, lang: document.documentElement.lang,
        userAgent: navigator.userAgent,
      },
    };
    state.context = ctx;
    return ctx;
  }
  function extractVariables() {
    const vars = [];
    const skip = new Set(['window', 'self', 'globalThis', 'document', 'console', 'alert', 'confirm', 'prompt', 'Consoleena', 'cona']);
    for (const key in window) {
      try {
        if (skip.has(key)) continue;
        const val = window[key];
        if (typeof val === 'function') continue;
        let display = val;
        if (val && typeof val === 'object') { try { display = clip(JSON.stringify(val), 200); } catch (e) { display = '[object]'; } }
        vars.push({ name: key, value: display, type: typeof val, isObject: !!val && typeof val === 'object', isArray: Array.isArray(val) });
      } catch (e) { /* ignore */ }
    }
    return vars.slice(0, CONFIG.limits.vars);
  }
  function extractFunctions() {
    const funcs = [];
    for (const key in window) {
      try {
        if (typeof window[key] !== 'function') continue;
        const fn = window[key];
        const m = fn.toString().match(/\(([^)]*)\)/);
        const params = m ? m[1].split(',').map((p) => p.trim()).filter(Boolean) : [];
        funcs.push({ name: key, params, isAsync: fn.constructor.name === 'AsyncFunction' });
      } catch (e) { /* ignore */ }
    }
    return funcs.slice(0, CONFIG.limits.funcs);
  }
  function extractClasses() {
    const classes = [];
    for (const key in window) {
      try {
        const val = window[key];
        if (typeof val === 'function' && val.prototype && val.prototype.constructor) {
          const name = val.name || key;
          if (name && name[0] === name[0].toUpperCase()) {
            const methods = Object.getOwnPropertyNames(val.prototype).filter((mm) => mm !== 'constructor' && typeof val.prototype[mm] === 'function');
            if (methods.length) classes.push({ name, methods });
          }
        }
      } catch (e) { /* ignore */ }
    }
    return classes.slice(0, CONFIG.limits.classes);
  }
  function extractDOM() {
    const els = [];
    document.querySelectorAll('*').forEach((el) => {
      if (el.closest('#consoleena-panel,#consoleena-toggle')) return;
      const info = { tag: el.tagName.toLowerCase(), id: el.id || null, classes: (el.className && typeof el.className === 'string') ? el.className.split(/\s+/).filter(Boolean) : [], attributes: {} };
      for (const a of el.attributes || []) if (a.name !== 'class' && a.name !== 'id') info.attributes[a.name] = a.value;
      const t = visibleText(el); if (t) info.textPreview = clip(t, 80);
      info.childCount = el.children.length;
      els.push(info);
    });
    return els.slice(0, CONFIG.limits.dom);
  }
  function extractCSS() {
    const rules = [];
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules || []) {
          if (rule.type === 1) {
            const properties = [];
            for (let i = 0; i < rule.style.length; i++) { const p = rule.style[i]; properties.push({ name: p, value: rule.style.getPropertyValue(p) }); }
            rules.push({ selector: rule.selectorText, properties });
          }
        }
      } catch (e) { /* cross-origin */ }
    }
    return rules.slice(0, CONFIG.limits.css);
  }
  function extractStorage() {
    const read = (s) => { const o = {}; try { for (let i = 0; i < s.length; i++) { const k = s.key(i); o[k] = clip(s.getItem(k), 120); } } catch (e) { } return o; };
    return { local: read(localStorage), session: read(sessionStorage) };
  }

  // ============================================================
  // 10. VIRTUAL FILESYSTEM (over the live page)
  // ============================================================
  function buildVFS() {
    const ctx = extractProjectContext();
    const fileList = (arr, fmt) => arr.map(fmt).join('\n') || '(empty)';
    const tree = {
      type: 'dir',
      children: {
        page: file(() => Object.entries(ctx.metadata).map(([k, v]) => `${k}: ${v}`).join('\n')),
        dom: file(() => fileList(ctx.domElements, (e) => {
          const id = e.id ? '#' + e.id : '';
          const cl = e.classes.length ? '.' + e.classes.join('.') : '';
          return `<${e.tag}${id}${cl}>${e.textPreview ? '  — ' + e.textPreview : ''}`;
        })),
        css: file(() => fileList(ctx.cssRules, (r) => `${r.selector} { ${r.properties.slice(0, 4).map((p) => p.name + ': ' + p.value).join('; ')}${r.properties.length > 4 ? '; …' : ''} }`)),
        cookies: file(() => ctx.cookies || '(none)'),
        network: file(() => fileList(state.network.slice(-50), (n) => `${n.method} ${n.status} ${n.ms}ms  ${n.url}`)),
        console: file(() => fileList(state.logs.slice(-80), (l) => `[${l.level}] ${l.text}`)),
        errors: file(() => fileList(state.errors.slice(-40), (e) => `${e.message}${e.source ? '  (' + e.source + ':' + e.line + ')' : ''}`)),
        perf: file(() => {
          const t = performance.timing || {};
          const nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
          if (nav) return `domContentLoaded: ${Math.round(nav.domContentLoadedEventEnd)}ms\nload: ${Math.round(nav.loadEventEnd)}ms\ntransferSize: ${nav.transferSize}`;
          return `domInteractive: ${(t.domInteractive - t.navigationStart) || '?'}ms`;
        }),
        js: {
          type: 'dir', children: {
            vars: file(() => fileList(ctx.variables, (v) => `${v.name} = ${typeof v.value === 'string' ? `'${v.value}'` : JSON.stringify(v.value)}  (${v.type})`)),
            functions: file(() => fileList(ctx.functions, (f) => `${f.isAsync ? 'async ' : ''}${f.name}(${f.params.join(', ')})`)),
            classes: file(() => fileList(ctx.classes, (c) => `class ${c.name} { ${c.methods.join(', ')} }`)),
          },
        },
        storage: {
          type: 'dir', children: {
            local: file(() => fileList(Object.entries(ctx.storage.local), ([k, v]) => `${k} = ${v}`)),
            session: file(() => fileList(Object.entries(ctx.storage.session), ([k, v]) => `${k} = ${v}`)),
          },
        },
      },
    };
    return tree;
  }
  function file(read) { return { type: 'file', read }; }

  function resolvePath(input) {
    const cwd = state.cwd;
    let segs;
    if (!input || input === '.') segs = cwd.slice();
    else if (input.startsWith('/')) segs = ['/'].concat(input.split('/').filter(Boolean));
    else segs = cwd.concat(input.split('/').filter(Boolean));
    const out = ['/'];
    for (const s of segs) { if (s === '/' || s === '') continue; if (s === '..') { if (out.length > 1) out.pop(); } else if (s !== '.') out.push(s); }
    return out;
  }
  function nodeAt(segs) {
    const vfs = buildVFS();
    let node = vfs;
    for (let i = 1; i < segs.length; i++) {
      if (!node || node.type !== 'dir') return null;
      node = node.children[segs[i]];
    }
    return node || null;
  }
  function pathStr(segs) { return segs.length <= 1 ? '/' : '/' + segs.slice(1).join('/'); }

  // ============================================================
  // 11. RECORDER + CODEGEN (Mini-Playwright magic)
  // ============================================================
  function record(action, el, value) {
    if (!state.recording) return;
    const sel = isEl(el) ? uniqueSelector(el) : el;
    state.recorded.push({ action, selector: sel, value, ts: Date.now() });
    renderTabIfVisible('recorder');
  }
  function attachRecorder() {
    const handler = (e) => {
      if (!state.recording) return;
      const el = e.target;
      if (!isEl(el) || el.closest('#consoleena-panel,#consoleena-toggle')) return;
      if (e.type === 'click') {
        const tag = el.tagName.toLowerCase();
        if (['input', 'textarea', 'select'].includes(tag) && el.type !== 'checkbox' && el.type !== 'radio' && el.type !== 'submit' && el.type !== 'button') return; // captured by change
        state.recorded.push({ action: 'click', selector: uniqueSelector(el), ts: Date.now() });
      } else if (e.type === 'change') {
        const tag = el.tagName.toLowerCase();
        if (tag === 'select') state.recorded.push({ action: 'select', selector: uniqueSelector(el), value: el.value, ts: Date.now() });
        else if (el.type === 'checkbox') state.recorded.push({ action: el.checked ? 'check' : 'uncheck', selector: uniqueSelector(el), ts: Date.now() });
        else state.recorded.push({ action: 'fill', selector: uniqueSelector(el), value: el.value, ts: Date.now() });
      }
      renderTabIfVisible('recorder');
    };
    document.addEventListener('click', handler, true);
    document.addEventListener('change', handler, true);
  }
  function codegen(flavor) {
    flavor = (flavor || 'playwright').toLowerCase();
    const steps = state.recorded;
    if (flavor === 'consoleena') {
      const lines = [`// Consoleena replay — ${steps.length} steps`];
      steps.forEach((s) => {
        if (s.action === 'click') lines.push(`await cona.$(${q(s.selector)}).click();`);
        else if (s.action === 'fill') lines.push(`await cona.$(${q(s.selector)}).fill(${q(s.value)});`);
        else if (s.action === 'select') lines.push(`await cona.$(${q(s.selector)}).selectOption(${q(s.value)});`);
        else if (s.action === 'check') lines.push(`await cona.$(${q(s.selector)}).check();`);
        else if (s.action === 'uncheck') lines.push(`await cona.$(${q(s.selector)}).uncheck();`);
        else if (s.action === 'press') lines.push(`await cona.$(${q(s.selector)}).press(${q(s.value)});`);
      });
      return lines.join('\n');
    }
    // Playwright
    const lines = [
      `import { test, expect } from '@playwright/test';`, '',
      `test('recorded flow', async ({ page }) => {`,
      `  await page.goto(${q(location.href)});`,
    ];
    steps.forEach((s) => {
      const loc = `page.locator(${q(s.selector)})`;
      if (s.action === 'click') lines.push(`  await ${loc}.click();`);
      else if (s.action === 'fill') lines.push(`  await ${loc}.fill(${q(s.value)});`);
      else if (s.action === 'select') lines.push(`  await ${loc}.selectOption(${q(s.value)});`);
      else if (s.action === 'check') lines.push(`  await ${loc}.check();`);
      else if (s.action === 'uncheck') lines.push(`  await ${loc}.uncheck();`);
      else if (s.action === 'press') lines.push(`  await ${loc}.press(${q(s.value)});`);
    });
    lines.push('});');
    return lines.join('\n');
  }
  function q(s) { return `'${String(s == null ? '' : s).replace(/'/g, "\\'")}'`; }

  // ============================================================
  // 12. LLM + AGENT
  // ============================================================
  async function callLLM(messages, opts = {}) {
    const cfg = CONFIG.llm;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeout);
    try {
      const body = { model: cfg.model, messages, temperature: opts.temperature ?? cfg.temperature };
      if (opts.json) body.response_format = { type: 'json_object' };
      const headers = { 'Content-Type': 'application/json', ...(cfg.headers || {}) };
      if (cfg.apiKey) headers.Authorization = 'Bearer ' + cfg.apiKey;
      const res = await fetch(cfg.endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
      const txt = await res.text();
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${clip(txt, 200)}`);
      try {
        const data = JSON.parse(txt);
        if (data && data.choices && data.choices[0] && data.choices[0].message) return data.choices[0].message.content || '';
        if (typeof data === 'string') return data;
        if (data && data.content) return typeof data.content === 'string' ? data.content : JSON.stringify(data.content);
        return txt;
      } catch (e) { return txt; }
    } finally { clearTimeout(timer); }
  }

  function agentToolList() {
    // Surface a curated, safe-to-plan set of shell commands to the model.
    const useful = ['ls', 'cat', 'grep', 'find', 'tree', 'get', 'set', 'run', 'eval',
      'click', 'fill', 'type', 'press', 'hover', 'select', 'check', 'uncheck',
      'wait', 'assert', 'count', 'text', 'attr', 'snapshot', 'highlight',
      'reload', 'logs', 'errors', 'net', 'vars', 'funcs'];
    return useful.filter((c) => COMMANDS[c]).map((c) => `  ${c} — ${COMMANDS[c].desc}`).join('\n');
  }

  async function agent(prompt, { print = consolePrint } = {}) {
    if (!prompt) return;
    extractProjectContext();
    const sys = [
      'You are Consoleena, an autonomous browser agent embedded in a live web page.',
      'You operate the page through a Unix-like shell. Available commands:',
      agentToolList(),
      '',
      'Notes: selectors accept CSS, text=..., role=..., aria=.... Use snapshot to see interactive elements.',
      'Reply with ONLY a JSON object, no prose, in this exact shape:',
      '{ "reasoning": "<short>", "commands": ["cmd1", "cmd2"], "answer": "<final answer or empty>", "done": <true|false> }',
      'Run at most 3 commands per turn. Set done=true only when the task is complete or you have the answer.',
      'NEVER guess selectors blindly — call `snapshot` first if unsure.',
    ].join('\n');

    const observations = [
      `URL: ${location.href}`,
      `Title: ${document.title}`,
      `Interactive snapshot:\n${JSON.stringify(page.snapshot()).slice(0, 1500)}`,
    ].join('\n');

    const convo = [
      { role: 'system', content: sys },
      { role: 'user', content: `TASK: ${prompt}\n\nCURRENT PAGE STATE:\n${observations}` },
    ];

    print(`<span class="c-dim">agent ▸ planning…</span>`, { html: true });
    for (let step = 0; step < CONFIG.agent.maxSteps; step++) {
      let raw;
      try { raw = await callLLM(convo, { json: true }); }
      catch (e) { print(`<span class="c-err">agent ▸ LLM error: ${esc(e.message)}</span>`, { html: true }); return; }
      const plan = extractJSON(raw);
      if (!plan) { print(`<span class="c-err">agent ▸ could not parse plan.</span> <span class="c-dim">${esc(clip(raw, 160))}</span>`, { html: true }); return; }
      if (plan.reasoning) print(`<span class="c-dim">agent ▸ ${esc(plan.reasoning)}</span>`, { html: true });

      const results = [];
      for (const cmd of (plan.commands || []).slice(0, 3)) {
        const head = String(cmd).trim().split(/\s+/)[0];
        if (!CONFIG.agent.autoApprove && (head === 'gh' || head === 'pr')) {
          print(`<span class="c-warn">agent ▸ proposes:</span> <code>${esc(cmd)}</code> <span class="c-dim">(blocked — run it yourself or set CONFIG.agent.autoApprove=true)</span>`, { html: true });
          results.push(`${cmd} -> BLOCKED (requires human approval)`);
          continue;
        }
        print(`<span class="c-accent">agent ❯</span> <code>${esc(cmd)}</code>`, { html: true });
        let out;
        try { const r = await runLine(cmd, { echo: false, fromAgent: true }); out = (r && r.text) || ''; }
        catch (e) { out = 'ERROR: ' + e.message; }
        const plain = stripHtml(out);
        if (plain.trim()) print(`<span class="c-dim">${esc(clip(plain, 400))}</span>`, { html: true });
        results.push(`$ ${cmd}\n${clip(plain, 600)}`);
      }

      if (plan.answer) print(`<span class="c-ok">agent ▸ ${esc(plan.answer)}</span>`, { html: true });
      if (plan.done || !(plan.commands || []).length) return plan.answer || '(done)';

      convo.push({ role: 'assistant', content: raw });
      convo.push({ role: 'user', content: `OBSERVATIONS:\n${results.join('\n\n')}\n\nContinue. Reply JSON only.` });
    }
    print(`<span class="c-warn">agent ▸ reached max steps (${CONFIG.agent.maxSteps}).</span>`, { html: true });
  }
  function stripHtml(s) { const d = document.createElement('div'); d.innerHTML = String(s == null ? '' : s); return d.textContent || ''; }

  // ---- debug helpers (explain / fix) ----
  async function aiExplain(targetArg) {
    let subject;
    if (targetArg) {
      const els = queryAll(targetArg);
      subject = els.length ? `Element ${uniqueSelector(els[0])}:\n${els[0].outerHTML.slice(0, 800)}` : `Selector "${targetArg}" matched nothing.`;
    } else {
      subject = `Recent errors:\n${state.errors.slice(-5).map((e) => e.message + (e.stack ? '\n' + clip(e.stack, 400) : '')).join('\n\n') || '(none)'}`;
    }
    const out = await callLLM([
      { role: 'system', content: 'You are a senior web debugger. Be concise and concrete.' },
      { role: 'user', content: `Explain this and suggest next steps.\n\n${subject}` },
    ]);
    return { text: out };
  }
  async function aiFix(apply) {
    if (!state.errors.length) return { text: 'No captured errors to fix. Trigger the bug, then run `fix` again.' };
    const errs = state.errors.slice(-3).map((e) => `${e.message}${e.stack ? '\n' + clip(e.stack, 500) : ''}${e.source ? `\n@ ${e.source}:${e.line}:${e.col}` : ''}`).join('\n\n');
    const ctx = `Page: ${location.href}\nGlobals: ${state.context ? state.context.variables.slice(0, 15).map((v) => v.name).join(', ') : ''}`;
    const out = await callLLM([
      { role: 'system', content: 'You are a senior engineer. Diagnose the root cause and give a minimal, copy-pasteable fix (code). If the fix is a runtime patch, also give a Consoleena `set`/`run`/`eval` command to apply it live.' },
      { role: 'user', content: `Errors:\n${errs}\n\nContext:\n${ctx}` },
    ]);
    if (apply) {
      // best-effort: pull a fenced JS block and eval it live
      const m = out.match(/```(?:js|javascript)?\n([\s\S]*?)```/i);
      if (m) {
        try { const r = eval(m[1]); return { text: out + `\n\n[applied live] result: ${fmtArg(r)}` }; }
        catch (e) { return { text: out + `\n\n[apply failed] ${e.message}` }; }
      }
    }
    return { text: out };
  }

  // ============================================================
  // 13. GITHUB PR
  // ============================================================
  async function gh(pathname, { method = 'GET', body } = {}) {
    const g = CONFIG.github;
    if (!g.token) throw new Error('No GitHub token. Run: gh login <token>');
    const res = await fetch('https://api.github.com' + pathname, {
      method,
      headers: {
        Authorization: 'Bearer ' + g.token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch (e) { data = text; }
    if (!res.ok) { const e = new Error(`GitHub ${res.status}: ${(data && data.message) || clip(text, 160)}`); e.status = res.status; throw e; }
    return data;
  }
  const b64 = (str) => btoa(unescape(encodeURIComponent(str)));

  async function openPR(instruction, { yes = false, print = consolePrint } = {}) {
    const g = CONFIG.github;
    if (!g.token) return { text: '❌ Run `gh login <token>` first (PAT needs `repo` or fine-grained Contents+PR write).' };
    if (!g.owner || !g.repo) return { text: '❌ Run `gh repo owner/name[#base]` first.' };
    if (!instruction) return { text: '❌ Provide an instruction, e.g. pr "add a footer with copyright".' };

    print(`<span class="c-dim">pr ▸ asking the model for a patch…</span>`, { html: true });
    const sys = [
      'You generate GitHub pull requests. Output ONLY JSON, no prose.',
      'Shape:',
      '{ "branch": "feature/short-kebab", "title": "<PR title>", "body": "<markdown summary>", "commit_message": "<msg>",',
      '  "files": [ { "path": "relative/path.ext", "content": "<COMPLETE new file contents>" } ] }',
      'Always provide COMPLETE file contents (not diffs). Keep changes minimal and focused on the instruction.',
    ].join('\n');
    const user = `Repository: ${g.owner}/${g.repo}\nInstruction: ${instruction}\n\nCurrent page (for context only):\nURL: ${location.href}\nTitle: ${document.title}`;

    let plan;
    try { plan = extractJSON(await callLLM([{ role: 'system', content: sys }, { role: 'user', content: user }], { json: true })); }
    catch (e) { return { text: '❌ LLM error: ' + e.message }; }
    if (!plan || !Array.isArray(plan.files) || !plan.files.length) return { text: '❌ Model did not return a valid file plan.' };

    // preview
    const preview = [
      `<span class="c-accent">Branch:</span> ${esc(plan.branch)}`,
      `<span class="c-accent">Title:</span> ${esc(plan.title)}`,
      `<span class="c-accent">Files (${plan.files.length}):</span> ${plan.files.map((f) => esc(f.path)).join(', ')}`,
    ].join('\n');
    print(preview, { html: true });

    if (!yes && !CONFIG.agent.autoApprove) {
      const ok = window.confirm(`Consoleena will push ${plan.files.length} file(s) to a new branch "${plan.branch}" on ${g.owner}/${g.repo} and open a PR.\n\nProceed?`);
      if (!ok) return { text: '⏹ Cancelled. (Re-run with `pr "…" --yes` to skip this prompt.)' };
    }

    try {
      // base branch
      let base = g.base;
      if (!base) { const repo = await gh(`/repos/${g.owner}/${g.repo}`); base = repo.default_branch; }
      const ref = await gh(`/repos/${g.owner}/${g.repo}/git/ref/heads/${base}`);
      const baseSha = ref.object.sha;

      // create branch
      const branch = plan.branch || `consoleena/${Date.now()}`;
      print(`<span class="c-dim">pr ▸ creating branch ${esc(branch)} from ${esc(base)}…</span>`, { html: true });
      try { await gh(`/repos/${g.owner}/${g.repo}/git/refs`, { method: 'POST', body: { ref: `refs/heads/${branch}`, sha: baseSha } }); }
      catch (e) { if (e.status !== 422) throw e; /* already exists -> reuse */ }

      // commit each file
      for (const f of plan.files) {
        let sha;
        try { const cur = await gh(`/repos/${g.owner}/${g.repo}/contents/${encodeURIComponent(f.path)}?ref=${branch}`); sha = cur.sha; }
        catch (e) { /* new file */ }
        print(`<span class="c-dim">pr ▸ committing ${esc(f.path)}…</span>`, { html: true });
        await gh(`/repos/${g.owner}/${g.repo}/contents/${f.path.split('/').map(encodeURIComponent).join('/')}`, {
          method: 'PUT',
          body: { message: plan.commit_message || plan.title || 'Consoleena change', content: b64(f.content), branch, sha },
        });
      }

      // open PR
      print(`<span class="c-dim">pr ▸ opening pull request…</span>`, { html: true });
      const pr = await gh(`/repos/${g.owner}/${g.repo}/pulls`, {
        method: 'POST',
        body: { title: plan.title || 'Consoleena change', head: branch, base, body: (plan.body || '') + '\n\n— opened by Consoleena 🔮' },
      });
      return { text: `✅ <a href="${esc(pr.html_url)}" target="_blank" style="color:${CONFIG.accent}">PR #${pr.number} opened</a> — ${esc(pr.title)}`, html: true, url: pr.html_url };
    } catch (e) {
      return { text: '❌ ' + e.message };
    }
  }

  // ============================================================
  // 14. SHELL COMMAND REGISTRY
  // ============================================================
  function ok(text, html = false) { return { text, html }; }

  const COMMANDS = {
    help: { desc: 'List commands or `help <cmd>`', usage: 'help [command]', run: ({ positional }) => {
      if (positional[0] && COMMANDS[positional[0]]) { const c = COMMANDS[positional[0]]; return ok(`${positional[0]} — ${c.desc}\nusage: ${c.usage}`); }
      const groups = {
        'Filesystem': ['ls', 'cd', 'pwd', 'cat', 'tree', 'find', 'grep', 'head', 'tail', 'wc', 'echo'],
        'Inspect': ['vars', 'funcs', 'logs', 'errors', 'net', 'status', 'env', 'which', 'history'],
        'Automate': ['$', 'click', 'fill', 'type', 'press', 'hover', 'select', 'check', 'uncheck', 'scroll', 'wait', 'assert', 'count', 'text', 'attr', 'highlight', 'snapshot', 'screenshot'],
        'JS': ['get', 'set', 'run', 'eval'],
        'Navigate': ['goto', 'reload', 'back', 'forward'],
        'Record': ['record', 'replay', 'codegen'],
        'AI': ['ai', 'do', 'explain', 'fix'],
        'GitHub': ['gh', 'pr'],
        'Misc': ['clear', 'alias', 'man', 'version', 'date', 'whoami'],
      };
      let out = `🔮 Consoleena v${CONFIG.version} — type a command. Prefix with ? for the AI agent.\n`;
      for (const [g, cmds] of Object.entries(groups)) out += `\n${g}: ${cmds.join('  ')}`;
      out += `\n\nExamples:\n  cat /js/vars | grep version\n  ? log in as test@x.com / pw and verify the dashboard\n  record start  …  codegen playwright\n  pr "add a dark mode toggle"`;
      return ok(out);
    } },

    // ---- filesystem ----
    pwd: { desc: 'Print working directory', usage: 'pwd', run: () => ok(pathStr(state.cwd)) },
    cd: { desc: 'Change directory in the page VFS', usage: 'cd <path>', run: ({ positional }) => {
      const segs = resolvePath(positional[0] || '/'); const n = nodeAt(segs);
      if (!n) return ok(`cd: no such path: ${positional[0]}`);
      if (n.type !== 'dir') return ok(`cd: not a directory: ${positional[0]}`);
      state.cwd = segs; state.env.PWD = pathStr(segs); renderStatus(); return ok('');
    } },
    ls: { desc: 'List VFS contents (page DOM/CSS/JS/storage/…)', usage: 'ls [-l] [path]', run: ({ positional, flags }) => {
      const segs = resolvePath(positional[0]); const n = nodeAt(segs);
      if (!n) return ok(`ls: no such path: ${positional[0] || ''}`);
      if (n.type === 'file') return ok(pathStr(segs));
      const names = Object.keys(n.children);
      if (flags.l) return ok(names.map((nm) => `${n.children[nm].type === 'dir' ? 'd' : '-'}  ${nm}`).join('\n'));
      return ok(names.map((nm) => n.children[nm].type === 'dir' ? nm + '/' : nm).join('  '));
    } },
    cat: { desc: 'Print a VFS file', usage: 'cat <path...>', run: ({ positional }) => {
      if (!positional.length) return ok('cat: missing path');
      const out = positional.map((p) => { const n = nodeAt(resolvePath(p)); if (!n) return `cat: ${p}: no such file`; if (n.type === 'dir') return `cat: ${p}: is a directory`; return n.read(); }).join('\n');
      return ok(out);
    } },
    tree: { desc: 'Print VFS as a tree', usage: 'tree [-L depth] [path]', run: ({ positional, flags }) => {
      const max = parseInt(flags.L) || 3; const start = resolvePath(positional[0]); const root = nodeAt(start);
      if (!root) return ok(`tree: no such path`);
      const lines = [pathStr(start)];
      (function walk(node, prefix, depth) {
        if (node.type !== 'dir' || depth > max) return;
        const keys = Object.keys(node.children);
        keys.forEach((k, i) => { const last = i === keys.length - 1; const c = node.children[k]; lines.push(`${prefix}${last ? '└─ ' : '├─ '}${k}${c.type === 'dir' ? '/' : ''}`); if (c.type === 'dir') walk(c, prefix + (last ? '   ' : '│  '), depth + 1); });
      })(root, '', 1);
      return ok(lines.join('\n'));
    } },
    find: { desc: 'Find files/dirs by name in the VFS', usage: 'find [path] [-name pattern] [-type f|d]', run: ({ positional, flags }) => {
      const start = resolvePath(positional[0]); const root = nodeAt(start);
      if (!root) return ok('find: no such path');
      const name = flags.name ? new RegExp(String(flags.name).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*'), 'i') : null;
      const wantType = flags.type;
      const hits = [];
      (function walk(node, segs) {
        const here = pathStr(segs);
        const base = segs[segs.length - 1] || '/';
        const typ = node.type === 'dir' ? 'd' : 'f';
        if ((!name || name.test(base) || name.test(here)) && (!wantType || wantType === typ)) hits.push(here);
        if (node.type === 'dir') for (const k of Object.keys(node.children)) walk(node.children[k], segs.concat(k));
      })(root, start);
      // also search DOM tags/ids when looking under /dom
      return ok(hits.join('\n') || '(no matches)');
    } },
    grep: { desc: 'Search lines (use with a pipe, or grep PATTERN FILE)', usage: 'grep [-i] [-v] [-n] [-c] PATTERN [path]', run: ({ positional, flags, stdin }) => {
      const pattern = positional[0]; if (!pattern) return ok('grep: missing pattern');
      let text = stdin;
      if (text == null) { const p = positional[1]; if (!p) return ok('grep: missing input (pipe something in or give a file)'); const n = nodeAt(resolvePath(p)); if (!n || n.type !== 'file') return ok(`grep: ${p}: no such file`); text = n.read(); }
      const re = new RegExp(pattern, flags.i ? 'i' : '');
      let lines = String(text).split('\n');
      let matched = lines.map((l, i) => ({ l, i })).filter(({ l }) => flags.v ? !re.test(l) : re.test(l));
      if (flags.c) return ok(String(matched.length));
      return ok(matched.map(({ l, i }) => flags.n ? `${i + 1}:${l}` : l).join('\n') || '(no matches)');
    } },
    head: { desc: 'First N lines', usage: 'head [-n N] [path]', run: ({ positional, flags, stdin }) => { const n = parseInt(flags.n) || 10; const t = stdin != null ? stdin : (nodeAt(resolvePath(positional[0])) || {}).read?.() || ''; return ok(String(t).split('\n').slice(0, n).join('\n')); } },
    tail: { desc: 'Last N lines', usage: 'tail [-n N] [path]', run: ({ positional, flags, stdin }) => { const n = parseInt(flags.n) || 10; const t = stdin != null ? stdin : (nodeAt(resolvePath(positional[0])) || {}).read?.() || ''; return ok(String(t).split('\n').slice(-n).join('\n')); } },
    wc: { desc: 'Count lines/words/chars', usage: 'wc [-l] [path]', run: ({ positional, flags, stdin }) => { const t = String(stdin != null ? stdin : (nodeAt(resolvePath(positional[0])) || {}).read?.() || ''); const lines = t.split('\n').length, words = t.split(/\s+/).filter(Boolean).length, chars = t.length; return ok(flags.l ? String(lines) : `${lines} ${words} ${chars}`); } },
    echo: { desc: 'Print text', usage: 'echo <text>', run: ({ positional, raw }) => ok(raw.replace(/^echo\s+/, '')) },

    // ---- inspect ----
    vars: { desc: 'List page global variables', usage: 'vars', run: () => COMMANDS.cat.run({ positional: ['/js/vars'] }) },
    funcs: { desc: 'List page global functions', usage: 'funcs', run: () => COMMANDS.cat.run({ positional: ['/js/functions'] }) },
    logs: { desc: 'Recent console logs', usage: 'logs', run: () => COMMANDS.cat.run({ positional: ['/console'] }) },
    errors: { desc: 'Recent errors', usage: 'errors', run: () => COMMANDS.cat.run({ positional: ['/errors'] }) },
    net: { desc: 'Recent network requests', usage: 'net', run: () => COMMANDS.cat.run({ positional: ['/network'] }) },
    env: { desc: 'Show shell environment', usage: 'env', run: () => ok(Object.entries(state.env).map(([k, v]) => `${k}=${v}`).join('\n')) },
    which: { desc: 'Is a command available?', usage: 'which <cmd>', run: ({ positional }) => ok(COMMANDS[positional[0]] ? positional[0] : `${positional[0]}: not found`) },
    history: { desc: 'Command history', usage: 'history', run: () => ok(state.history.map((h, i) => `${i + 1}  ${h}`).join('\n')) },
    status: { desc: 'Consoleena status', usage: 'status', run: () => {
      const c = state.context || extractProjectContext();
      return ok(`Consoleena v${CONFIG.version}\nmode: ${state.mode}   cwd: ${pathStr(state.cwd)}\nLLM: ${CONFIG.llm.endpoint} (${CONFIG.llm.model})${CONFIG.llm.apiKey ? ' +key' : ''}\nGitHub: ${CONFIG.github.owner ? CONFIG.github.owner + '/' + CONFIG.github.repo : 'not set'}${CONFIG.github.token ? ' (auth)' : ''}\nvars:${c.variables.length} funcs:${c.functions.length} dom:${c.domElements.length} css:${c.cssRules.length}\nlogs:${state.logs.length} errors:${state.errors.length} net:${state.network.length}\nrecording:${state.recording} (${state.recorded.length} steps)`);
    } },

    // ---- automation ----
    $: { desc: 'Query elements (CSS / text= / role=)', usage: '$ <selector>', run: ({ raw }) => {
      const sel = raw.replace(/^\$\s*/, '').trim(); const els = queryAll(sel);
      if (!els.length) return ok(`no elements match ${sel}`);
      state.lastSelector = sel;
      return ok(`${els.length} match(es) for ${sel}:\n` + els.slice(0, 12).map((e, i) => `${i + 1}. ${uniqueSelector(e)}${visibleText(e) ? '  — ' + clip(visibleText(e), 50) : ''}`).join('\n'));
    } },
    click: { desc: 'Click an element', usage: 'click <selector>', run: async ({ positional }) => { const s = positional.join(' '); await new Locator(s).click(); return ok(`🖱 clicked ${s}`); } },
    fill: { desc: 'Fill an input (React-safe)', usage: 'fill <selector> <value>', run: async ({ positional }) => { const s = positional[0]; const v = positional.slice(1).join(' '); await new Locator(s).fill(v); return ok(`⌨ filled ${s} = "${v}"`); } },
    type: { desc: 'Type into an input keystroke-by-keystroke', usage: 'type <selector> <text>', run: async ({ positional }) => { const s = positional[0]; const v = positional.slice(1).join(' '); await new Locator(s).type(v); return ok(`⌨ typed into ${s}`); } },
    press: { desc: 'Press a key on an element', usage: 'press <selector> <Key>', run: async ({ positional }) => { await new Locator(positional[0]).press(positional[1] || 'Enter'); return ok(`⌨ pressed ${positional[1]} on ${positional[0]}`); } },
    hover: { desc: 'Hover an element', usage: 'hover <selector>', run: async ({ positional }) => { const s = positional.join(' '); await new Locator(s).hover(); return ok(`👆 hovering ${s}`); } },
    select: { desc: 'Select a dropdown option', usage: 'select <selector> <value>', run: async ({ positional }) => { await new Locator(positional[0]).selectOption(positional.slice(1).join(' ')); return ok(`▼ selected on ${positional[0]}`); } },
    check: { desc: 'Check a checkbox', usage: 'check <selector>', run: async ({ positional }) => { const s = positional.join(' '); await new Locator(s).check(); return ok(`☑ checked ${s}`); } },
    uncheck: { desc: 'Uncheck a checkbox', usage: 'uncheck <selector>', run: async ({ positional }) => { const s = positional.join(' '); await new Locator(s).uncheck(); return ok(`☐ unchecked ${s}`); } },
    scroll: { desc: 'Scroll to element or coords', usage: 'scroll <selector|x y>', run: async ({ positional }) => {
      if (positional.length >= 2 && !isNaN(positional[0])) { window.scrollTo(+positional[0], +positional[1]); return ok(`scrolled to ${positional[0]},${positional[1]}`); }
      await new Locator(positional.join(' ')).scrollIntoView(); return ok(`scrolled to ${positional.join(' ')}`);
    } },
    wait: { desc: 'Wait for selector or milliseconds', usage: 'wait <selector|ms> [--timeout ms]', run: async ({ positional, flags }) => {
      const a = positional.join(' ');
      if (/^\d+$/.test(a)) { await sleep(+a); return ok(`waited ${a}ms`); }
      await new Locator(a).waitFor({ timeout: parseInt(flags.timeout) || CONFIG.automation.defaultTimeout }); return ok(`✓ ${a} is present`);
    } },
    assert: { desc: 'Assert visibility/text/count', usage: 'assert <selector> [--visible|--hidden|--text "..."|--count N]', run: async ({ positional, flags }) => {
      const s = positional[0]; const loc = new Locator(s);
      try {
        if (flags.text != null) { await loc.assertText(String(flags.text)); return ok(`✓ ${s} contains "${flags.text}"`); }
        if (flags.count != null) { loc.assertCount(parseInt(flags.count)); return ok(`✓ ${s} count = ${flags.count}`); }
        if (flags.hidden) { await loc.assertHidden(); return ok(`✓ ${s} is hidden`); }
        await loc.assertVisible(); return ok(`✓ ${s} is visible`);
      } catch (e) { return ok(`✗ ${e.message}`); }
    } },
    count: { desc: 'Count matching elements', usage: 'count <selector>', run: ({ positional }) => ok(String(new Locator(positional.join(' ')).count())) },
    text: { desc: 'Get element text', usage: 'text <selector>', run: ({ positional }) => ok(new Locator(positional.join(' ')).text() || '(no text / not found)') },
    attr: { desc: 'Get an attribute', usage: 'attr <selector> <name>', run: ({ positional }) => ok(String(new Locator(positional[0]).getAttribute(positional[1]))) },
    highlight: { desc: 'Highlight an element', usage: 'highlight <selector>', run: ({ positional }) => { const s = positional.join(' '); const el = new Locator(s).el(); if (!el) return ok(`not found: ${s}`); flash(el); el.scrollIntoView({ block: 'center' }); return ok(`🎯 highlighted ${s}`); } },
    snapshot: { desc: 'Compact list of visible interactive elements', usage: 'snapshot', run: () => ok(page.snapshot().map((e) => `${e.tag}  ${e.sel}${e.label ? '  — ' + e.label : ''}`).join('\n')) },
    screenshot: { desc: 'Capture a screenshot (needs html2canvas for PNG)', usage: 'screenshot [selector]', run: async ({ positional }) => { try { const url = await page.screenshot({ selector: positional[0] }); _console.log('📷 Consoleena screenshot:', url); return ok(`📷 captured (logged to devtools console). ${url.startsWith('data:image/png') ? 'PNG' : 'SVG fallback'}`); } catch (e) { return ok('❌ ' + e.message); } } },

    // ---- JS ----
    get: { desc: 'Get a global variable', usage: 'get <name>', run: ({ positional }) => { const n = positional[0]; if (!(n in window)) return ok(`${n}: not defined`); return ok(`${n} = ${fmtArg(window[n])}`); } },
    set: { desc: 'Set a global variable (auto-typed)', usage: 'set <name> <value>', run: ({ positional }) => { const n = positional[0]; const v = coerce(positional.slice(1).join(' ')); const old = window[n]; window[n] = v; return ok(`${n} = ${fmtArg(v)}  (was ${fmtArg(old)})`); } },
    run: { desc: 'Call a global function', usage: 'run <fnName> [args...]', run: ({ positional }) => { const n = positional[0]; if (typeof window[n] !== 'function') return ok(`${n}: not a function`); try { const r = window[n](...positional.slice(1).map(coerce)); return ok(`${n}() → ${fmtArg(r)}`); } catch (e) { return ok(`❌ ${e.message}`); } } },
    eval: { desc: 'Evaluate JavaScript in page scope', usage: 'eval <code>', run: ({ raw }) => { const code = arg(raw, 'eval'); try { const r = (0, eval)(code); return ok(`→ ${fmtArg(r)}`); } catch (e) { return ok(`❌ ${e.message}`); } } },

    // ---- navigate ----
    goto: { desc: 'Navigate to a URL (reloads page)', usage: 'goto <url>', run: ({ positional }) => ok(page.goto(positional[0])) },
    reload: { desc: 'Reload the page', usage: 'reload', run: () => { page.reload(); return ok('reloading…'); } },
    back: { desc: 'History back', usage: 'back', run: () => { page.back(); return ok('←'); } },
    forward: { desc: 'History forward', usage: 'forward', run: () => { page.forward(); return ok('→'); } },

    // ---- record ----
    record: { desc: 'Record interactions: record start|stop|status', usage: 'record start|stop|status', run: ({ positional }) => {
      const sub = positional[0] || 'status';
      if (sub === 'start') { state.recorded = []; state.recording = true; renderStatus(); return ok('● recording started — interact with the page, then `codegen playwright`'); }
      if (sub === 'stop') { state.recording = false; renderStatus(); return ok(`■ stopped (${state.recorded.length} steps). Run \`codegen\`.`); }
      return ok(`recording: ${state.recording} (${state.recorded.length} steps)`);
    } },
    replay: { desc: 'Replay recorded steps live', usage: 'replay', run: async () => {
      if (!state.recorded.length) return ok('nothing recorded');
      for (const s of state.recorded) {
        const loc = new Locator(s.selector);
        try {
          if (s.action === 'click') await loc.click();
          else if (s.action === 'fill') await loc.fill(s.value);
          else if (s.action === 'select') await loc.selectOption(s.value);
          else if (s.action === 'check') await loc.check();
          else if (s.action === 'uncheck') await loc.uncheck();
          else if (s.action === 'press') await loc.press(s.value);
          await sleep(120);
        } catch (e) { return ok(`✗ replay failed at ${s.action} ${s.selector}: ${e.message}`); }
      }
      return ok(`✓ replayed ${state.recorded.length} steps`);
    } },
    codegen: { desc: 'Export recording as code', usage: 'codegen [playwright|consoleena]', run: ({ positional }) => { if (!state.recorded.length) return ok('nothing recorded — run `record start` first'); return ok(codegen(positional[0])); } },

    // ---- AI ----
    ai: { desc: 'Run the AI agent on a task', usage: 'ai <task>', run: async ({ raw }) => { await agent(arg(raw, 'ai')); return ok(''); } },
    do: { desc: 'Alias for the AI agent', usage: 'do <task>', run: async ({ raw }) => { await agent(arg(raw, 'do')); return ok(''); } },
    explain: { desc: 'Explain an element or recent errors', usage: 'explain [selector]', run: async ({ positional }) => aiExplain(positional.join(' ')) },
    fix: { desc: 'Diagnose recent errors (+ --apply to patch live)', usage: 'fix [--apply]', run: async ({ flags }) => aiFix(!!flags.apply) },

    // ---- github ----
    gh: { desc: 'GitHub: gh login <token> | gh repo o/r[#base] | gh whoami', usage: 'gh <login|repo|whoami> …', run: async ({ positional, raw }) => {
      const sub = positional[0];
      if (sub === 'login') { const tok = (raw.match(/login\s+(\S+)/) || [])[1]; if (!tok) return ok('usage: gh login <token>'); CONFIG.github.token = tok; persistConfig(); try { const me = await gh('/user'); return ok(`✓ logged in as ${me.login}`); } catch (e) { return ok('token stored, but verify failed: ' + e.message); } }
      if (sub === 'repo') { const m = (positional[1] || '').match(/^([^/]+)\/([^#]+)(?:#(.+))?$/); if (!m) return ok('usage: gh repo owner/name[#base]'); CONFIG.github.owner = m[1]; CONFIG.github.repo = m[2]; CONFIG.github.base = m[3] || null; persistConfig(); renderStatus(); return ok(`✓ repo set: ${m[1]}/${m[2]}${m[3] ? ' (base ' + m[3] + ')' : ''}`); }
      if (sub === 'whoami') { try { const me = await gh('/user'); return ok(`${me.login} — ${me.name || ''}`); } catch (e) { return ok('❌ ' + e.message); } }
      if (sub === 'logout') { CONFIG.github.token = null; persistConfig(); return ok('logged out'); }
      return ok('gh: login | repo | whoami | logout');
    } },
    pr: { desc: 'Open a GitHub PR from a prompt', usage: 'pr "<instruction>" [--yes]', run: async ({ positional, flags }) => openPR(positional.join(' ').replace(/^["']|["']$/g, ''), { yes: !!flags.yes }) },

    // ---- misc ----
    clear: { desc: 'Clear the terminal', usage: 'clear', run: () => { const m = document.getElementById('consoleena-output'); if (m) m.innerHTML = ''; return ok(''); } },
    alias: { desc: 'Create/list aliases', usage: 'alias [name=command]', run: ({ raw }) => { const body = raw.replace(/^alias\s*/, ''); if (!body) return ok(Object.entries(state.aliases).map(([k, v]) => `${k}='${v}'`).join('\n') || '(none)'); const m = body.match(/^(\w+)=(.+)$/); if (!m) return ok('usage: alias name=command'); state.aliases[m[1]] = m[2].replace(/^["']|["']$/g, ''); return ok(`aliased ${m[1]}`); } },
    man: { desc: 'Manual for a command', usage: 'man <cmd>', run: ({ positional }) => COMMANDS.help.run({ positional }) },
    version: { desc: 'Show version', usage: 'version', run: () => ok(`Consoleena v${CONFIG.version}`) },
    date: { desc: 'Current date/time', usage: 'date', run: () => ok(new Date().toString()) },
    whoami: { desc: 'Current shell user', usage: 'whoami', run: () => ok(state.env.USER) },
  };

  function arg(raw, cmd) {
    // Return everything after the leading command token (regex-free so command
    // names like click/text/do/eval aren't mangled by escape sequences).
    const r = String(raw == null ? '' : raw).replace(/^\s+/, '');
    if (cmd && r.toLowerCase().startsWith(String(cmd).toLowerCase())) return r.slice(cmd.length).replace(/^\s+/, '').trim();
    const sp = r.search(/\s/);
    return sp === -1 ? '' : r.slice(sp + 1).trim();
  }
  function coerce(v) {
    if (v === '') return undefined;
    if (v === 'true') return true; if (v === 'false') return false;
    if (v === 'null') return null; if (v === 'undefined') return undefined;
    if (!isNaN(v)) return Number(v);
    if (/^[{\[]/.test(v)) { try { return JSON.parse(v); } catch (e) { } }
    return v;
  }

  // ============================================================
  // 15. COMMAND-LINE PARSER + PIPELINE EXECUTOR
  // ============================================================
  function lex(input) {
    const tokens = []; let cur = '', i = 0, s = false, d = false, b = false;
    while (i < input.length) {
      const c = input[i];
      if (s) { if (c === "'") s = false; else cur += c; i++; continue; }
      if (d) { if (c === '"') d = false; else cur += c; i++; continue; }
      if (b) { if (c === '`') b = false; else cur += c; i++; continue; }
      if (c === "'") { s = true; i++; continue; }
      if (c === '"') { d = true; i++; continue; }
      if (c === '`') { b = true; i++; continue; }
      if (c === '|') { if (cur) { tokens.push(cur); cur = ''; } tokens.push('|'); i++; continue; }
      if (/\s/.test(c)) { if (cur) { tokens.push(cur); cur = ''; } i++; continue; }
      cur += c; i++;
    }
    if (cur) tokens.push(cur);
    return tokens;
  }
  function parseArgs(tokens) {
    const positional = [], flags = {};
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.startsWith('--')) { const eq = t.indexOf('='); if (eq > -1) flags[t.slice(2, eq)] = t.slice(eq + 1); else { const next = tokens[i + 1]; if (next && !next.startsWith('-')) { flags[t.slice(2)] = next; i++; } else flags[t.slice(2)] = true; } }
      else if (t.startsWith('-') && t.length > 1 && isNaN(t)) { t.slice(1).split('').forEach((f) => flags[f] = true); }
      else positional.push(t);
    }
    return { positional, flags };
  }

  async function runLine(line, { echo = true, fromAgent = false } = {}) {
    line = (line || '').trim();
    if (!line) return ok('');
    if (echo) { consolePrint(`<span class="c-prompt">${state.mode === 'ai' ? '🤖' : '❯'}</span> ${esc(line)}`, { html: true, cls: 'c-input' }); state.history.push(line); }

    // alias expansion (one level, head only)
    const head0 = line.split(/\s+/)[0];
    if (state.aliases[head0]) line = line.replace(head0, state.aliases[head0]);

    const tokens = lex(line);
    if (!tokens.length) return ok('');

    // split into pipeline
    const stages = []; let buf = [];
    for (const t of tokens) { if (t === '|') { stages.push(buf); buf = []; } else buf.push(t); }
    stages.push(buf);

    let stdin = null, result = ok('');
    for (const stage of stages) {
      if (!stage.length) continue;
      const name = stage[0];
      const cmd = COMMANDS[name];
      if (!cmd) { result = ok(`${name}: command not found. Try \`help\`.`); break; }
      const { positional, flags } = parseArgs(stage.slice(1));
      const raw = stage.slice(1).join(' ') ? line.slice(line.indexOf(name)) : name; // best-effort raw for this stage
      try {
        const r = await cmd.run({ positional, flags, stdin, raw: stageRaw(line, stages, stage, name), argv: stage });
        result = r || ok('');
      } catch (e) { result = ok(`❌ ${e.message}`); break; }
      stdin = stripHtml(result.html ? result.text : result.text);
    }
    if (echo && result && result.text !== '') consolePrint(result.text, { html: !!result.html });
    return result;
  }
  // raw text for a stage (so commands like eval/echo/$/click can grab the remainder verbatim)
  function stageRaw(line, stages, stage, name) {
    // For single-stage lines this is the whole line; for piped lines, reconstruct the stage.
    if (stages.length === 1) return line;
    return stage.join(' ');
  }

  // ============================================================
  // 16. TERMINAL UI
  // ============================================================
  const CSS_TEXT = `
  #consoleena-toggle{position:fixed;right:20px;bottom:20px;z-index:2147483646;width:52px;height:52px;border-radius:14px;border:1px solid rgba(108,99,255,.5);background:#15131f;color:#fff;font-size:22px;cursor:pointer;box-shadow:0 8px 30px rgba(0,0,0,.45);transition:transform .15s ease, box-shadow .15s ease}
  #consoleena-toggle:hover{transform:translateY(-2px);box-shadow:0 12px 36px rgba(108,99,255,.35)}
  #consoleena-toggle:focus-visible{outline:2px solid ${CONFIG.accent};outline-offset:2px}
  #consoleena-panel{position:fixed;right:20px;bottom:84px;z-index:2147483647;width:min(560px,calc(100vw - 40px));height:min(620px,calc(100vh - 120px));display:none;flex-direction:column;background:#0e0d15;color:#e6e4f0;border:1px solid #262338;border-radius:16px;overflow:hidden;box-shadow:0 24px 70px rgba(0,0,0,.6);font-family:ui-monospace,"SF Mono",Menlo,Consolas,"Cascadia Code",monospace;font-size:13px;line-height:1.55}
  #consoleena-panel.open{display:flex}
  #consoleena-panel *{box-sizing:border-box}
  #consoleena-head{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#15131f;border-bottom:1px solid #262338}
  #consoleena-head .title{display:flex;align-items:center;gap:8px;font-weight:600;letter-spacing:.2px}
  #consoleena-head .badge{font-size:10px;padding:2px 7px;border-radius:999px;background:rgba(108,99,255,.16);color:#b8b2ff;border:1px solid rgba(108,99,255,.35)}
  #consoleena-head .ctrls{display:flex;gap:6px}
  #consoleena-head button{background:transparent;border:1px solid #2c2940;color:#a8a4bd;border-radius:8px;padding:4px 9px;font:inherit;font-size:11px;cursor:pointer}
  #consoleena-head button:hover{border-color:${CONFIG.accent};color:#fff}
  #consoleena-tabs{display:flex;gap:2px;padding:6px 10px 0;background:#15131f}
  #consoleena-tabs button{flex:1;background:transparent;border:none;border-bottom:2px solid transparent;color:#8b86a3;font:inherit;font-size:11.5px;padding:7px 6px;cursor:pointer;border-radius:6px 6px 0 0}
  #consoleena-tabs button.active{color:#fff;border-bottom-color:${CONFIG.accent};background:#0e0d15}
  .c-view{flex:1;overflow:auto;padding:12px 14px;display:none;white-space:pre-wrap;word-break:break-word}
  .c-view.active{display:block}
  #consoleena-output .c-line{margin:1px 0}
  .c-input{color:#cfcbe6}.c-prompt{color:${CONFIG.accent};font-weight:700}
  .c-ok{color:#5dd6a0}.c-err{color:#ff6b7d}.c-warn{color:#ffce6b}.c-dim{color:#7d7895}.c-accent{color:#b8b2ff}
  .c-view code{background:#1a1826;border:1px solid #2c2940;border-radius:5px;padding:1px 5px;color:#d7d3f0}
  #consoleena-cmd{display:flex;align-items:center;gap:8px;padding:10px 12px;border-top:1px solid #262338;background:#15131f}
  #consoleena-mode{background:#1a1826;border:1px solid #2c2940;color:#b8b2ff;border-radius:7px;padding:4px 9px;font:inherit;font-size:11px;cursor:pointer;min-width:40px}
  #consoleena-input{flex:1;background:transparent;border:none;color:#fff;font:inherit;outline:none}
  #consoleena-input::placeholder{color:#56526b}
  #consoleena-send{background:${CONFIG.accent};border:none;color:#fff;border-radius:8px;padding:6px 12px;font:inherit;font-weight:600;cursor:pointer}
  #consoleena-send:hover{filter:brightness(1.08)}
  #consoleena-status{display:flex;gap:14px;padding:5px 14px;background:#0b0a11;border-top:1px solid #1d1b29;color:#6f6a86;font-size:10.5px}
  #consoleena-status b{color:#a8a4bd;font-weight:600}
  #consoleena-settings{padding:12px 14px;display:none;gap:8px;flex-direction:column;border-top:1px solid #262338;background:#13111d}
  #consoleena-settings.open{display:flex}
  #consoleena-settings label{display:flex;flex-direction:column;gap:3px;font-size:11px;color:#9a95b3}
  #consoleena-settings input{background:#0e0d15;border:1px solid #2c2940;border-radius:7px;padding:6px 9px;color:#fff;font:inherit;font-size:12px}
  #consoleena-settings .row{display:flex;gap:8px}#consoleena-settings .row label{flex:1}
  #consoleena-settings .chk{flex-direction:row;align-items:center;gap:7px}
  #consoleena-settings .warn{color:#ffce6b;font-size:10.5px}
  .c-rec-step{padding:3px 0;border-bottom:1px solid #1c1a28;color:#cfcbe6}
  .c-rec-bar{display:flex;gap:6px;margin-bottom:10px}
  .c-rec-bar button{background:#1a1826;border:1px solid #2c2940;color:#cfcbe6;border-radius:7px;padding:5px 11px;font:inherit;font-size:11px;cursor:pointer}
  .c-rec-bar button:hover{border-color:${CONFIG.accent}}
  @media (prefers-reduced-motion: reduce){#consoleena-toggle{transition:none}}
  `;

  function consolePrint(html, { html: isHtml = true, cls = '' } = {}) {
    const out = document.getElementById('consoleena-output');
    if (!out) { _console.log('[consoleena]', stripHtml(html)); return; }
    const div = document.createElement('div');
    div.className = 'c-line ' + cls;
    if (isHtml) div.innerHTML = html; else div.textContent = html;
    out.appendChild(div);
    out.scrollTop = out.scrollHeight;
  }

  let ui = false;
  function createUI() {
    if (ui || !document.body) return; ui = true;
    const style = document.createElement('style'); style.id = 'consoleena-style'; style.textContent = CSS_TEXT; document.head.appendChild(style);

    const toggle = document.createElement('button');
    toggle.id = 'consoleena-toggle'; toggle.textContent = '🔮'; toggle.setAttribute('aria-label', 'Toggle Consoleena (Ctrl+Shift+K)');
    document.body.appendChild(toggle);

    const panel = document.createElement('div');
    panel.id = 'consoleena-panel';
    panel.innerHTML = `
      <div id="consoleena-head">
        <div class="title">🧠 Consoleena <span class="badge">v${CONFIG.version}</span></div>
        <div class="ctrls">
          <button data-act="settings">⚙ settings</button>
          <button data-act="clear">clear</button>
          <button data-act="close">✕</button>
        </div>
      </div>
      <div id="consoleena-tabs">
        <button data-tab="terminal" class="active">Terminal</button>
        <button data-tab="network">Network</button>
        <button data-tab="logs">Logs</button>
        <button data-tab="recorder">Recorder</button>
      </div>
      <div id="consoleena-settings">
        <label>LLM endpoint<input id="cset-endpoint" value="${esc(CONFIG.llm.endpoint)}"/></label>
        <div class="row">
          <label>Model<input id="cset-model" value="${esc(CONFIG.llm.model)}"/></label>
          <label>API key (optional)<input id="cset-key" type="password" placeholder="leave blank for keyless" value="${CONFIG.llm.apiKey ? '••••••••' : ''}"/></label>
        </div>
        <label>GitHub token (PAT, repo scope)<input id="cset-ghtoken" type="password" placeholder="${CONFIG.github.token ? '•••••••• (set)' : 'ghp_…'}"/></label>
        <label>GitHub repo<input id="cset-ghrepo" placeholder="owner/name#base" value="${CONFIG.github.owner ? esc(CONFIG.github.owner + '/' + CONFIG.github.repo + (CONFIG.github.base ? '#' + CONFIG.github.base : '')) : ''}"/></label>
        <label class="chk"><input id="cset-persist" type="checkbox" ${CONFIG.github.persistToken ? 'checked' : ''}/> Save token to localStorage</label>
        <label class="chk"><input id="cset-auto" type="checkbox" ${CONFIG.agent.autoApprove ? 'checked' : ''}/> Let agent run gh/pr automatically</label>
        <span class="warn">⚠ Tokens in the browser are visible to page scripts. Use a short-lived, minimally-scoped PAT and dev/staging only.</span>
        <div class="row"><button data-act="save-settings" id="consoleena-send" style="flex:1">Save</button></div>
      </div>
      <div id="consoleena-output" class="c-view active" data-view="terminal"></div>
      <div id="consoleena-net" class="c-view" data-view="network"></div>
      <div id="consoleena-logs" class="c-view" data-view="logs"></div>
      <div id="consoleena-rec" class="c-view" data-view="recorder"></div>
      <div id="consoleena-cmd">
        <button id="consoleena-mode" title="Toggle shell / AI mode">sh</button>
        <input id="consoleena-input" placeholder="ls /   ·   ? log in and verify dashboard" autocomplete="off" spellcheck="false"/>
        <button id="consoleena-send">Run</button>
      </div>
      <div id="consoleena-status"></div>`;
    document.body.appendChild(panel);

    const input = panel.querySelector('#consoleena-input');
    let histIdx = -1;

    function openPanel(open) { panel.classList.toggle('open', open); if (open) { input.focus(); if (!state.context) { extractProjectContext(); banner(); } } }
    toggle.addEventListener('click', () => openPanel(!panel.classList.contains('open')));

    panel.querySelector('[data-act="close"]').addEventListener('click', () => openPanel(false));
    panel.querySelector('[data-act="clear"]').addEventListener('click', () => { panel.querySelector('#consoleena-output').innerHTML = ''; });
    panel.querySelector('[data-act="settings"]').addEventListener('click', () => panel.querySelector('#consoleena-settings').classList.toggle('open'));
    panel.querySelector('[data-act="save-settings"]').addEventListener('click', saveSettings);

    panel.querySelectorAll('#consoleena-tabs button').forEach((b) => b.addEventListener('click', () => {
      panel.querySelectorAll('#consoleena-tabs button').forEach((x) => x.classList.remove('active'));
      panel.querySelectorAll('.c-view').forEach((v) => v.classList.remove('active'));
      b.classList.add('active');
      panel.querySelector(`.c-view[data-view="${b.dataset.tab}"]`).classList.add('active');
      if (b.dataset.tab === 'network') renderNetwork();
      if (b.dataset.tab === 'logs') renderLogs();
      if (b.dataset.tab === 'recorder') renderRecorder();
    }));

    const modeBtn = panel.querySelector('#consoleena-mode');
    modeBtn.addEventListener('click', () => { state.mode = state.mode === 'sh' ? 'ai' : 'sh'; modeBtn.textContent = state.mode; renderStatus(); input.focus(); });

    function submit() {
      let v = input.value.trim(); if (!v) return; input.value = ''; histIdx = -1;
      handleSubmit(v);
    }
    panel.querySelector('#consoleena-send').addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
      else if (e.key === 'ArrowUp') { if (state.history.length) { histIdx = histIdx < 0 ? state.history.length - 1 : Math.max(0, histIdx - 1); input.value = state.history[histIdx]; e.preventDefault(); } }
      else if (e.key === 'ArrowDown') { if (histIdx >= 0) { histIdx++; if (histIdx >= state.history.length) { histIdx = -1; input.value = ''; } else input.value = state.history[histIdx]; e.preventDefault(); } }
      else if (e.key === 'Tab') { e.preventDefault(); const m = Object.keys(COMMANDS).filter((c) => c.startsWith(input.value.trim())); if (m.length === 1) input.value = m[0] + ' '; else if (m.length) consolePrint('<span class="c-dim">' + m.join('  ') + '</span>', { html: true }); }
    });

    document.addEventListener('keydown', (e) => { if (e.ctrlKey && e.shiftKey && (e.key === 'K' || e.key === 'k')) { e.preventDefault(); openPanel(!panel.classList.contains('open')); } });

    function saveSettings() {
      CONFIG.llm.endpoint = panel.querySelector('#cset-endpoint').value.trim();
      CONFIG.llm.model = panel.querySelector('#cset-model').value.trim();
      const key = panel.querySelector('#cset-key').value; if (key && key !== '••••••••') CONFIG.llm.apiKey = key;
      const ght = panel.querySelector('#cset-ghtoken').value; if (ght) CONFIG.github.token = ght;
      const repo = panel.querySelector('#cset-ghrepo').value.trim(); const rm = repo.match(/^([^/]+)\/([^#]+)(?:#(.+))?$/); if (rm) { CONFIG.github.owner = rm[1]; CONFIG.github.repo = rm[2]; CONFIG.github.base = rm[3] || null; }
      CONFIG.github.persistToken = panel.querySelector('#cset-persist').checked;
      CONFIG.agent.autoApprove = panel.querySelector('#cset-auto').checked;
      persistConfig(); renderStatus();
      panel.querySelector('#consoleena-settings').classList.remove('open');
      consolePrint('<span class="c-ok">✓ settings saved</span>', { html: true });
    }

    renderStatus();
    banner();
  }

  function banner() {
    consolePrint(`<span class="c-accent">🔮 Consoleena v${CONFIG.version}</span> <span class="c-dim">— Unix-like console + Playwright-style automation + AI agent.</span>`, { html: true });
    consolePrint(`<span class="c-dim">Try:</span> <code>ls /</code> · <code>cat /js/vars</code> · <code>? what does this page do</code> · <code>help</code>`, { html: true });
  }

  async function handleSubmit(v) {
    if (state.busy) { consolePrint('<span class="c-warn">busy…</span>', { html: true }); return; }
    state.busy = true;
    try {
      const isAgent = state.mode === 'ai' || v.startsWith('?');
      const forceShell = v.startsWith('!');
      if (forceShell) v = v.slice(1).trim();
      if (isAgent && !forceShell) {
        const task = v.replace(/^\?\s*/, '');
        consolePrint(`<span class="c-prompt">🤖</span> ${esc(task)}`, { html: true, cls: 'c-input' });
        state.history.push(v);
        await agent(task);
      } else {
        await runLine(v);
      }
    } catch (e) { consolePrint(`<span class="c-err">❌ ${esc(e.message)}</span>`, { html: true }); }
    finally { state.busy = false; renderStatus(); }
  }

  // tab renderers
  function renderStatus() {
    const s = document.getElementById('consoleena-status'); if (!s) return;
    s.innerHTML = `<span><b>cwd</b> ${esc(pathStr(state.cwd))}</span><span><b>mode</b> ${state.mode}</span><span><b>llm</b> ${esc(CONFIG.llm.model)}</span><span><b>gh</b> ${CONFIG.github.owner ? esc(CONFIG.github.owner + '/' + CONFIG.github.repo) : '—'}</span>${state.recording ? '<span style="color:#ff6b7d"><b>● REC</b> ' + state.recorded.length + '</span>' : ''}`;
  }
  function renderNetwork() {
    const el = document.getElementById('consoleena-net'); if (!el) return;
    el.innerHTML = state.network.slice(-100).reverse().map((n) => `<div class="c-line"><span class="${n.ok ? 'c-ok' : 'c-err'}">${n.status || 'ERR'}</span> <span class="c-dim">${n.method} ${n.ms}ms</span> ${esc(clip(n.url, 80))}</div>`).join('') || '<span class="c-dim">No requests captured yet.</span>';
  }
  function renderLogs() {
    const el = document.getElementById('consoleena-logs'); if (!el) return;
    const lvl = { error: 'c-err', warn: 'c-warn', info: 'c-accent', debug: 'c-dim', log: '' };
    const logs = state.logs.slice(-200).map((l) => `<div class="c-line ${lvl[l.level] || ''}">${esc(clip(l.text, 300))}</div>`);
    const errs = state.errors.slice(-50).map((e) => `<div class="c-line c-err">⛔ ${esc(e.message)}</div>`);
    el.innerHTML = (errs.join('') + logs.join('')) || '<span class="c-dim">No logs yet.</span>';
  }
  function renderRecorder() {
    const el = document.getElementById('consoleena-rec'); if (!el) return;
    const bar = `<div class="c-rec-bar">
      <button data-rec="${state.recording ? 'stop' : 'start'}">${state.recording ? '■ Stop' : '● Record'}</button>
      <button data-rec="replay">▶ Replay</button>
      <button data-rec="pw">⤓ Playwright</button>
      <button data-rec="cona">⤓ Consoleena</button>
      <button data-rec="clearrec">Clear</button></div>`;
    const steps = state.recorded.map((s, i) => `<div class="c-rec-step">${i + 1}. <span class="c-accent">${s.action}</span> ${esc(s.selector || '')}${s.value != null ? ' <span class="c-dim">= ' + esc(clip(s.value, 40)) + '</span>' : ''}</div>`).join('') || '<span class="c-dim">No steps. Click ● Record and interact with the page.</span>';
    el.innerHTML = bar + steps;
    el.querySelectorAll('[data-rec]').forEach((b) => b.onclick = async () => {
      const a = b.dataset.rec;
      if (a === 'start') { await runLine('record start', { echo: false }); }
      else if (a === 'stop') { await runLine('record stop', { echo: false }); }
      else if (a === 'replay') { panel_switch('terminal'); await runLine('replay'); }
      else if (a === 'pw') { panel_switch('terminal'); await runLine('codegen playwright'); }
      else if (a === 'cona') { panel_switch('terminal'); await runLine('codegen consoleena'); }
      else if (a === 'clearrec') { state.recorded = []; }
      renderRecorder(); renderStatus();
    });
  }
  function panel_switch(tab) { const b = document.querySelector(`#consoleena-tabs button[data-tab="${tab}"]`); if (b) b.click(); }
  function renderTabIfVisible(which) {
    const map = { network: 'consoleena-net', logs: 'consoleena-logs', recorder: 'consoleena-rec' };
    const el = document.getElementById(map[which]); if (el && el.classList.contains('active')) { if (which === 'network') renderNetwork(); else if (which === 'logs') renderLogs(); else renderRecorder(); }
  }

  // ============================================================
  // 17. PUBLIC API
  // ============================================================
  const Consoleena = {
    version: CONFIG.version,
    config: CONFIG,

    // shell
    sh: (line) => runLine(line),
    exec: (line) => runLine(line, { echo: false }).then((r) => stripHtml(r.text)),

    // automation
    $: (sel) => new Locator(sel),
    locator: (sel) => new Locator(sel),
    page,

    // AI
    ai: (task) => agent(task),
    ask: async (q) => { // back-compat: smart-route to shell or agent
      const lower = String(q || '').toLowerCase();
      if (/^\s*(ls|cat|grep|find|tree|get|set|run|click|fill|type|wait|assert|snapshot|pr|gh|record|codegen)\b/.test(lower)) return runLine(q);
      return agent(q);
    },
    explain: (sel) => aiExplain(sel).then((r) => { _console.log(r.text); return r.text; }),
    fix: (apply) => aiFix(!!apply).then((r) => { _console.log(r.text); return r.text; }),

    // github
    pr: (instruction, opts) => openPR(instruction, opts || {}),
    gh: { login: (t) => runLine('gh login ' + t, { echo: false }), repo: (r) => runLine('gh repo ' + r, { echo: false }), whoami: () => runLine('gh whoami') },

    // recorder
    record: { start: () => runLine('record start'), stop: () => runLine('record stop'), replay: () => runLine('replay'), codegen: (f) => codegen(f) },

    // context + back-compat
    capture: () => { const c = extractProjectContext(); _console.log('📊 context', c); return c; },
    getContext: () => state.context || extractProjectContext(),
    get: (n) => { const v = window[n]; _console.log(`${n} =`, v); return v; },
    set: (n, v) => { const o = window[n]; window[n] = v; _console.log(`${n} =`, v, '(was', o, ')'); return v; },
    run: (n, ...a) => { if (typeof window[n] !== 'function') { _console.log(`${n} is not a function`); return null; } try { const r = window[n](...a); _console.log(`${n}() →`, r); return r; } catch (e) { _console.log('❌', e.message); return null; } },
    highlight: (sel) => { const el = new Locator(sel).el(); if (!el) { _console.log('not found:', sel); return null; } flash(el); el.scrollIntoView({ block: 'center' }); return el; },
    clear: () => runLine('clear'),
    status: () => runLine('status'),
    open: () => { const p = document.getElementById('consoleena-panel'); if (p) { p.classList.add('open'); document.getElementById('consoleena-input').focus(); } },

    help: () => {
      _console.log(`🔮 Consoleena v${CONFIG.version}
Shell:        cona.sh('ls /'),  cona.sh('cat /js/vars | grep version')
Automation:   await cona.$('#email').fill('x'),  await cona.$('text=Save').click()
Page:         await cona.page.waitForSelector('.done'),  cona.page.snapshot()
AI agent:     await cona.ai('log in and verify the dashboard')
Debug:        cona.fix(),  cona.explain('.card')
Record:       cona.sh('record start')  …  cona.sh('codegen playwright')
GitHub PR:    cona.sh('gh login <tok>');  cona.sh('gh repo o/r');  cona.pr('add dark mode')
Panel:        Ctrl+Shift+K  ·  type ? for the agent`);
    },
  };
  Consoleena.query = Consoleena.ask; // legacy alias

  // ============================================================
  // 18. INIT
  // ============================================================
  installInspector();
  attachRecorder();
  window.Consoleena = Consoleena;
  window.cona = Consoleena;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', createUI);
  else createUI();

  setTimeout(() => {
    extractProjectContext();
    _console.log(`🧠 Consoleena v${CONFIG.version} loaded — Unix shell + Playwright automation + AI agent.`);
    _console.log('💡 cona.help()  ·  cona.sh("ls /")  ·  cona.ai("...")  ·  Ctrl+Shift+K');
    _console.log('📚 https://github.com/suryasticsai/Consoleena');
  }, 120);

})();
