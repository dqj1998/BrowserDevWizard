// Browser Dev Bridge - Content Script
// Runs in the context of web pages

(function() {
  // Avoid double injection
  if (window.__aiTestBridgeInjected) return;
  window.__aiTestBridgeInjected = true;

  console.log("[AI Bridge] Content script loaded");

  // ===== Console Capture =====
  // Intercept console methods to forward to background script
  ['log', 'error', 'warn', 'info', 'debug'].forEach(method => {
    const original = console[method];
    console[method] = (...args) => {
      // Send to background script
      try {
        chrome.runtime.sendMessage({
          type: "console",
          method,
          args: args.map(arg => {
            try {
              if (typeof arg === 'object') {
                return JSON.stringify(arg, null, 2);
              }
              return String(arg);
            } catch (e) {
              return '[Unserializable]';
            }
          })
        });
      } catch (e) {
        // Extension context may be invalidated
      }
      // Call original
      original.apply(console, args);
    };
  });

  // ===== JavaScript Execution Note =====
  // JavaScript execution (run_js) is now handled by the background script using
  // chrome.scripting.executeScript with world: 'MAIN', which bypasses CSP restrictions.
  // The executeJS function has been removed from content.js.

  // ===== Error Capture =====
  window.addEventListener('error', (event) => {
    try {
      chrome.runtime.sendMessage({
        type: "console",
        method: "error",
        args: [`Uncaught Error: ${event.message} at ${event.filename}:${event.lineno}:${event.colno}`]
      });
    } catch (e) {}
  });

  window.addEventListener('unhandledrejection', (event) => {
    try {
      chrome.runtime.sendMessage({
        type: "console",
        method: "error",
        args: [`Unhandled Promise Rejection: ${event.reason}`]
      });
    } catch (e) {}
  });

  // ===== Message Handler =====
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    console.log("[AI Bridge] Content received:", msg);

    // Get DOM snapshot
    if (msg.type === "get_dom") {
      const html = document.documentElement.outerHTML;
      chrome.runtime.sendMessage({
        type: "dom_snapshot",
        html,
        url: window.location.href,  // Include URL from content script's context
        captureAll: msg.captureAll || false,
        timestamp: msg.timestamp
      });
      sendResponse({ ok: true });
      return false; // Synchronous response
    }

    // Execute click
    if (msg.action === "click") {
      const el = document.querySelector(msg.selector);
      if (el) {
        el.click();
        try {
          chrome.runtime.sendMessage({
            type: "event",
            event: { action: "click", selector: msg.selector, success: true, commandId: msg.commandId }
          }, () => {
            if (chrome.runtime.lastError) {
              console.error("[AI Bridge] Failed to send click result:", chrome.runtime.lastError.message);
            }
          });
        } catch (e) {}
        sendResponse({ ok: true });
      } else {
        try {
          chrome.runtime.sendMessage({
            type: "event",
            event: { action: "click", selector: msg.selector, success: false, error: "Element not found", commandId: msg.commandId }
          }, () => {
            if (chrome.runtime.lastError) {
              console.error("[AI Bridge] Failed to send click error:", chrome.runtime.lastError.message);
            }
          });
        } catch (e) {}
        sendResponse({ ok: false, error: "Element not found" });
      }
      return false; // Synchronous response
    }

    // Execute type
    if (msg.action === "type") {
      const el = document.querySelector(msg.selector);
      if (el) {
        el.focus();
        
        // Handle both regular inputs and contenteditable elements
        if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') {
          // For contenteditable elements (like Gemini, ChatGPT)
          el.textContent = msg.text;
          // Also try innerText for some edge cases
          if (!el.textContent) {
            el.innerText = msg.text;
          }
        } else {
          // For regular input/textarea elements
          el.value = msg.text;
        }
        
        // Dispatch input event to trigger any listeners
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        // Also dispatch keyup for frameworks that listen to that
        el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
        
        try {
          chrome.runtime.sendMessage({
            type: "event",
            event: { action: "type", selector: msg.selector, text: msg.text, success: true, commandId: msg.commandId }
          }, () => {
            if (chrome.runtime.lastError) {
              console.error("[AI Bridge] Failed to send type result:", chrome.runtime.lastError.message);
            }
          });
        } catch (e) {}
        sendResponse({ ok: true });
      } else {
        try {
          chrome.runtime.sendMessage({
            type: "event",
            event: { action: "type", selector: msg.selector, success: false, error: "Element not found", commandId: msg.commandId }
          }, () => {
            if (chrome.runtime.lastError) {
              console.error("[AI Bridge] Failed to send type error:", chrome.runtime.lastError.message);
            }
          });
        } catch (e) {}
        sendResponse({ ok: false, error: "Element not found" });
      }
      return false; // Synchronous response
    }

    // Execute arbitrary JavaScript
    // Note: run_js is now primarily handled by background.js using chrome.scripting.executeScript
    // This is a fallback in case the message is sent directly to content script
    if (msg.action === "run_js") {
      console.log("[AI Bridge] run_js received in content script - this should be handled by background.js");
      // Redirect to background script would lose context, so just acknowledge
      sendResponse({ ok: false, error: "run_js should be handled by background script for CSP bypass" });
      return false;
    }

    // Navigate to URL
    if (msg.action === "navigate") {
      window.location.href = msg.url;
      sendResponse({ ok: true });
      return false;
    }

    // Scroll to element
    if (msg.action === "scroll_to") {
      const el = document.querySelector(msg.selector);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: "Element not found" });
      }
      return false;
    }

    // For unhandled message types, return false (sync)
    return false;
  });

})();
