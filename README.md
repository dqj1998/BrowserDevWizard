# A test/debug environment for developments on browsers

A system where VSCode + Copilot can observe a live Chrome browser, inspect DOM, capture console logs/screenshots, send automation commands, and modify Chrome Extension code with auto-reload.

## Architecture

```
┌─────────────────┐     WebSocket      ┌─────────────────┐
│ Chrome Extension│◄──────────────────►│  Debug Server   │
│  (background +  │    ws://localhost  │   (Node.js)     │
│  content scripts)│       :8123       │                 │
└─────────────────┘                    └────────┬────────┘
                                                │
                                                │ Writes JSON
                                                ▼
                                       ┌─────────────────┐
                                       │  /data/*.json   │
                                       │  (DOM, Console, │
                                       │   Screenshots)  │
                                       └────────┬────────┘
                                                │
                                                │ Read by
                                                ▼
                                       ┌─────────────────┐
                                       │ VSCode + Copilot│
                                       │  (You + AI)     │
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
| `launch_browser` | Start Chrome with debug extension loaded |
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

Copy `.vscode/mcp.json` to your project's `.vscode/` folder with absolute path:

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

#### Option 2: Global User Settings

Add to VS Code settings.json (`Cmd+,` → "Edit in settings.json"):

```json
{
  "github.copilot.chat.mcp.servers": {
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
1. launch_browser(url) → Start Chrome with extension
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
