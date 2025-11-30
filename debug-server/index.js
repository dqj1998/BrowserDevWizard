// Debug Server - WebSocket Bridge + HTTP API
// Connects to Chrome Extension, writes data to JSON files, watches for file changes
// Provides REST API for MCP server integration

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import chokidar from 'chokidar';
import express from 'express';
import cors from 'cors';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const EXTENSION_DIR = path.join(__dirname, '..', 'extension');
const COMMANDS_FILE = path.join(__dirname, 'commands.json');

// Track current capture-all session
let currentCaptureSession = null;

// Pending command promises (for synchronous execution)
const pendingCommands = new Map();
let commandIdCounter = 0;

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Initialize data files
const dataFiles = {
  'dom-snapshot.json': { html: '', url: '', timestamp: null },
  'console-logs.json': { logs: [] },
  'screenshot.json': { dataUrl: '', timestamp: null },
  'events.json': { events: [] }
};

for (const [file, initial] of Object.entries(dataFiles)) {
  const filePath = path.join(DATA_DIR, file);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(initial, null, 2));
  }
}

// Initialize commands file
if (!fs.existsSync(COMMANDS_FILE)) {
  fs.writeFileSync(COMMANDS_FILE, JSON.stringify({ commands: [] }, null, 2));
}

// WebSocket server
const PORT = 8123;
const wss = new WebSocketServer({ port: PORT });
let wsClient = null;
let heartbeatInterval = null;
let lastPongTime = Date.now();

// Heartbeat configuration
const HEARTBEAT_INTERVAL = 15000; // Send ping every 15 seconds
const HEARTBEAT_TIMEOUT = 30000;  // Consider dead if no pong for 30 seconds

console.log(`🚀 BrowserDevWizard Server running on ws://localhost:${PORT}`);
console.log(`📁 Data directory: ${DATA_DIR}`);
console.log(`📁 Extension directory: ${EXTENSION_DIR}`);
console.log(`📝 Commands file: ${COMMANDS_FILE}`);
console.log('');
console.log('Waiting for Chrome Extension to connect...');

// Start heartbeat mechanism
function startHeartbeat(ws) {
  stopHeartbeat();
  lastPongTime = Date.now();
  
  heartbeatInterval = setInterval(() => {
    if (!ws || ws.readyState !== 1) {
      stopHeartbeat();
      return;
    }
    
    // Check if we've received a pong recently
    if (Date.now() - lastPongTime > HEARTBEAT_TIMEOUT) {
      console.log('💔 Connection timeout - no heartbeat response');
      ws.terminate();
      stopHeartbeat();
      return;
    }
    
    // Send ping
    try {
      ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
    } catch (e) {
      console.error('Failed to send ping:', e);
    }
  }, HEARTBEAT_INTERVAL);
}

function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

// ===== Express HTTP API =====
const HTTP_PORT = 8124;
const app = express();
app.use(cors());
app.use(express.json());

// GET /status - Check connection status
app.get('/status', (req, res) => {
  res.json({
    connected: wsClient?.readyState === 1,
    wsPort: PORT,
    httpPort: HTTP_PORT,
    dataDir: DATA_DIR
  });
});

// GET /state - Get all current state data
app.get('/state', (req, res) => {
  try {
    const state = {
      dom: JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'dom-snapshot.json'), 'utf8')),
      console: JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'console-logs.json'), 'utf8')),
      screenshot: JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'screenshot.json'), 'utf8')),
      events: JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'events.json'), 'utf8'))
    };
    res.json(state);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /refresh-dom - Request fresh DOM snapshot from the browser and wait for result
app.post('/refresh-dom', async (req, res) => {
  const { timeout = 5000 } = req.body || {};
  
  if (!wsClient || wsClient.readyState !== 1) {
    return res.status(503).json({ error: 'Extension not connected' });
  }
  
  // Get the current DOM timestamp before requesting
  let beforeTimestamp = null;
  try {
    const currentDom = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'dom-snapshot.json'), 'utf8'));
    beforeTimestamp = currentDom.timestamp;
  } catch (e) {}
  
  // Request fresh DOM
  wsClient.send(JSON.stringify({ type: 'request_dom' }));
  
  // Wait for DOM to be updated (check for timestamp change)
  const startTime = Date.now();
  const checkInterval = 100;
  
  const waitForNewDom = () => {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (Date.now() - startTime > timeout) {
          reject(new Error('Timeout waiting for fresh DOM'));
          return;
        }
        
        try {
          const newDom = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'dom-snapshot.json'), 'utf8'));
          // Check if timestamp is newer
          if (newDom.timestamp && newDom.timestamp !== beforeTimestamp) {
            resolve(newDom);
            return;
          }
        } catch (e) {}
        
        setTimeout(check, checkInterval);
      };
      check();
    });
  };
  
  try {
    const dom = await waitForNewDom();
    res.json({ success: true, dom });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /refresh-state - Request fresh DOM and screenshot from the browser
app.post('/refresh-state', async (req, res) => {
  const { timeout = 5000 } = req.body || {};
  
  if (!wsClient || wsClient.readyState !== 1) {
    return res.status(503).json({ error: 'Extension not connected' });
  }
  
  // Get timestamps before requesting
  let beforeDomTimestamp = null;
  let beforeScreenshotTimestamp = null;
  try {
    const currentDom = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'dom-snapshot.json'), 'utf8'));
    beforeDomTimestamp = currentDom.timestamp;
  } catch (e) {}
  try {
    const currentScreenshot = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'screenshot.json'), 'utf8'));
    beforeScreenshotTimestamp = currentScreenshot.timestamp;
  } catch (e) {}
  
  // Request fresh DOM and screenshot
  wsClient.send(JSON.stringify({ type: 'request_dom' }));
  wsClient.send(JSON.stringify({ type: 'capture_screenshot' }));
  
  const startTime = Date.now();
  const checkInterval = 100;
  
  const waitForNewState = () => {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (Date.now() - startTime > timeout) {
          reject(new Error('Timeout waiting for fresh state'));
          return;
        }
        
        try {
          const newDom = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'dom-snapshot.json'), 'utf8'));
          const newScreenshot = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'screenshot.json'), 'utf8'));
          
          // Check if both are updated
          const domUpdated = newDom.timestamp && newDom.timestamp !== beforeDomTimestamp;
          const screenshotUpdated = newScreenshot.timestamp && newScreenshot.timestamp !== beforeScreenshotTimestamp;
          
          if (domUpdated && screenshotUpdated) {
            resolve({ dom: newDom, screenshot: newScreenshot });
            return;
          }
        } catch (e) {}
        
        setTimeout(check, checkInterval);
      };
      check();
    });
  };
  
  try {
    const state = await waitForNewState();
    res.json({ success: true, ...state });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /data/:file - Get specific data file
app.get('/data/:file', (req, res) => {
  const validFiles = ['dom-snapshot.json', 'console-logs.json', 'screenshot.json', 'events.json'];
  const file = req.params.file;
  
  if (!validFiles.includes(file)) {
    return res.status(400).json({ error: 'Invalid file name' });
  }
  
  try {
    const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /console - Get all console logs with filtering options
app.get('/console', (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'console-logs.json'), 'utf8'));
    const logs = data.logs || [];
    
    // Filter by method if specified
    const methods = req.query.methods ? req.query.methods.split(',') : null;
    const limit = req.query.limit ? parseInt(req.query.limit) : null;
    const since = req.query.since ? parseInt(req.query.since) : null;
    
    let filteredLogs = logs;
    
    // Filter by method type (log, error, warn, info, debug)
    if (methods) {
      filteredLogs = filteredLogs.filter(l => methods.includes(l.method));
    }
    
    // Filter by timestamp
    if (since) {
      filteredLogs = filteredLogs.filter(l => l.timestamp > since);
    }
    
    // Limit results
    if (limit && limit > 0) {
      filteredLogs = filteredLogs.slice(-limit);
    }
    
    // Calculate stats
    const stats = {
      total: filteredLogs.length,
      byMethod: {}
    };
    for (const log of filteredLogs) {
      stats.byMethod[log.method] = (stats.byMethod[log.method] || 0) + 1;
    }
    
    res.json({
      logs: filteredLogs,
      stats,
      filters: { methods, limit, since }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /console - Clear console logs
app.delete('/console', (req, res) => {
  try {
    fs.writeFileSync(path.join(DATA_DIR, 'console-logs.json'), JSON.stringify({ logs: [] }, null, 2));
    res.json({ success: true, message: 'Console logs cleared' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /sessions - List all capture sessions
app.get('/sessions', (req, res) => {
  try {
    const entries = fs.readdirSync(DATA_DIR, { withFileTypes: true });
    const sessions = entries
      .filter(e => e.isDirectory())
      .map(e => ({
        name: e.name,
        path: path.join(DATA_DIR, e.name),
        files: fs.readdirSync(path.join(DATA_DIR, e.name))
      }))
      .sort((a, b) => b.name.localeCompare(a.name));
    res.json({ sessions });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /session/:name - Get specific session data
app.get('/session/:name', (req, res) => {
  const sessionDir = path.join(DATA_DIR, req.params.name);
  
  if (!fs.existsSync(sessionDir)) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  try {
    const session = { name: req.params.name };
    const files = fs.readdirSync(sessionDir);
    
    for (const file of files) {
      if (file.endsWith('.json')) {
        const key = file.replace('.json', '').replace(/-/g, '_');
        session[key] = JSON.parse(fs.readFileSync(path.join(sessionDir, file), 'utf8'));
      }
    }
    res.json(session);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /execute - Execute command and wait for result
app.post('/execute', async (req, res) => {
  const { action, selector, text, code, url, timeout = 5000 } = req.body;
  
  if (!wsClient || wsClient.readyState !== 1) {
    return res.status(503).json({ error: 'Extension not connected' });
  }
  
  const commandId = ++commandIdCounter;
  const command = { action, selector, text, code, url, commandId };
  
  // Create promise for command result
  const resultPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(commandId);
      reject(new Error('Command timeout'));
    }, timeout);
    
    pendingCommands.set(commandId, { resolve, reject, timer });
  });
  
  // Send command
  wsClient.send(JSON.stringify({ type: 'execute', ...command }));
  
  try {
    const result = await resultPromise;
    res.json({ success: true, result, commandId });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message, commandId });
  }
});

// POST /navigate - Navigate to URL using extension
app.post('/navigate', async (req, res) => {
  const { url, timeout = 30000 } = req.body;
  
  if (!wsClient || wsClient.readyState !== 1) {
    return res.status(503).json({ error: 'Extension not connected. Please open Chrome with the extension installed.' });
  }
  
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }
  
  const commandId = ++commandIdCounter;
  
  // Create promise for navigation result
  const resultPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(commandId);
      reject(new Error('Navigation timeout'));
    }, timeout);
    
    pendingCommands.set(commandId, { resolve, reject, timer });
  });
  
  // Send navigate command
  wsClient.send(JSON.stringify({ type: 'navigate', url, commandId }));
  
  try {
    const result = await resultPromise;
    res.json({ success: true, result, commandId });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message, commandId });
  }
});

// GET /tab - Get current tab info
app.get('/tab', async (req, res) => {
  if (!wsClient || wsClient.readyState !== 1) {
    return res.status(503).json({ error: 'Extension not connected' });
  }
  
  const commandId = ++commandIdCounter;
  
  const resultPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(commandId);
      reject(new Error('Timeout getting tab info'));
    }, 5000);
    
    pendingCommands.set(commandId, { resolve, reject, timer });
  });
  
  wsClient.send(JSON.stringify({ type: 'get_tab_info', commandId }));
  
  try {
    const result = await resultPromise;
    res.json({ success: true, ...result.result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /reload-extension - Reload the browser extension
app.post('/reload-extension', (req, res) => {
  if (!wsClient || wsClient.readyState !== 1) {
    return res.status(503).json({ error: 'Extension not connected' });
  }
  
  wsClient.send(JSON.stringify({ type: 'reload_extension' }));
  res.json({ success: true, message: 'Extension reload command sent' });
});

// POST /capture - Trigger capture-all and return session data
app.post('/capture', async (req, res) => {
  const { name } = req.body;
  
  if (!wsClient || wsClient.readyState !== 1) {
    return res.status(503).json({ error: 'Extension not connected' });
  }
  
  // Create session folder
  const timestamp = Date.now();
  const folderName = name || new Date(timestamp).toISOString().replaceAll(/[:.]/g, '-');
  const sessionDir = path.join(DATA_DIR, folderName);
  fs.mkdirSync(sessionDir, { recursive: true });
  
  // Wait for capture to complete
  const capturePromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Capture timeout')), 10000);
    
    const checkCapture = setInterval(() => {
      const files = ['dom-snapshot.json', 'screenshot.json'];
      const hasAll = files.every(f => fs.existsSync(path.join(sessionDir, f)));
      if (hasAll) {
        clearInterval(checkCapture);
        clearTimeout(timer);
        resolve(folderName);
      }
    }, 200);
  });
  
  // Trigger capture
  currentCaptureSession = { dir: sessionDir, timestamp };
  wsClient.send(JSON.stringify({ type: 'request_dom_all' }));
  
  // Wait a bit then request screenshot
  setTimeout(() => {
    if (wsClient?.readyState === 1) {
      wsClient.send(JSON.stringify({ type: 'capture_screenshot_all' }));
    }
  }, 500);
  
  try {
    const sessionName = await capturePromise;
    // Read and return session data
    const session = { name: sessionName };
    const files = fs.readdirSync(sessionDir);
    for (const file of files) {
      if (file.endsWith('.json')) {
        const key = file.replace('.json', '').replace(/-/g, '_');
        session[key] = JSON.parse(fs.readFileSync(path.join(sessionDir, file), 'utf8'));
      }
    }
    res.json({ success: true, session });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /diff/:session1/:session2 - Compare two sessions
app.get('/diff/:session1/:session2', (req, res) => {
  const { session1, session2 } = req.params;
  const dir1 = path.join(DATA_DIR, session1);
  const dir2 = path.join(DATA_DIR, session2);
  
  if (!fs.existsSync(dir1) || !fs.existsSync(dir2)) {
    return res.status(404).json({ error: 'One or both sessions not found' });
  }
  
  try {
    const data1 = {};
    const data2 = {};
    
    for (const file of ['dom-snapshot.json', 'console-logs.json', 'events.json']) {
      try {
        data1[file] = JSON.parse(fs.readFileSync(path.join(dir1, file), 'utf8'));
      } catch { data1[file] = null; }
      try {
        data2[file] = JSON.parse(fs.readFileSync(path.join(dir2, file), 'utf8'));
      } catch { data2[file] = null; }
    }
    
    // Basic diff
    const diff = {
      session1,
      session2,
      domChanged: data1['dom-snapshot.json']?.html !== data2['dom-snapshot.json']?.html,
      urlChanged: data1['dom-snapshot.json']?.url !== data2['dom-snapshot.json']?.url,
      newConsoleEntries: (data2['console-logs.json']?.logs?.length || 0) - (data1['console-logs.json']?.logs?.length || 0),
      newEvents: (data2['events.json']?.events?.length || 0) - (data1['events.json']?.events?.length || 0),
      consoleErrors: data2['console-logs.json']?.logs?.filter(l => l.method === 'error') || []
    };
    
    res.json(diff);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start HTTP server
app.listen(HTTP_PORT, () => {
  console.log(`🌐 HTTP API running on http://localhost:${HTTP_PORT}`);
});

// Handle WebSocket connections
wss.on('connection', (ws) => {
  wsClient = ws;
  console.log('');
  console.log('✅ Chrome Extension connected!');
  console.log('');
  
  // Start heartbeat mechanism
  startHeartbeat(ws);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      handleMessage(msg);
    } catch (e) {
      console.error('Failed to parse message:', e);
    }
  });

  ws.on('close', () => {
    console.log('❌ Chrome Extension disconnected');
    stopHeartbeat();
    wsClient = null;
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    stopHeartbeat();
  });
});

// Handle incoming messages from extension
function handleMessage(msg) {
  const timestamp = new Date().toISOString();

  switch (msg.type) {
    case 'pong':
      // Update last pong time for heartbeat
      lastPongTime = Date.now();
      break;
      
    case 'extension_ready':
      console.log(`[${timestamp}] Extension ready`);
      lastPongTime = Date.now(); // Reset pong time on reconnect
      // Process any pending commands
      processPendingCommands();
      break;

    case 'capture_all_start':
      // Start a new capture-all session with timestamped folder
      const folderName = new Date(msg.timestamp).toISOString().replace(/[:.]/g, '-');
      const sessionDir = path.join(DATA_DIR, folderName);
      fs.mkdirSync(sessionDir, { recursive: true });
      currentCaptureSession = { dir: sessionDir, timestamp: msg.timestamp };
      console.log(`[${timestamp}] 📁 Capture All started: ${folderName}`);
      break;

    case 'dom_snapshot_all':
      if (currentCaptureSession) {
        console.log(`[${timestamp}] DOM snapshot saved to session folder`);
        fs.writeFileSync(
          path.join(currentCaptureSession.dir, 'dom-snapshot.json'),
          JSON.stringify({ html: msg.html, url: msg.url, timestamp: msg.timestamp }, null, 2)
        );
        // Also copy current console logs
        try {
          const consoleLogs = fs.readFileSync(path.join(DATA_DIR, 'console-logs.json'), 'utf8');
          fs.writeFileSync(path.join(currentCaptureSession.dir, 'console-logs.json'), consoleLogs);
        } catch (e) {}
        // Copy events
        try {
          const events = fs.readFileSync(path.join(DATA_DIR, 'events.json'), 'utf8');
          fs.writeFileSync(path.join(currentCaptureSession.dir, 'events.json'), events);
        } catch (e) {}
      }
      // Also update the regular file
      writeDataFile('dom-snapshot.json', {
        html: msg.html,
        url: msg.url,
        timestamp: msg.timestamp
      });
      break;

    case 'screenshot_all':
      if (currentCaptureSession) {
        console.log(`[${timestamp}] Screenshot saved to session folder`);
        fs.writeFileSync(
          path.join(currentCaptureSession.dir, 'screenshot.json'),
          JSON.stringify({ dataUrl: msg.dataUrl, timestamp: msg.timestamp }, null, 2)
        );
        console.log(`[${timestamp}] ✅ Capture All complete: ${path.basename(currentCaptureSession.dir)}`);
        currentCaptureSession = null;
      }
      // Also update the regular file
      writeDataFile('screenshot.json', {
        dataUrl: msg.dataUrl,
        timestamp: msg.timestamp
      });
      break;

    case 'dom_snapshot':
      console.log(`[${timestamp}] DOM snapshot received (${msg.html?.length || 0} chars)`);
      writeDataFile('dom-snapshot.json', {
        html: msg.html,
        url: msg.url,
        timestamp: msg.timestamp
      });
      break;

    case 'console':
      console.log(`[${timestamp}] Console [${msg.method}]:`, msg.args?.join(' '));
      appendToLogs({
        method: msg.method,
        args: msg.args,
        url: msg.url,
        timestamp: msg.timestamp
      });
      break;

    case 'screenshot':
      console.log(`[${timestamp}] Screenshot received`);
      writeDataFile('screenshot.json', {
        dataUrl: msg.dataUrl,
        timestamp: msg.timestamp
      });
      break;

    case 'event':
      console.log(`[${timestamp}] Event:`, msg.event);
      appendToEvents({
        ...msg.event,
        url: msg.url,
        timestamp: msg.timestamp
      });
      
      // Resolve pending command promise if this is a command result
      if (msg.event?.commandId && pendingCommands.has(msg.event.commandId)) {
        const { resolve, timer } = pendingCommands.get(msg.event.commandId);
        clearTimeout(timer);
        pendingCommands.delete(msg.event.commandId);
        resolve(msg.event);
      }
      break;

    case 'command_result':
      // Handle direct command results
      if (msg.commandId && pendingCommands.has(msg.commandId)) {
        const { resolve, timer } = pendingCommands.get(msg.commandId);
        clearTimeout(timer);
        pendingCommands.delete(msg.commandId);
        resolve({ success: msg.success, result: msg.result, error: msg.error });
      }
      break;

    default:
      console.log(`[${timestamp}] Unknown message type:`, msg.type);
  }
}

// Write data to JSON file
function writeDataFile(filename, data) {
  const filePath = path.join(DATA_DIR, filename);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// Append to console logs file
function appendToLogs(logEntry) {
  const filePath = path.join(DATA_DIR, 'console-logs.json');
  let data = { logs: [] };
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {}
  
  data.logs.push(logEntry);
  
  // Keep last 1000 logs
  if (data.logs.length > 1000) {
    data.logs = data.logs.slice(-1000);
  }
  
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// Append to events file
function appendToEvents(event) {
  const filePath = path.join(DATA_DIR, 'events.json');
  let data = { events: [] };
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {}
  
  data.events.push(event);
  
  // Keep last 500 events
  if (data.events.length > 500) {
    data.events = data.events.slice(-500);
  }
  
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ===== Automation Commands =====

function sendCommand(command) {
  if (wsClient && wsClient.readyState === 1) {
    wsClient.send(JSON.stringify({
      type: 'execute',
      ...command
    }));
    console.log(`📤 Sent command:`, command);
    return true;
  } else {
    console.log('⚠️  Cannot send command: Extension not connected');
    return false;
  }
}

function click(selector) {
  return sendCommand({ action: 'click', selector });
}

function type(selector, text) {
  return sendCommand({ action: 'type', selector, text });
}

function runJs(code) {
  return sendCommand({ action: 'run_js', code });
}

function navigate(url) {
  return sendCommand({ action: 'navigate', url });
}

function scrollTo(selector) {
  return sendCommand({ action: 'scroll_to', selector });
}

function requestDom() {
  if (wsClient && wsClient.readyState === 1) {
    wsClient.send(JSON.stringify({ type: 'request_dom' }));
    console.log('📤 Requested DOM snapshot');
    return true;
  }
  return false;
}

function requestScreenshot() {
  if (wsClient && wsClient.readyState === 1) {
    wsClient.send(JSON.stringify({ type: 'capture_screenshot' }));
    console.log('📤 Requested screenshot');
    return true;
  }
  return false;
}

function reloadExtension() {
  if (wsClient && wsClient.readyState === 1) {
    wsClient.send(JSON.stringify({ type: 'reload_extension' }));
    console.log('📤 Triggered extension reload');
    return true;
  }
  return false;
}

// Process commands from commands.json
function processPendingCommands() {
  try {
    const data = JSON.parse(fs.readFileSync(COMMANDS_FILE, 'utf8'));
    if (data.commands && data.commands.length > 0) {
      console.log(`📋 Processing ${data.commands.length} pending command(s)`);
      
      for (const cmd of data.commands) {
        sendCommand(cmd);
      }
      
      // Clear commands after processing
      fs.writeFileSync(COMMANDS_FILE, JSON.stringify({ commands: [] }, null, 2));
    }
  } catch (e) {
    // Ignore parse errors
  }
}

// ===== File Watchers =====

// Watch extension directory for changes (auto-reload)
const extensionWatcher = chokidar.watch(EXTENSION_DIR, {
  ignored: /(^|[\/\\])\../,
  persistent: true,
  ignoreInitial: true
});

extensionWatcher.on('change', (filePath) => {
  console.log(`📝 Extension file changed: ${path.basename(filePath)}`);
  reloadExtension();
});

extensionWatcher.on('add', (filePath) => {
  console.log(`📝 Extension file added: ${path.basename(filePath)}`);
  reloadExtension();
});

// Watch commands.json for new commands
const commandsWatcher = chokidar.watch(COMMANDS_FILE, {
  persistent: true,
  ignoreInitial: true
});

commandsWatcher.on('change', () => {
  console.log('📋 Commands file changed');
  processPendingCommands();
});

// ===== Graceful Shutdown =====

process.on('SIGINT', () => {
  console.log('\n👋 Shutting down...');
  wss.close();
  extensionWatcher.close();
  commandsWatcher.close();
  process.exit(0);
});

// Export functions for potential programmatic use
export {
  click,
  type,
  runJs,
  navigate,
  scrollTo,
  requestDom,
  requestScreenshot,
  reloadExtension
};
