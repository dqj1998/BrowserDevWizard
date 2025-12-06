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
  
  // Notify popup about connection status change
  chrome.runtime.sendMessage({ type: 'connection_status_changed', connected }).catch(() => {
    // Ignore errors when popup is not open
  });
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

    // Execute JavaScript directly using chrome.scripting API (bypasses CSP)
    if (msg.type === "execute" && msg.action === "run_js") {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.id) {
        // Check if it's a restricted URL
        if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('edge://') || 
            tab.url.startsWith('about:') || tab.url.startsWith('chrome-extension://') ||
            tab.url.startsWith('moz-extension://') || tab.url.startsWith('extension://'))) {
          ws.send(JSON.stringify({
            type: "event",
            event: {
              action: "run_js",
              commandId: msg.commandId,
              success: false,
              error: `Cannot execute on restricted page: ${tab.url}. Navigate to a regular web page first.`
            },
            url: tab.url,
            timestamp: Date.now()
          }));
          return;
        }

        try {
          // Use chrome.scripting.executeScript to execute JavaScript
          const code = msg.code;
          
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'MAIN',  // Execute in page's main world for full access
            func: (codeToRun) => {
              // Helper to format result
              const formatResult = (result) => {
                if (result === undefined) {
                  return { success: true, result: 'undefined', wasUndefined: true };
                } else if (result === null) {
                  return { success: true, result: 'null' };
                } else if (typeof result === 'object') {
                  try {
                    return { success: true, result: JSON.stringify(result, null, 2) };
                  } catch (e) {
                    return { success: true, result: String(result) };
                  }
                } else {
                  return { success: true, result: String(result) };
                }
              };

              const errors = [];

              // Strategy 1: Try indirect eval first (works on most sites without strict CSP)
              try {
                const indirectEval = (0, eval);
                const result = indirectEval('(' + codeToRun + ')');
                return formatResult(result);
              } catch (evalError) {
                errors.push('eval: ' + evalError.message);
              }

              // Strategy 2: Try Function constructor
              try {
                const fn = new Function('return (' + codeToRun + ')');
                const result = fn();
                return formatResult(result);
              } catch (fnError) {
                errors.push('Function: ' + fnError.message);
              }

              // Strategy 3: Script element with Trusted Types (if available)
              const resultKey = '__bdb_r_' + Math.random().toString(36).slice(2);
              const errorKey = '__bdb_e_' + Math.random().toString(36).slice(2);
              const scriptCode = `
                try {
                  window['${resultKey}'] = (function() { return (${codeToRun}); })();
                } catch (e) {
                  window['${errorKey}'] = e.message;
                }
              `;
              
              if (window.trustedTypes) {
                try {
                  // Create a unique policy (each call needs unique name)
                  const policyName = 'bdb_' + Math.random().toString(36).slice(2);
                  const policy = window.trustedTypes.createPolicy(policyName, {
                    createScript: (s) => s
                  });
                  
                  // Simpler approach: wrap in try-catch and set result directly
                  const wrappedCode = `
                    (function() {
                      try {
                        var __result = (${codeToRun});
                        window['${resultKey}'] = __result;
                      } catch (e) {
                        window['${errorKey}'] = e.message;
                      }
                    })();
                  `;
                  
                  const script = document.createElement('script');
                  script.text = policy.createScript(wrappedCode);
                  
                  // Try appending to head first, then documentElement
                  (document.head || document.documentElement).appendChild(script);
                  script.remove();
                  
                  // Check for error first
                  const hasError = Object.prototype.hasOwnProperty.call(window, errorKey);
                  const hasResult = Object.prototype.hasOwnProperty.call(window, resultKey);
                  
                  if (hasError) {
                    const error = window[errorKey];
                    try { delete window[resultKey]; } catch(e) {}
                    try { delete window[errorKey]; } catch(e) {}
                    return { success: false, error: error };
                  }
                  
                  if (hasResult) {
                    const result = window[resultKey];
                    try { delete window[resultKey]; } catch(e) {}
                    try { delete window[errorKey]; } catch(e) {}
                    return formatResult(result);
                  }
                  
                  errors.push('TrustedTypes: policy created but script did not set result (CSP may block script execution)');
                } catch (ttError) {
                  errors.push('TrustedTypes: ' + ttError.message);
                }
              }
              
              // Strategy 4: Plain inline script (for sites without Trusted Types)
              try {
                const script = document.createElement('script');
                script.textContent = scriptCode;
                document.documentElement.appendChild(script);
                script.remove();
                
                if (window[errorKey]) {
                  const error = window[errorKey];
                  delete window[resultKey];
                  delete window[errorKey];
                  return { success: false, error: error };
                }
                
                const result = window[resultKey];
                const wasSet = resultKey in window || result !== undefined;
                delete window[resultKey];
                delete window[errorKey];
                
                if (wasSet) {
                  return formatResult(result);
                }
                errors.push('inline: script did not execute (CSP blocked)');
              } catch (inlineError) {
                errors.push('inline: ' + inlineError.message);
              }
              
              return { 
                success: false, 
                error: 'All methods blocked by strict CSP: ' + errors.join('; ') + '. This site has very strict security policies. Try using usePlaywright:true for DOM access, or use get_state to read the page content.',
                cspBlocked: true
              };
            },
            args: [code]
          });

          const result = results[0]?.result;
          if (result?.success) {
            ws.send(JSON.stringify({
              type: "event",
              event: {
                action: "run_js",
                code: code,
                success: true,
                result: result.result,
                commandId: msg.commandId
              },
              url: tab.url,
              timestamp: Date.now()
            }));
          } else {
            ws.send(JSON.stringify({
              type: "event",
              event: {
                action: "run_js",
                code: code,
                success: false,
                error: result?.error || 'Unknown error',
                commandId: msg.commandId
              },
              url: tab.url,
              timestamp: Date.now()
            }));
          }
        } catch (error) {
          console.error("[AI Bridge] Error executing JS:", error);
          ws.send(JSON.stringify({
            type: "event",
            event: {
              action: "run_js",
              commandId: msg.commandId,
              success: false,
              error: error.message
            },
            url: tab.url,
            timestamp: Date.now()
          }));
        }
      } else {
        ws.send(JSON.stringify({
          type: "event",
          event: {
            action: "run_js",
            commandId: msg.commandId,
            success: false,
            error: "No active tab found"
          },
          timestamp: Date.now()
        }));
      }
      return; // Don't fall through to the generic execute handler
    }

    // Execute command in content script (for non-JS actions like click, input, etc.)
    if (msg.type === "execute") {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.id) {
        // Check if it's a restricted URL
        if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('edge://') || 
            tab.url.startsWith('about:') || tab.url.startsWith('chrome-extension://') ||
            tab.url.startsWith('moz-extension://') || tab.url.startsWith('extension://'))) {
          ws.send(JSON.stringify({
            type: "event",
            event: {
              action: msg.action,
              commandId: msg.commandId,
              success: false,
              error: `Cannot execute on restricted page: ${tab.url}. Navigate to a regular web page first.`
            },
            url: tab.url,
            timestamp: Date.now()
          }));
          return;
        }

        try {
          // Try to send message to content script
          chrome.tabs.sendMessage(tab.id, msg, async (response) => {
            if (chrome.runtime.lastError) {
              console.log("[AI Bridge] Content script not available, attempting to inject...");
              
              // Try to inject content script
              try {
                await chrome.scripting.executeScript({
                  target: { tabId: tab.id },
                  files: ['content.js']
                });
                console.log("[AI Bridge] Content script injected successfully");
                
                // Wait a moment for the script to initialize
                await new Promise(resolve => setTimeout(resolve, 100));
                
                // Retry the message
                chrome.tabs.sendMessage(tab.id, msg, (retryResponse) => {
                  if (chrome.runtime.lastError) {
                    console.error("[AI Bridge] Still failed after injection:", chrome.runtime.lastError.message);
                    ws.send(JSON.stringify({
                      type: "event",
                      event: {
                        action: msg.action,
                        commandId: msg.commandId,
                        success: false,
                        error: `Content script error after injection attempt: ${chrome.runtime.lastError.message}`
                      },
                      url: tab.url,
                      timestamp: Date.now()
                    }));
                  }
                });
              } catch (injectError) {
                console.error("[AI Bridge] Failed to inject content script:", injectError);
                ws.send(JSON.stringify({
                  type: "event",
                  event: {
                    action: msg.action,
                    commandId: msg.commandId,
                    success: false,
                    error: `Failed to inject content script: ${injectError.message}. Make sure you are on a regular web page.`
                  },
                  url: tab.url,
                  timestamp: Date.now()
                }));
              }
            }
          });
        } catch (error) {
          console.error("[AI Bridge] Error executing command:", error);
          ws.send(JSON.stringify({
            type: "event",
            event: {
              action: msg.action,
              commandId: msg.commandId,
              success: false,
              error: error.message
            },
            url: tab?.url,
            timestamp: Date.now()
          }));
        }
      } else {
        // No active tab found
        ws.send(JSON.stringify({
          type: "event",
          event: {
            action: msg.action,
            commandId: msg.commandId,
            success: false,
            error: "No active tab found"
          },
          timestamp: Date.now()
        }));
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
    chrome.tabs.query({ active: true, currentWindow: true }, async ([tab]) => {
      if (tab) {
        chrome.tabs.sendMessage(tab.id, { type: "get_dom" }, async (response) => {
          if (chrome.runtime.lastError) {
            console.log("[AI Bridge] Content script not available for DOM request, injecting...");
            try {
              await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['content.js']
              });
              await new Promise(resolve => setTimeout(resolve, 100));
              chrome.tabs.sendMessage(tab.id, { type: "get_dom" });
            } catch (err) {
              console.error("[AI Bridge] Failed to inject for DOM request:", err);
            }
          }
        });
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
