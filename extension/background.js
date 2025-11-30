// Browser Dev Bridge - Background Service Worker
// Maintains WebSocket connection to local AI server

let ws = null;
let isConnected = false;
let heartbeatInterval = null;
let reconnectTimeout = null;
let keepAliveInterval = null;

// Heartbeat configuration
const HEARTBEAT_INTERVAL = 15000; // Send heartbeat every 15 seconds
const RECONNECT_DELAY = 3000;     // Reconnect after 3 seconds
const KEEPALIVE_INTERVAL = 20000; // Keep service worker alive every 20 seconds

// Update icon badge to show connection status
function updateConnectionBadge(connected) {
  if (connected) {
    // Green dot for connected
    chrome.action.setBadgeText({ text: "●" });
    chrome.action.setBadgeBackgroundColor({ color: "#4CAF50" });
    chrome.action.setTitle({ title: "BrowserDevBridge - Connected" });
  } else {
    // Red dot for disconnected
    chrome.action.setBadgeText({ text: "●" });
    chrome.action.setBadgeBackgroundColor({ color: "#F44336" });
    chrome.action.setTitle({ title: "BrowserDevBridge - Disconnected" });
  }
}

// Start heartbeat to keep connection alive
function startHeartbeat() {
  stopHeartbeat();
  heartbeatInterval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      } catch (e) {
        console.error('[AI Bridge] Failed to send heartbeat:', e);
      }
    }
  }, HEARTBEAT_INTERVAL);
}

function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

// Keep service worker alive (Manifest V3 workaround)
function startKeepAlive() {
  stopKeepAlive();
  keepAliveInterval = setInterval(() => {
    // Simple operation to keep service worker active
    chrome.runtime.getPlatformInfo(() => {});
  }, KEEPALIVE_INTERVAL);
}

function stopKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

// Schedule reconnection
function scheduleReconnect() {
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
  }
  reconnectTimeout = setTimeout(() => {
    reconnectTimeout = null;
    connect();
  }, RECONNECT_DELAY);
}

// Connect to the AI test server
function connect() {
  // Clear any pending reconnect
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  
  // Close existing connection if any
  if (ws) {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      console.log("[AI Bridge] Closing existing connection");
      ws.close();
    }
    ws = null;
  }

  console.log("[AI Bridge] Connecting to AI server...");
  
  try {
    ws = new WebSocket("ws://localhost:8123");
  } catch (e) {
    console.error("[AI Bridge] Failed to create WebSocket:", e);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    isConnected = true;
    updateConnectionBadge(true);
    console.log("[AI Bridge] Connected to AI server");
    ws.send(JSON.stringify({ type: "extension_ready", timestamp: Date.now() }));
    
    // Start heartbeat to keep connection alive
    startHeartbeat();
    startKeepAlive();
  };

  ws.onclose = (event) => {
    isConnected = false;
    updateConnectionBadge(false);
    stopHeartbeat();
    console.log("[AI Bridge] Disconnected from AI server (code:", event.code, ")");
    
    // Auto-reconnect
    scheduleReconnect();
  };

  ws.onerror = (error) => {
    console.error("[AI Bridge] WebSocket error:", error);
  };

  ws.onmessage = async (evt) => {
    const msg = JSON.parse(evt.data);
    
    // Handle ping silently (heartbeat)
    if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      return;
    }
    
    console.log("[AI Bridge] Received:", msg);

    // Reload extension command
    if (msg.type === "reload_extension") {
      console.log("[AI Bridge] Reloading extension...");
      chrome.runtime.reload();
    }

    // Navigate to URL using Chrome tabs API
    if (msg.type === "navigate" || msg.action === "navigate") {
      const url = msg.url;
      const commandId = msg.commandId;
      console.log("[AI Bridge] Navigating to:", url);
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab) {
          await chrome.tabs.update(tab.id, { url });
          // Wait for page to load
          chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
            if (tabId === tab.id && info.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(listener);
              ws.send(JSON.stringify({
                type: "command_result",
                commandId,
                success: true,
                result: { url, action: "navigate" }
              }));
            }
          });
        }
      } catch (error) {
        ws.send(JSON.stringify({
          type: "command_result",
          commandId,
          success: false,
          error: error.message
        }));
      }
    }

    // Get current tab info
    if (msg.type === "get_tab_info") {
      const commandId = msg.commandId;
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        ws.send(JSON.stringify({
          type: "command_result",
          commandId,
          success: true,
          result: { url: tab?.url, title: tab?.title, id: tab?.id }
        }));
      } catch (error) {
        ws.send(JSON.stringify({
          type: "command_result",
          commandId,
          success: false,
          error: error.message
        }));
      }
    }

    // Execute command in content script
    if (msg.type === "execute") {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        chrome.tabs.sendMessage(tab.id, msg);
      }
    }

    // Capture screenshot
    if (msg.type === "capture_screenshot") {
      captureScreenshot();
    }

    // Request DOM snapshot
    if (msg.type === "request_dom") {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        chrome.tabs.sendMessage(tab.id, { type: "get_dom" });
      }
    }
  };
}

// Capture visible tab screenshot
function captureScreenshot() {
  chrome.tabs.captureVisibleTab(null, { format: "png" }, (dataUrl) => {
    if (chrome.runtime.lastError) {
      console.error("[AI Bridge] Screenshot error:", chrome.runtime.lastError);
      return;
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ 
        type: "screenshot", 
        dataUrl,
        timestamp: Date.now()
      }));
    }
  });
}

// Capture All - DOM + Screenshot + Console logs to timestamped folder
async function captureAll() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.error("[AI Bridge] Not connected to server");
    return;
  }

  const timestamp = Date.now();
  
  // Signal server to start a new capture session
  ws.send(JSON.stringify({ type: "capture_all_start", timestamp }));

  // Get active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  
  // Request DOM from content script
  if (tab && tab.id) {
    try {
      // Try sending to content script first
      chrome.tabs.sendMessage(tab.id, { type: "get_dom", captureAll: true, timestamp }, (response) => {
        if (chrome.runtime.lastError) {
          console.log("[AI Bridge] Content script not available, injecting script to get DOM");
          // Fallback: inject script directly to capture DOM
          chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => document.documentElement.outerHTML
          }).then((results) => {
            if (results && results[0] && results[0].result) {
              ws.send(JSON.stringify({
                type: "dom_snapshot_all",
                html: results[0].result,
                url: tab.url,
                timestamp
              }));
            }
          }).catch(err => {
            console.error("[AI Bridge] Failed to get DOM:", err);
          });
        }
      });
    } catch (err) {
      console.error("[AI Bridge] Error requesting DOM:", err);
    }
  }

  // Capture screenshot
  chrome.tabs.captureVisibleTab(null, { format: "png" }, (dataUrl) => {
    if (chrome.runtime.lastError) {
      console.error("[AI Bridge] Screenshot error:", chrome.runtime.lastError);
      return;
    }
    ws.send(JSON.stringify({ 
      type: "screenshot_all", 
      dataUrl,
      timestamp
    }));
  });
}

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Forward console logs to server
  if (msg.type === "console") {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "console",
        method: msg.method,
        args: msg.args,
        url: sender.tab?.url,
        timestamp: Date.now()
      }));
    }
  }

  // Forward DOM snapshot to server
  if (msg.type === "dom_snapshot") {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: msg.captureAll ? "dom_snapshot_all" : "dom_snapshot",
        html: msg.html,
        url: msg.url || sender.tab?.url,  // Prefer URL from message, fallback to sender.tab
        timestamp: msg.timestamp || Date.now()
      }));
    }
  }

  // Forward events to server
  if (msg.type === "event") {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "event",
        event: msg.event,
        url: sender.tab?.url,
        timestamp: Date.now()
      }));
    }
  }

  // Handle popup requests
  if (msg.type === "get_status") {
    // Check actual WebSocket state, not just the isConnected variable
    const actuallyConnected = ws && ws.readyState === WebSocket.OPEN;
    // Sync the variable if it's out of sync
    if (isConnected !== actuallyConnected) {
      isConnected = actuallyConnected;
      updateConnectionBadge(isConnected);
    }
    sendResponse({ connected: actuallyConnected });
  }

  if (msg.type === "connect") {
    connect();
    sendResponse({ ok: true });
  }

  if (msg.type === "capture_screenshot") {
    captureScreenshot();
    sendResponse({ ok: true });
  }

  if (msg.type === "capture_all") {
    captureAll();
    sendResponse({ ok: true });
  }

  if (msg.type === "request_dom") {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (tab) {
        chrome.tabs.sendMessage(tab.id, { type: "get_dom" });
      }
    });
    sendResponse({ ok: true });
  }

  return true; // Keep message channel open for async responses
});

// Initialize badge to disconnected state
updateConnectionBadge(false);

// Auto-connect on startup
connect();
