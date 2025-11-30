// AI Test Bridge - Background Service Worker
// Maintains WebSocket connection to local AI server

let ws = null;
let isConnected = false;

// Connect to the AI test server
function connect() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    console.log("[AI Bridge] Already connected");
    return;
  }

  ws = new WebSocket("ws://localhost:8123");

  ws.onopen = () => {
    isConnected = true;
    console.log("[AI Bridge] Connected to AI server");
    ws.send(JSON.stringify({ type: "extension_ready", timestamp: Date.now() }));
  };

  ws.onclose = () => {
    isConnected = false;
    console.log("[AI Bridge] Disconnected from AI server");
    // Auto-reconnect after 3 seconds
    setTimeout(connect, 3000);
  };

  ws.onerror = (error) => {
    console.error("[AI Bridge] WebSocket error:", error);
  };

  ws.onmessage = async (evt) => {
    const msg = JSON.parse(evt.data);
    console.log("[AI Bridge] Received:", msg);

    // Reload extension command
    if (msg.type === "reload_extension") {
      console.log("[AI Bridge] Reloading extension...");
      chrome.runtime.reload();
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
        url: sender.tab?.url,
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
    sendResponse({ connected: isConnected });
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

// Auto-connect on startup
connect();
