# A test/debug environment for developments on browsers

A system where AI LLM can observe a live Chrome browser, inspect DOM, capture console logs/screenshots, send automation commands, and modify Chrome Extension code with auto-reload.

## Architecture

```
┌─────────────────┐     WebSocket      ┌─────────────────┐
│ Chrome Extension│◄──────────────────►│  Debug Server   │
│  (background +  │    ws://localhost  │   (Node.js)     │
│  content scripts)│       :8123       │   :8124 HTTP    │
└────────┬────────┘                    └────────┬────────┘
         │                                      │
         │ Executes                             │ Writes JSON
         │ (click/type/run_js)                  ▼
         │                             ┌─────────────────┐
         │                             │  /data/*.json   │
         │                             │  (DOM, Console, │
         │                             │   Screenshots)  │
         │                             └────────┬────────┘
         │                                      │
         │         ┌────────────────────────────┘
         │         │ Read by
         │         ▼
         │ ┌─────────────────┐
         │ │ VSCode + Copilot│
         │ │  (You + AI)     │
         │ └────────┬────────┘
         │          │
         │          │ Sends commands via:
         │          │ • commands.json (file watch)
         │          │ • HTTP POST /execute
         │          │ • MCP tools (execute_action)
         │          ▼
         │ ┌─────────────────┐
         └─┤  Debug Server   │──► WebSocket ──► Extension
           │  (relays cmd)   │
           └─────────────────┘
```

## Setup

### 1. Install Dependencies

```bash
npm run install:all
```

### 2. Load Chrome Extension

1. Open Chrome → `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `/extension` folder

### 3. Start the Server

```bash
npm run server
# or for development with auto-reload:
npm run server:dev
```

### 4. Connect Extension

1. Click the extension icon in Chrome
2. Click "Connect" to establish WebSocket connection
3. Use "Capture DOM" / "Capture Screenshot" buttons

## Usage

### Reading Browser Data

Check these files in `/debug-server/data/`:

- `dom-snapshot.json` — Full HTML of the active tab
- `console-logs.json` — Captured console.log/error/warn messages
- `screenshot.json` — Base64 encoded screenshot
- `events.json` — Event history log

### Sending Commands

Edit `/debug-server/commands.json` to queue automation commands:

```json
{
  "commands": [
    { "action": "click", "selector": "#submit-btn" },
    { "action": "type", "selector": "#email", "text": "test@example.com" },
    { "action": "run_js", "code": "console.log('Hello from AI!')" }
  ]
}
```

The server watches this file and sends commands to the extension automatically.

### Auto-Reload

When you modify any file in `/extension/`, the server automatically tells Chrome to reload the extension.

## File Structure

```
/AIExtensionDebugger
├── package.json
├── .gitignore
├── README.md
├── extension/
│   ├── manifest.json      # Chrome Extension manifest (v3)
│   ├── background.js      # WebSocket client + message relay
│   ├── content.js         # DOM/console capture + command execution
│   ├── popup.html         # Extension popup UI
│   └── popup.js           # Popup logic
├── mcp-server/
│   ├── package.json       # MCP server dependencies
│   ├── index.js           # MCP server with AI tools
│   ├── browser.js         # Playwright browser launcher
│   └── diff-utils.js      # State comparison utilities
└── debug-server/
    ├── package.json       # Server dependencies
    ├── index.js           # WebSocket server + HTTP API + file watcher
    ├── commands.json      # Command queue (you edit this)
    └── data/
        ├── dom-snapshot.json
        ├── console-logs.json
        ├── screenshot.json
        └── events.json
```

## Operation Modes

BrowserDevWizard supports two operation modes, each with different trade-offs:

### Mode Comparison

| Feature | **Extension Mode** | **CDP Mode** |
|---------|-------------------|--------------|
| **Setup** | Install extension + run debug-server | Start Chrome with `--remote-debugging-port=9222` |
| **Use existing profile** | ✅ Yes (your normal Chrome with logins) | ⚠️ Needs separate `--user-data-dir` (no shared logins) |
| **Run JavaScript** | ⚠️ Limited (blocked by strict CSP sites like Gemini, GitHub) | ✅ Yes, anything (full DevTools power) |
| **DOM operations** | ✅ Click, type, scroll, get_dom | ✅ Everything |
| **Screenshots** | ✅ Yes | ✅ Yes |
| **Console logs** | ✅ Yes (captures from page) | ✅ Yes |
| **Works on any site** | ✅ Yes for DOM ops, ❌ No for JS on strict CSP | ✅ Yes, everything |
| **Extension required** | ✅ Yes | ❌ No |

### When to Use Which Mode

- **Extension Mode**: Daily browsing/debugging on your normal Chrome with all your logins. Good for DOM operations (click, type, scroll, get_dom, screenshots). JS execution works on most sites but fails on strict CSP sites.

- **CDP Mode**: When you need to run arbitrary JavaScript on strict CSP sites (Gemini, GitHub, Google, etc.), or when you want full DevTools-level control. No extension needed, but requires starting Chrome with special flags.

**Pro tip**: You can use both! Use your normal Chrome with extension for most tasks, and have a separate CDP-enabled Chrome for when you need to run JS on strict sites.

### Extension Mode Setup

See [Setup](#setup) section below.

### CDP Mode Setup

1. **Start Chrome with debugging enabled:**

```bash
# macOS
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/Chrome-Debug-Profile"

# Windows
"C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9222 ^
  --user-data-dir="%USERPROFILE%\Chrome-Debug-Profile"

# Linux
google-chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/Chrome-Debug-Profile"
```

2. **Connect via MCP tool:**

Use the `connect_browser_by_cdp` tool with endpoint URL `http://localhost:9222`

3. **Execute commands:**

All MCP tools (`navigate`, `execute_action`, `capture_state`, etc.) will work through CDP.

> **Note:** The `--user-data-dir` flag is required for remote debugging. The debug profile won't have your existing logins (Chrome encrypts cookies per-profile), but you can log in manually and those logins will persist in that profile for future use.

---

## MCP Server (AI Integration)

The MCP server allows VS Code Copilot to control the browser directly through tools.

### MCP Setup

```bash
# Install all dependencies including MCP server
npm run install:all

# Install Playwright browser
npm run install:playwright

# Start the debug server (required)
npm run server
```

### MCP Tools Available

| Tool | Description |
|------|-------------|
| `launch_browser` | Start Chrome with debug extension loaded (Extension mode) |
| `connect_browser_by_cdp` | Connect to running Chrome via CDP (CDP mode) |
| `navigate` | Go to URL and wait for page load |
| `capture_state` | Snapshot DOM/screenshot/logs to session folder |
| `execute_action` | Click, type, run JavaScript, or scroll |
| `get_state` | Get current browser state without saving |
| `list_sessions` | List all capture sessions |
| `compare_states` | Diff two sessions and find errors |
| `get_errors` | Extract console errors |
| `get_dom` | Get full DOM HTML content |
| `wait_for_element` | Wait for selector to appear |
| `close_browser` | Clean shutdown |
| `get_status` | Check browser/server connection status |

### Using MCP from Another VS Code Instance

#### Option 1: Workspace Config

1. Copy `.vscode/mcp.json` to your project's `.vscode/` folder with absolute path:

```json
{
  "servers": {
    "browser-debug": {
      "type": "stdio",
      "command": "node",
      "args": ["/Users/qingjie.du/HDD/my-prjs/CW/AIExtensionDebugger/mcp-server/index.js"],
      "env": {
        "DEBUG_SERVER_URL": "http://localhost:8124"
      }
    }
  }
}
```

2. Start VSCode on the project root: code your?project_folder

#### Option 2: Global User Settings(!Need more tests)

Add to VS Code settings.json (`Cmd+,` → "Edit in settings.json"):

```json
{
  "mcpServers": {
    "browser-debug": {
      "type": "stdio",
      "command": "node",
      "args": ["/Users/qingjie.du/HDD/my-prjs/CW/AIExtensionDebugger/mcp-server/index.js"],
      "env": {
        "DEBUG_SERVER_URL": "http://localhost:8124"
      }
    }
  }
}
```

### Test/Debug/Confirm Loop

The AI can run an automated loop:

```
1. connect_browser or launch_browser(url) → Start Chrome with extension
2. capture_state("before") → Save initial state
3. execute_action({click/type/run_js}) → Interact with page
4. capture_state("after") → Save new state
5. compare_states("before", "after") → Analyze differences
6. AI reviews errors → Fixes code → Repeat until done
```text

## HTTP API Endpoints

The debug server also exposes an HTTP API on port 8124:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/status` | GET | Connection status |
| `/state` | GET | Get all current state data |
| `/data/:file` | GET | Get specific data file |
| `/sessions` | GET | List capture sessions |
| `/session/:name` | GET | Get session data |
| `/execute` | POST | Execute command with result |
| `/capture` | POST | Trigger capture-all |
| `/diff/:s1/:s2` | GET | Compare two sessions |

## License

MIT
