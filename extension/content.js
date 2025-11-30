// AI Test Bridge - Content Script
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
        captureAll: msg.captureAll || false,
        timestamp: msg.timestamp
      });
      sendResponse({ ok: true });
    }

    // Execute click
    if (msg.action === "click") {
      const el = document.querySelector(msg.selector);
      if (el) {
        el.click();
        chrome.runtime.sendMessage({
          type: "event",
          event: { action: "click", selector: msg.selector, success: true, commandId: msg.commandId }
        });
        sendResponse({ ok: true });
      } else {
        chrome.runtime.sendMessage({
          type: "event",
          event: { action: "click", selector: msg.selector, success: false, error: "Element not found", commandId: msg.commandId }
        });
        sendResponse({ ok: false, error: "Element not found" });
      }
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
        
        chrome.runtime.sendMessage({
          type: "event",
          event: { action: "type", selector: msg.selector, text: msg.text, success: true, commandId: msg.commandId }
        });
        sendResponse({ ok: true });
      } else {
        chrome.runtime.sendMessage({
          type: "event",
          event: { action: "type", selector: msg.selector, success: false, error: "Element not found", commandId: msg.commandId }
        });
        sendResponse({ ok: false, error: "Element not found" });
      }
    }

    // Execute arbitrary JavaScript
    if (msg.action === "run_js") {
      try {
        const result = eval(msg.code);
        chrome.runtime.sendMessage({
          type: "event",
          event: { action: "run_js", code: msg.code, success: true, result: String(result), commandId: msg.commandId }
        });
        sendResponse({ ok: true, result });
      } catch (e) {
        chrome.runtime.sendMessage({
          type: "event",
          event: { action: "run_js", code: msg.code, success: false, error: e.message, commandId: msg.commandId }
        });
        sendResponse({ ok: false, error: e.message });
      }
    }

    // Navigate to URL
    if (msg.action === "navigate") {
      window.location.href = msg.url;
      sendResponse({ ok: true });
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
    }

    return true;
  });

})();
