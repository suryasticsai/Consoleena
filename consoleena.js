/**
 * Consoleena – Developer RAG Assistant
 * Version: 1.0.0
 * Author: Surya Sai Varakala
 * License: MIT
 * Repository: https://github.com/suryasticsai/Consoleena
 * 
 * A console-powered RAG assistant that can query and manipulate
 * your project's DOM, CSS, variables, and more using natural language.
 * 
 * Usage:
 *   <script src="consoleena.js"></script>
 *   Consoleena.ask("What's the first variable?")
 *   Consoleena.get('projectName')
 *   Consoleena.set('version', '2.0.0')
 *   Consoleena.run('greetUser')
 *   Consoleena.highlight('button')
 */

(function() {
  'use strict';

  // ============================================================
  // 1. CONFIGURATION
  // ============================================================
  const CONFIG = {
    chunkSize: 200,
    topK: 5,
    llmEndpoint: 'https://text.pollinations.ai/',
    version: '1.0.0'
  };

  // ============================================================
  // 2. STATE
  // ============================================================
  let projectContext = null;
  let messages = [];
  let isProcessing = false;

  // ============================================================
  // 3. CONTEXT EXTRACTION (STRUCTURED)
  // ============================================================

  function extractProjectContext() {
    const context = {
      variables: extractVariables(),
      functions: extractFunctions(),
      classes: extractClasses(),
      domElements: extractDOM(),
      cssRules: extractCSS(),
      consoleMethods: Object.keys(console).filter(k => typeof console[k] === 'function'),
      metadata: {
        title: document.title,
        url: window.location.href,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        userAgent: navigator.userAgent
      }
    };
    return context;
  }

  function extractVariables() {
    const vars = [];
    const skip = ['window', 'self', 'globalThis', 'document', 'console', 'alert', 'confirm', 'prompt', 'Consoleena'];
    
    for (const key in window) {
      try {
        const val = window[key];
        if (skip.includes(key)) continue;
        if (typeof val === 'function') continue;
        
        let displayValue = val;
        if (typeof val === 'object' && val !== null) {
          try {
            displayValue = JSON.stringify(val).slice(0, 200);
            if (JSON.stringify(val).length > 200) displayValue += '...';
          } catch (e) {
            displayValue = '[complex object]';
          }
        } else if (typeof val === 'string') {
          displayValue = val;
        } else if (typeof val === 'number' || typeof val === 'boolean') {
          displayValue = val;
        } else if (val === null) {
          displayValue = null;
        } else {
          displayValue = String(val);
        }
        
        vars.push({
          name: key,
          value: displayValue,
          type: typeof val,
          scope: 'global',
          isObject: typeof val === 'object' && val !== null,
          isArray: Array.isArray(val)
        });
      } catch (e) { /* ignore */ }
    }
    return vars;
  }

  function extractFunctions() {
    const funcs = [];
    for (const key in window) {
      try {
        if (typeof window[key] === 'function') {
          const fn = window[key];
          const match = fn.toString().match(/\(([^)]*)\)/);
          const params = match ? match[1].split(',').map(p => p.trim()).filter(p => p) : [];
          funcs.push({
            name: key,
            params: params,
            isAsync: fn.constructor.name === 'AsyncFunction',
            isArrow: fn.toString().includes('=>') && !fn.toString().includes('function')
          });
        }
      } catch (e) { /* ignore */ }
    }
    return funcs.slice(0, 50);
  }

  function extractClasses() {
    const classes = [];
    for (const key in window) {
      try {
        const val = window[key];
        if (typeof val === 'function' && val.prototype && val.prototype.constructor) {
          const name = val.name || key;
          if (name && name.length > 0 && name[0] === name[0].toUpperCase()) {
            const methods = Object.getOwnPropertyNames(val.prototype)
              .filter(m => m !== 'constructor' && typeof val.prototype[m] === 'function');
            classes.push({
              name: name,
              methods: methods
            });
          }
        }
      } catch (e) { /* ignore */ }
    }
    return classes.slice(0, 30);
  }

  function extractDOM() {
    const elements = [];
    const all = document.querySelectorAll('*');
    for (const el of all) {
      const info = {
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        classes: el.className ? String(el.className).split(' ').filter(c => c) : [],
        attributes: {}
      };
      for (const attr of el.attributes || []) {
        if (attr.name !== 'class' && attr.name !== 'id') {
          info.attributes[attr.name] = attr.value;
        }
      }
      if (el.textContent && el.textContent.trim().length > 0) {
        info.textPreview = el.textContent.trim().slice(0, 100);
      }
      if (el.children) {
        info.childCount = el.children.length;
      }
      elements.push(info);
    }
    return elements.slice(0, 200);
  }

  function extractCSS() {
    const rules = [];
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules || []) {
          if (rule.type === 1) {
            const properties = [];
            for (let i = 0; i < rule.style.length; i++) {
              const prop = rule.style[i];
              properties.push({ name: prop, value: rule.style.getPropertyValue(prop) });
            }
            rules.push({
              selector: rule.selectorText,
              properties: properties,
              count: properties.length
            });
          }
        }
      } catch (e) { /* Cross-origin stylesheet */ }
    }
    return rules.slice(0, 100);
  }

  // ============================================================
  // 4. QUERY PARSER WITH INTENT DETECTION
  // ============================================================

  function parseQuery(question) {
    const lower = question.toLowerCase();
    
    let intent = 'UNKNOWN';
    let target = 'UNKNOWN';
    let filter = 'ALL';
    let action = 'GET';
    let varName = null;
    
    // Target detection
    if (lower.includes('variable') || lower.includes('var') || lower.includes('constant')) {
      target = 'VARIABLES';
    } else if (lower.includes('function') || lower.includes('func') || lower.includes('method')) {
      target = 'FUNCTIONS';
    } else if (lower.includes('class') || lower.includes('object')) {
      target = 'CLASSES';
    } else if (lower.includes('dom') || lower.includes('element') || lower.includes('tag') || lower.includes('div')) {
      target = 'DOM';
    } else if (lower.includes('css') || lower.includes('style') || lower.includes('selector')) {
      target = 'CSS';
    } else if (lower.includes('help')) {
      target = 'HELP';
    } else {
      target = 'ALL';
    }
    
    // Filter detection
    if (lower.includes('first')) filter = 'FIRST';
    else if (lower.includes('last')) filter = 'LAST';
    else if (lower.includes('all')) filter = 'ALL';
    else if (lower.includes('nth') || lower.match(/\d+/)) {
      filter = 'NTH';
    }
    
    // Action detection
    if (lower.includes('set') || lower.includes('change') || lower.includes('override') || lower.includes('assign')) {
      action = 'SET';
    } else if (lower.includes('run') || lower.includes('execute') || lower.includes('call') || lower.includes('invoke')) {
      action = 'EXECUTE';
    } else if (lower.includes('highlight') || lower.includes('select') || lower.includes('find')) {
      action = 'HIGHLIGHT';
    } else {
      action = 'GET';
    }
    
    // Extract variable/function name from quotes or backticks
    const quotedMatch = question.match(/['"`]([^'"`]+)['"`]/);
    if (quotedMatch) {
      varName = quotedMatch[1];
    }
    
    // If no quoted name, try to find it with "of" or "called"
    if (!varName) {
      const ofMatch = question.match(/(?:of|called|named)\s+(\w+)/i);
      if (ofMatch) {
        varName = ofMatch[1];
      }
    }
    
    return { 
      intent, 
      target, 
      filter, 
      action, 
      varName, 
      raw: question,
      lower: lower
    };
  }

  // ============================================================
  // 5. SMART RETRIEVAL WITH FILTERS
  // ============================================================

  function retrieveWithFilters(parsed) {
    if (!projectContext) {
      projectContext = extractProjectContext();
    }
    
    let results = [];
    
    if (parsed.target === 'HELP') {
      return { type: 'help', message: getHelpMessage() };
    }
    
    switch (parsed.target) {
      case 'VARIABLES':
        results = projectContext.variables;
        break;
      case 'FUNCTIONS':
        results = projectContext.functions;
        break;
      case 'CLASSES':
        results = projectContext.classes;
        break;
      case 'DOM':
        results = projectContext.domElements;
        break;
      case 'CSS':
        results = projectContext.cssRules;
        break;
      case 'ALL':
        results = [
          ...projectContext.variables,
          ...projectContext.functions,
          ...projectContext.classes,
          ...projectContext.domElements.slice(0, 5),
          ...projectContext.cssRules.slice(0, 5)
        ];
        break;
      default:
        results = [];
    }
    
    // Apply filter by name if specified
    if (parsed.varName) {
      const nameLower = parsed.varName.toLowerCase();
      results = results.filter(r => 
        r.name && r.name.toLowerCase().includes(nameLower)
      );
    }
    
    // Apply position filters
    if (results.length > 0) {
      switch (parsed.filter) {
        case 'FIRST':
          results = [results[0]];
          break;
        case 'LAST':
          results = [results[results.length - 1]];
          break;
        case 'NTH':
          const num = parseInt(parsed.raw.match(/\d+/)?.[0] || '1') - 1;
          if (num >= 0 && num < results.length) {
            results = [results[num]];
          } else {
            results = [];
          }
          break;
        default:
          // ALL - keep all
          break;
      }
    }
    
    return { type: 'results', data: results, count: results.length, target: parsed.target };
  }

  // ============================================================
  // 6. ACTION EXECUTOR
  // ============================================================

  function executeAction(parsed, retrieved) {
    if (retrieved.type === 'help') {
      return retrieved;
    }
    
    const data = retrieved.data || [];
    
    switch (parsed.action) {
      case 'GET':
        return formatResults(data, parsed);
        
      case 'SET':
        return executeSet(data, parsed);
        
      case 'EXECUTE':
        return executeFunction(data, parsed);
        
      case 'HIGHLIGHT':
        return executeHighlight(data, parsed);
        
      default:
        return { success: false, message: '❌ Unknown action' };
    }
  }

  function executeSet(data, parsed) {
    if (data.length === 0) {
      return { success: false, message: '❌ No variable found to override.' };
    }
    
    const varToSet = data[0];
    const varName = varToSet.name;
    
    // Extract new value from question
    const newValueMatch = parsed.raw.match(/(?:to|as|=)\s+['"`]?([^'"`]+)['"`]?$/i);
    let newValue = newValueMatch ? newValueMatch[1].trim() : 'undefined';
    
    // Parse the value intelligently
    let parsedValue = newValue;
    if (newValue === 'true') parsedValue = true;
    else if (newValue === 'false') parsedValue = false;
    else if (newValue === 'null') parsedValue = null;
    else if (newValue === 'undefined') parsedValue = undefined;
    else if (!isNaN(newValue) && newValue !== '') parsedValue = Number(newValue);
    else if (newValue.startsWith('{') || newValue.startsWith('[')) {
      try { parsedValue = JSON.parse(newValue); } catch (e) {}
    }
    
    // Store old value
    const oldValue = window[varName];
    
    // Override in global scope
    try {
      window[varName] = parsedValue;
      return {
        success: true,
        message: `✅ Overrode <span class="highlight">${varName}</span> = <span class="code">${JSON.stringify(parsedValue)}</span>`,
        oldValue: oldValue,
        newValue: parsedValue,
        varName: varName
      };
    } catch (e) {
      return { success: false, message: `❌ Cannot override ${varName}: ${e.message}` };
    }
  }

  function executeFunction(data, parsed) {
    if (data.length === 0) {
      return { success: false, message: '❌ No function found to execute.' };
    }
    
    const funcToRun = data[0];
    const funcName = funcToRun.name;
    
    if (typeof window[funcName] !== 'function') {
      return { success: false, message: `❌ ${funcName} is not a function.` };
    }
    
    try {
      const result = window[funcName]();
      return {
        success: true,
        message: `✅ Executed <span class="highlight">${funcName}()</span>`,
        result: result,
        funcName: funcName
      };
    } catch (e) {
      return { success: false, message: `❌ Error executing ${funcName}: ${e.message}` };
    }
  }

  function executeHighlight(data, parsed) {
    if (data.length === 0) {
      return { success: false, message: '❌ No elements found to highlight.' };
    }
    
    const element = data[0];
    const selector = element.id ? `#${element.id}` : 
                     element.classes.length > 0 ? `.${element.classes[0]}` : 
                     element.tag;
    
    const target = document.querySelector(selector);
    if (!target) {
      return { success: false, message: `❌ Could not find element: ${selector}` };
    }
    
    // Add highlight effect
    const originalOutline = target.style.outline;
    const originalBackground = target.style.background;
    const originalTransition = target.style.transition;
    
    target.style.transition = 'all 0.3s ease';
    target.style.outline = '4px solid #6C63FF';
    target.style.outlineOffset = '2px';
    target.style.background = 'rgba(108, 99, 255, 0.1)';
    
    setTimeout(() => {
      target.style.outline = originalOutline || '';
      target.style.background = originalBackground || '';
      target.style.transition = originalTransition || '';
    }, 3000);
    
    return {
      success: true,
      message: `🎯 Highlighted <span class="highlight">${selector}</span> for 3 seconds`,
      selector: selector,
      element: target
    };
  }

  // ============================================================
  // 7. RESPONSE FORMATTING
  // ============================================================

  function formatResults(data, parsed) {
    if (!data || data.length === 0) {
      return {
        success: true,
        message: `❌ No ${parsed.target.toLowerCase()} found matching your query.`,
        count: 0
      };
    }
    
    let html = `🔍 Found <span class="highlight">${data.length}</span> ${parsed.target.toLowerCase()}:\n\n`;
    
    data.forEach((item, index) => {
      if (item.name !== undefined) {
        // Variable, function, or class
        html += `${index + 1}. <span class="highlight">${item.name}</span>`;
        if (item.value !== undefined) {
          html += ` = <span class="code">${typeof item.value === 'string' ? `'${item.value}'` : JSON.stringify(item.value)}</span>`;
        }
        if (item.type) {
          html += ` <span style="color: #888; font-size: 11px;">(type: ${item.type})</span>`;
        }
        if (item.params && item.params.length > 0) {
          html += ` <span style="color: #888; font-size: 11px;">(params: ${item.params.join(', ')})</span>`;
        }
        html += '\n';
      } else if (item.tag) {
        // DOM element
        html += `${index + 1}. <span class="highlight">&lt;${item.tag}&gt;</span>`;
        if (item.id) html += ` id="${item.id}"`;
        if (item.classes && item.classes.length > 0) html += ` class="${item.classes.join(' ')}"`;
        if (item.textPreview) html += ` — "${item.textPreview}"`;
        html += '\n';
      } else if (item.selector) {
        // CSS rule
        html += `${index + 1}. <span class="highlight">${item.selector}</span>`;
        if (item.properties && item.properties.length > 0) {
          const props = item.properties.slice(0, 3).map(p => `${p.name}: ${p.value}`).join('; ');
          html += ` { ${props} }`;
          if (item.properties.length > 3) html += ` (${item.properties.length - 3} more)`;
        }
        html += '\n';
      } else {
        html += `${index + 1}. ${JSON.stringify(item)}\n`;
      }
    });
    
    // Add action hints
    if (parsed.action === 'GET' && data.length > 0) {
      const firstItem = data[0];
      if (firstItem.name && parsed.target === 'VARIABLES') {
        html += `\n💡 To override: <span class="code">Consoleena.set('${firstItem.name}', 'new value')</span>`;
      }
      if (firstItem.name && parsed.target === 'FUNCTIONS') {
        html += `\n💡 To run: <span class="code">Consoleena.run('${firstItem.name}')</span>`;
      }
      if (parsed.target === 'DOM') {
        html += `\n💡 To highlight: <span class="code">Consoleena.highlight('${firstItem.tag}')</span>`;
      }
    }
    
    return {
      success: true,
      message: html,
      data: data,
      count: data.length
    };
  }

  function getHelpMessage() {
    return `
🎯 <span class="highlight">Consoleena Help</span>

<span class="info">Variables:</span>
  • "What's the first variable?"
  • "Find the 'projectName' variable"
  • "Show me all variables"

<span class="info">Functions:</span>
  • "List all functions"
  • "Find the 'greetUser' function"
  • "Run the 'calculateTotal' function"

<span class="info">DOM Elements:</span>
  • "What's in the DOM?"
  • "Find all buttons"
  • "Highlight the first button"

<span class="info">CSS:</span>
  • "Show me CSS rules"
  • "Find rules for .card"

<span class="info">Actions:</span>
  • "Override 'version' to '2.0.0'"
  • "Execute 'greetUser'"
  • "Highlight 'button'"

<span class="info">Console API:</span>
  • Consoleena.ask("your question")
  • Consoleena.get('variableName')
  • Consoleena.set('variableName', value)
  • Consoleena.run('functionName')
  • Consoleena.highlight('selector')
  • Consoleena.help()
  • Consoleena.capture()
  • Consoleena.clear()

💡 Keyboard shortcut: <span class="code">Ctrl+Shift+R</span>
    `;
  }

  // ============================================================
  // 8. MAIN ASK FUNCTION
  // ============================================================

  async function askConsoleena(question) {
    if (!question || !question.trim()) return;
    if (isProcessing) return;
    
    isProcessing = true;
    const query = question.trim();
    
    // Capture fresh context
    projectContext = extractProjectContext();
    
    // Parse the query
    const parsed = parseQuery(query);
    
    // Retrieve relevant data
    const retrieved = retrieveWithFilters(parsed);
    
    // Execute action
    const result = executeAction(parsed, retrieved);
    
    // Format response
    if (result.type === 'help') {
      addMessage(result.message, 'ai');
    } else if (result.success) {
      addMessage(result.message, 'ai');
      // If there's data, show it in console
      if (result.data && result.data.length > 0) {
        console.log('📊 Consoleena data:', result.data);
      }
    } else {
      addMessage(result.message, 'ai');
    }
    
    isProcessing = false;
  }

  // ============================================================
  // 9. UI
  // ============================================================

  let uiInitialized = false;

  function createUI() {
    if (uiInitialized) return;
    uiInitialized = true;
    
    // Toggle button
    const toggle = document.createElement('button');
    toggle.id = 'consoleena-toggle';
    toggle.innerHTML = '🔮';
    toggle.setAttribute('aria-label', 'Toggle Consoleena');
    document.body.appendChild(toggle);
    
    // Panel
    const panel = document.createElement('div');
    panel.id = 'consoleena-panel';
    panel.innerHTML = `
      <div id="consoleena-header">
        <div class="title">
          🧠 Consoleena
          <span class="badge">v${CONFIG.version}</span>
        </div>
        <div class="controls">
          <button id="consoleena-help">help</button>
          <button id="consoleena-clear">clear</button>
          <button id="consoleena-close">✕</button>
        </div>
      </div>
      <div id="consoleena-messages"></div>
      <div id="consoleena-actions">
        <button data-ask="What's the first variable?">first var</button>
        <button data-ask="Show me all functions">funcs</button>
        <button data-ask="What's in the DOM?">DOM</button>
        <button data-ask="Show me CSS rules">CSS</button>
        <button data-ask="Help">help</button>
      </div>
      <div id="consoleena-input-area">
        <input id="consoleena-input" type="text" placeholder="Ask about your project..." />
        <button id="consoleena-send">Ask ✦</button>
      </div>
    `;
    document.body.appendChild(panel);
    
    // Toggle logic
    let isOpen = false;
    toggle.addEventListener('click', () => {
      isOpen = !isOpen;
      panel.classList.toggle('open', isOpen);
      if (isOpen) {
        document.getElementById('consoleena-input').focus();
        if (!projectContext) {
          projectContext = extractProjectContext();
          addMessage('🔮 Consoleena is ready! Ask me about your project\'s DOM, CSS, variables, and more.', 'system');
          addMessage('💡 Try: "What\'s the first variable?" or click the help button.', 'system');
        }
      }
    });
    
    // Close button
    document.getElementById('consoleena-close').addEventListener('click', () => {
      isOpen = false;
      panel.classList.remove('open');
    });
    
    // Clear button
    document.getElementById('consoleena-clear').addEventListener('click', () => {
      document.getElementById('consoleena-messages').innerHTML = '';
      messages = [];
      addMessage('🧹 Console cleared. Ask me something!', 'system');
    });
    
    // Help button
    document.getElementById('consoleena-help').addEventListener('click', () => {
      askConsoleena('help');
    });
    
    // Send button
    document.getElementById('consoleena-send').addEventListener('click', () => {
      const input = document.getElementById('consoleena-input');
      askConsoleena(input.value);
      input.value = '';
    });
    
    // Enter key
    document.getElementById('consoleena-input').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        const input = document.getElementById('consoleena-input');
        askConsoleena(input.value);
        input.value = '';
      }
    });
    
    // Quick action buttons
    document.querySelectorAll('#consoleena-actions button').forEach(btn => {
      btn.addEventListener('click', () => {
        const question = btn.dataset.ask;
        const input = document.getElementById('consoleena-input');
        input.value = question;
        askConsoleena(question);
        input.value = '';
      });
    });
    
    // Keyboard shortcut: Ctrl+Shift+R
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'R') {
        e.preventDefault();
        toggle.click();
      }
    });
  }

  function addMessage(text, sender, data = null) {
    const container = document.getElementById('consoleena-messages');
    if (!container) return;
    
    const msgDiv = document.createElement('div');
    msgDiv.className = `consoleena-msg ${sender}`;
    
    if (sender === 'user') {
      msgDiv.textContent = '✦ ' + text;
    } else if (sender === 'system') {
      msgDiv.innerHTML = text;
    } else {
      msgDiv.innerHTML = text;
    }
    
    container.appendChild(msgDiv);
    container.scrollTop = container.scrollHeight;
    messages.push({ text, sender, data });
  }

  // ============================================================
  // 10. PUBLIC API
  // ============================================================

  const Consoleena = {
    // Core methods
    ask: askConsoleena,
    query: askConsoleena,
    
    // Get methods
    get: function(name) {
      projectContext = extractProjectContext();
      const vars = projectContext.variables;
      const found = vars.find(v => v.name === name);
      if (found) {
        console.log(`📊 ${found.name} =`, found.value);
        return found.value;
      }
      console.log(`❌ Variable "${name}" not found`);
      return undefined;
    },
    
    getFirst: function(target) {
      const parsed = parseQuery(`first ${target}`);
      const retrieved = retrieveWithFilters(parsed);
      if (retrieved.data && retrieved.data.length > 0) {
        console.log(`📊 First ${target}:`, retrieved.data[0]);
        return retrieved.data[0];
      }
      console.log(`❌ No ${target} found`);
      return null;
    },
    
    getAll: function(target) {
      const parsed = parseQuery(`all ${target}`);
      const retrieved = retrieveWithFilters(parsed);
      console.log(`📊 All ${target} (${retrieved.count}):`, retrieved.data);
      return retrieved.data;
    },
    
    // Set method
    set: function(name, value) {
      if (!name) {
        console.log('❌ Please provide a variable name');
        return;
      }
      const oldValue = window[name];
      window[name] = value;
      console.log(`✅ ${name} =`, value);
      console.log(`📊 Old value:`, oldValue);
      return value;
    },
    
    // Run method
    run: function(name) {
      if (typeof window[name] !== 'function') {
        console.log(`❌ "${name}" is not a function`);
        return null;
      }
      try {
        const result = window[name]();
        console.log(`✅ ${name}() executed`);
        console.log(`📊 Result:`, result);
        return result;
      } catch (e) {
        console.log(`❌ Error: ${e.message}`);
        return null;
      }
    },
    
    // Highlight method
    highlight: function(selector) {
      const target = document.querySelector(selector);
      if (!target) {
        console.log(`❌ Element "${selector}" not found`);
        return null;
      }
      const originalOutline = target.style.outline;
      const originalBackground = target.style.background;
      target.style.outline = '4px solid #6C63FF';
      target.style.outlineOffset = '2px';
      target.style.background = 'rgba(108, 99, 255, 0.1)';
      setTimeout(() => {
        target.style.outline = originalOutline || '';
        target.style.background = originalBackground || '';
      }, 3000);
      console.log(`🎯 Highlighted: ${selector}`);
      return target;
    },
    
    // Context methods
    capture: function() {
      projectContext = extractProjectContext();
      console.log('📊 Context captured:', projectContext);
      return projectContext;
    },
    
    getContext: function() {
      if (!projectContext) {
        projectContext = extractProjectContext();
      }
      return projectContext;
    },
    
    // Utility methods
    help: function() {
      console.log(`
🎯 Consoleena Help

Variables:
  Consoleena.get('variableName')     - Get a variable
  Consoleena.getFirst('variables')   - Get first variable
  Consoleena.getAll('variables')     - Get all variables
  Consoleena.set('name', value)      - Override a variable

Functions:
  Consoleena.run('functionName')     - Execute a function

DOM:
  Consoleena.highlight('selector')   - Highlight DOM element

Context:
  Consoleena.capture()               - Capture fresh context
  Consoleena.getContext()            - Get current context

Query:
  Consoleena.ask("your question")    - Natural language query

Shortcut: Ctrl+Shift+R
      `);
    },
    
    clear: function() {
      const container = document.getElementById('consoleena-messages');
      if (container) {
        container.innerHTML = '';
        messages = [];
      }
      console.log('🧹 Console cleared');
    },
    
    status: function() {
      console.log({
        ready: true,
        version: CONFIG.version,
        context: projectContext ? 'captured' : 'not captured',
        variables: projectContext?.variables?.length || 0,
        functions: projectContext?.functions?.length || 0,
        domElements: projectContext?.domElements?.length || 0,
        cssRules: projectContext?.cssRules?.length || 0,
        messages: messages.length
      });
    },
    
    // Configuration
    config: CONFIG,
    
    // Version
    version: CONFIG.version
  };

  // ============================================================
  // 11. INIT
  // ============================================================

  // Expose to global scope
  window.Consoleena = Consoleena;

  // Auto-initialize UI
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createUI);
  } else {
    createUI();
  }

  // Capture initial context
  setTimeout(() => {
    projectContext = extractProjectContext();
    console.log(`🧠 Consoleena v${CONFIG.version} loaded!`);
    console.log('💡 Try: Consoleena.ask("What\'s the first variable?")');
    console.log('💡 Or click the 🔮 button in the corner!');
    console.log('💡 Keyboard shortcut: Ctrl+Shift+R');
    console.log(`📚 Repository: https://github.com/suryasticsai/Consoleena`);
  }, 100);

})();