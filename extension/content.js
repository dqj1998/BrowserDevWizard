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

  // ===== JavaScript Execution with CSP Fallbacks =====
  // Execute JavaScript code with multiple fallback strategies for CSP-restricted pages
  async function executeJS(code, commandId) {
    // Strategy 1: Try Function constructor (works in most cases, bypasses eval restrictions)
    try {
      const fn = new Function('return (' + code + ')');
      const result = fn();
      return result;
    } catch (e1) {
      // If Function constructor fails (due to CSP), try fallback strategies
      console.log('[AI Bridge] Function constructor failed, trying script injection:', e1.message);
    }

    // Strategy 2: Script element injection (works if 'unsafe-inline' is allowed or no script-src)
    try {
      return await new Promise((resolve, reject) => {
        const resultKey = '__aibridge_result_' + commandId;
        const errorKey = '__aibridge_error_' + commandId;
        
        const script = document.createElement('script');
        script.textContent = `
          try {
            window['${resultKey}'] = (function() { return (${code}); })();
          } catch (e) {
            window['${errorKey}'] = e.message;
          }
        `;
        document.documentElement.appendChild(script);
        script.remove();
        
        // Check for result or error
        if (window[errorKey]) {
          const error = window[errorKey];
          delete window[resultKey];
          delete window[errorKey];
          reject(new Error(error));
        } else {
          const result = window[resultKey];
          delete window[resultKey];
          delete window[errorKey];
          resolve(result);
        }
      });
    } catch (e2) {
      console.log('[AI Bridge] Script injection failed, trying external blob:', e2.message);
    }

    // Strategy 3: Blob URL script (works if blob: is allowed in script-src)
    try {
      return await new Promise((resolve, reject) => {
        const resultKey = '__aibridge_result_' + commandId;
        const errorKey = '__aibridge_error_' + commandId;
        
        const blob = new Blob([`
          try {
            window['${resultKey}'] = (function() { return (${code}); })();
          } catch (e) {
            window['${errorKey}'] = e.message;
          }
        `], { type: 'application/javascript' });
        
        const url = URL.createObjectURL(blob);
        const script = document.createElement('script');
        script.src = url;
        
        script.onload = () => {
          URL.revokeObjectURL(url);
          script.remove();
          
          if (window[errorKey]) {
            const error = window[errorKey];
            delete window[resultKey];
            delete window[errorKey];
            reject(new Error(error));
          } else {
            const result = window[resultKey];
            delete window[resultKey];
            delete window[errorKey];
            resolve(result);
          }
        };
        
        script.onerror = () => {
          URL.revokeObjectURL(url);
          script.remove();
          reject(new Error('Blob script injection blocked by CSP'));
        };
        
        document.documentElement.appendChild(script);
      });
    } catch (e3) {
      // All strategies failed - CSP is too restrictive
      throw new Error(`CSP blocks JavaScript execution. Tried: Function constructor, inline script, blob script. Page CSP is too restrictive. Error: ${e3.message}`);
    }
  }

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
    // Uses multiple fallback strategies to handle CSP restrictions
    if (msg.action === "run_js") {
      executeJS(msg.code, msg.commandId).then(result => {
        chrome.runtime.sendMessage({
          type: "event",
          event: { action: "run_js", code: msg.code, success: true, result: String(result), commandId: msg.commandId }
        });
        sendResponse({ ok: true, result });
      }).catch(e => {
        chrome.runtime.sendMessage({
          type: "event",
          event: { action: "run_js", code: msg.code, success: false, error: e.message, commandId: msg.commandId }
        });
        sendResponse({ ok: false, error: e.message });
      });
      return true; // Keep message channel open for async response
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
