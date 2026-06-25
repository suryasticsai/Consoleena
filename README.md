# Consoleena
Mini RAG-powered Consoleena is a RAG assistant that lives in your browser console. It understands your project's runtime environment and lets you query, inspect, and manipulate it using natural language.

---
> **Your console-powered RAG assistant — query and manipulate your project's DOM, CSS, variables, and more using natural language.**

Consoleena is a lightweight, zero-dependency JavaScript library that gives you superpowers in the browser console. Ask questions about your project's runtime environment, get instant answers, and even modify variables or execute functions — all through natural language.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![JavaScript](https://img.shields.io/badge/JavaScript-ES6+-F7DF1E.svg)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)](https://github.com/suryasticsai/Consoleena)

---

## 🌐 Live Demo

**[Try Consoleena Now →](https://suryasticsai.github.io/Consoleena)**

Visit the live demo to see Consoleena in action. No installation required — just open the link and start asking questions.

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🔍 **Context Capture** | Automatically captures variables, functions, classes, DOM, and CSS |
| 💬 **Natural Language Queries** | Ask questions like "What's the first variable?" or "Show me all functions" |
| 🎯 **Smart Filtering** | Use "first", "last", "nth", or "all" to narrow results |
| ⚡ **Variable Override** | Change variables on the fly: `Consoleena.set('version', '2.0.0')` |
| 🏃 **Function Execution** | Run functions from the console: `Consoleena.run('greetUser')` |
| 🎨 **DOM Highlighting** | Visually highlight elements: `Consoleena.highlight('button')` |
| 📦 **Zero Dependencies** | Single file, no external libraries |
| 🔮 **Floating UI Panel** | Interactive chat interface with quick actions |
| ⌨️ **Keyboard Shortcut** | `Ctrl+Shift+R` to toggle the panel instantly |
| 🖥️ **Full Console API** | Use Consoleena directly from the browser console |

---

## 🚀 Quick Start

### Option 1: CDN (Recommended)

Add Consoleena to any HTML page with a single script tag:

```html
<script src="https://cdn.jsdelivr.net/gh/suryasticsai/Consoleena@latest/consoleena.min.js"></script>
```

Option 2: Download

1. Download consoleena.js or consoleena.min.js
2. Include it in your HTML:
   ```html
   <script src="consoleena.min.js"></script>
   ```
3. Start using it immediately!

Option 3: From GitHub

```bash
git clone https://github.com/suryasticsai/Consoleena.git
cd Consoleena
# Open index.html in your browser
```

---

🎯 Usage Examples

In the Browser Console

```javascript
// Ask natural language questions
Consoleena.ask("What's the first variable?")
Consoleena.ask("Show me all functions")
Consoleena.ask("Find the 'projectName' variable")
Consoleena.ask("Highlight the first button")

// Get specific information
Consoleena.get('projectName')              // Get a variable
Consoleena.getFirst('variables')           // Get first variable
Consoleena.getAll('functions')             // Get all functions

// Modify things
Consoleena.set('version', '2.0.0')         // Override a variable
Consoleena.run('greetUser')                // Execute a function
Consoleena.highlight('button')             // Highlight DOM element

// Context management
Consoleena.capture()                       // Capture fresh context
Consoleena.getContext()                    // Get current context

// Utility
Consoleena.help()                          // Show help
Consoleena.clear()                         // Clear chat
Consoleena.status()                        // Show status
```

Using the UI Panel

1. Click the 🔮 button in the bottom-right corner
2. Type your question in the input field
3. Press Enter or click Ask ✦

Or use the keyboard shortcut: Ctrl+Shift+R

Example Queries

Query What It Does
"What's the first variable?" Returns the first global variable with its value and type
"Show me all functions" Lists all global functions with parameters
"Find 'projectName'" Searches for a specific variable by name
"Get the 3rd variable" Returns the 3rd variable in the list
"Override 'version' to '2.0.0'" Changes the variable value in global scope
"Run 'greetUser'" Executes the function and shows the result
"Highlight the first button" Adds a visual highlight to the element
"What CSS rules apply to .card?" Shows CSS properties for the selector
"List all classes" Shows classes defined in the project
"Show me DOM elements with class 'highlight'" Filters DOM by class

---

🛠️ How It Works

Architecture Flow

```
┌─────────────────────────────────────────────────────────────┐
│                  YOUR PROJECT                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  DOM  │  CSS  │  Variables  │  Functions  │  Console │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
╔═══════════════════════════════════════════════════════════════╗
║                    CONSOLEENA PIPELINE                        ║
╠═══════════════════════════════════════════════════════════════╣
║  1. Capture Context  →  2. Parse Query  →  3. Retrieve      ║
║                                                               ║
║  4. Execute Action  →  5. Format Response                    ║
╚═══════════════════════════════════════════════════════════════╝
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    YOUR ANSWER                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  🔍 Found 1 variable:                              │  │
│  │  1. projectName = 'Consoleena' (type: string)      │  │
│  │                                                    │  │
│  │  💡 To override: Consoleena.set('projectName',     │  │
│  │     'new value')                                  │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

Technical Deep Dive

1. Context Extraction

Consoleena captures everything about your current page:

· Global Variables: All window properties with types and values
· Functions: Names, parameters, async status
· Classes: Names with their methods
· DOM Elements: Tags, IDs, classes, attributes, text previews
· CSS Rules: Selectors and their properties
· Page Metadata: Title, URL, viewport, user agent

2. Query Parsing

Consoleena understands natural language patterns:

· Target detection: Variables, functions, classes, DOM, CSS
· Filter detection: First, last, all, nth
· Action detection: Get, set, execute, highlight
· Name extraction: Finds variable/function names in quotes or phrases

3. Smart Retrieval

· Filters results based on target type
· Applies positional filters (first, last, nth, all)
· Searches by name if specified
· Returns structured, formatted results

4. Action Execution

· GET: Returns variable values, function details, DOM info
· SET: Overrides variables in global scope
· EXECUTE: Runs functions and captures results
· HIGHLIGHT: Visually highlights DOM elements

---

📊 API Reference

Core Methods

Method Description Example
Consoleena.ask(question) Natural language query Consoleena.ask("What's the first variable?")
Consoleena.query(question) Alias for ask Consoleena.query("Show me all functions")

Get Methods

Method Description Example
Consoleena.get(name) Get a specific variable Consoleena.get('projectName')
Consoleena.getFirst(target) Get first item of target type Consoleena.getFirst('variables')
Consoleena.getAll(target) Get all items of target type Consoleena.getAll('functions')

Action Methods

Method Description Example
Consoleena.set(name, value) Override a variable Consoleena.set('version', '2.0.0')
Consoleena.run(name) Execute a function Consoleena.run('greetUser')
Consoleena.highlight(selector) Highlight DOM element Consoleena.highlight('button')

Context Methods

Method Description Example
Consoleena.capture() Capture fresh context Consoleena.capture()
Consoleena.getContext() Get current context Consoleena.getContext()

Utility Methods

Method Description Example
Consoleena.help() Show help Consoleena.help()
Consoleena.clear() Clear chat Consoleena.clear()
Consoleena.status() Show status Consoleena.status()
Consoleena.config View configuration Consoleena.config
Consoleena.version View version Consoleena.version

---

🎨 UI Features

Feature Description
Floating Button 🔮 Toggle panel from anywhere
Chat Interface Clean, dark-themed conversational UI
Quick Actions One-click buttons for common queries
Keyboard Shortcut Ctrl+Shift+R to toggle
Responsive Works on desktop, tablet, and mobile
Status Indicator Shows when Consoleena is ready/thinking

---

🔧 Configuration

```javascript
// Consoleena configuration (read-only)
Consoleena.config = {
  chunkSize: 200,        // Characters per chunk
  topK: 5,               // Number of chunks to retrieve
  llmEndpoint: 'https://text.pollinations.ai/',
  version: '1.0.0'
};
```

---

📁 Project Structure

```
Consoleena/
├── README.md              # This file
├── LICENSE                # MIT License
├── consoleena.js          # Source code (unminified)
├── consoleena.min.js      # Minified version (~8KB)
├── index.html             # Demo page
├── package.json           # npm package metadata
└── .gitignore             # Git ignore file
```

---

🧪 Browser Support

Browser Version
Chrome 86+
Firefox 90+
Edge 86+
Safari 15.4+
Opera 72+

---

🎯 Use Cases

Use Case How Consoleena Helps
Debugging Quickly inspect variables without console spelunking
Onboarding New developers can ask "What functions are available?"
Exploration "Show me all DOM elements with class 'active'"
Testing Override variables to test edge cases
Learning "What classes are defined in this project?"
Documentation "List all global functions"
UI Development "Highlight the first button" to find elements
Performance "What variables are using memory?"

---

🤝 Contributing

Development Setup

```bash
# Clone the repository
git clone https://github.com/suryasticsai/Consoleena.git
cd Consoleena

# No build step needed — edit consoleena.js directly
# Open index.html in your browser to test
```

Contribution Guidelines

1. Fork the repository
2. Create a feature branch (git checkout -b feature/amazing)
3. Commit your changes (git commit -m 'Add amazing feature')
4. Push to the branch (git push origin feature/amazing)
5. Open a Pull Request

Areas for Contribution

· New query patterns and intents
· Additional DOM manipulation actions
· Performance improvements
· More file format support
· Browser extension version
· UI/UX enhancements
· Documentation improvements

---

📄 License

MIT License — See LICENSE file for details.

---

🙏 Acknowledgments

· TF-IDF Algorithm — Classic information retrieval
· Browser APIs — File System Access, DOMParser, CSSOM
· Pollinations.ai — Free text generation API (optional)

---

📬 Contact

· Author: Surya Sai Varakala
· GitHub: suryasticsai
· Email: suryasuprince@gmail.com
· Project: https://github.com/suryasticsai/Consoleena

---

⭐ Support

If you find Consoleena valuable:

· ⭐ Star the repository on GitHub
· 🐛 Report issues
· 💡 Suggest features
· 🔄 Share with others

---

Built with ❤️ for the developer community

```