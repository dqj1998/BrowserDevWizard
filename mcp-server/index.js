#!/usr/bin/env node

// MCP Server for Browser Debug Automation
// Provides tools for AI to control browser, capture state, and analyze diffs

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getBrowserManager } from './browser.js';
import { compareSessions, extractErrors, formatDiffForAI } from './diff-utils.js';

const DEBUG_SERVER_URL = process.env.DEBUG_SERVER_URL || 'http://localhost:8124';

// Helper to call debug-server HTTP API
async function callDebugServer(endpoint, options = {}) {
  const url = `${DEBUG_SERVER_URL}${endpoint}`;
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      }
    });
    return await response.json();
  } catch (error) {
    return { error: error.message };
  }
}

// Create MCP server
const server = new McpServer({
  name: 'browser-debug',
  version: '1.0.0',
  description: 'Browser automation and debugging tools for AI-driven testing'
});

// ===== TOOLS =====

// Tool: get_browser_status
server.tool(
  'get_browser_status',
  'Check if a browser is connected via the extension.',
  {},
  async () => {
    try {
      const status = await callDebugServer('/status');
      
      if (status.connected) {
        const tabInfo = await callDebugServer('/tab');
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              connected: true,
              currentUrl: tabInfo.url || 'unknown',
              currentTitle: tabInfo.title || 'unknown',
              message: 'Browser connected via extension. Ready for commands.'
            }, null, 2)
          }]
        };
      } else {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              connected: false,
              message: 'No browser connected. Either:\n1. Use connect_browser to wait for an existing Chrome with the extension\n2. Use launch_browser to start a new browser with Playwright'
            }, null, 2)
          }]
        };
      }
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ connected: false, error: error.message }, null, 2)
        }]
      };
    }
  }
);

// Tool: connect_browser
server.tool(
  'connect_browser',
  'Wait for an existing Chrome browser with the extension to connect. Use this when you want to control a browser you opened manually (with all your logins). Start Chrome normally with the extension installed, then call this tool.',
  {
    timeout: z.number().optional().describe('Timeout in seconds to wait for connection (default: 30)')
  },
  async ({ timeout = 30 }) => {
    try {
      const startTime = Date.now();
      const timeoutMs = timeout * 1000;
      
      // Poll for connection
      while (Date.now() - startTime < timeoutMs) {
        const status = await callDebugServer('/status');
        if (status.connected) {
          // Get current tab info
          const tabInfo = await callDebugServer('/tab');
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: true,
                connected: true,
                currentUrl: tabInfo.url || 'unknown',
                currentTitle: tabInfo.title || 'unknown',
                message: 'Connected to existing Chrome browser via extension. You can now use navigate, execute_action, and capture_state tools.'
              }, null, 2)
            }]
          };
        }
        // Wait 1 second before checking again
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            connected: false,
            message: 'Timeout waiting for browser connection. Please ensure:\n1. Chrome is open\n2. The BrowserDevWizard extension is installed and enabled\n3. The debug-server is running (npm run debug-server)'
          }, null, 2)
        }],
        isError: true
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: false, error: error.message }, null, 2)
        }],
        isError: true
      };
    }
  }
);

// Tool: launch_browser
server.tool(
  'launch_browser',
  'Launch Chrome browser with the debug extension loaded. Optionally navigate to a URL. By default uses existing Chrome session with your logins.',
  {
    url: z.string().optional().describe('Initial URL to navigate to after launch'),
    width: z.number().optional().describe('Viewport width (default: 1280)'),
    height: z.number().optional().describe('Viewport height (default: 720)'),
    useExistingSession: z.boolean().optional().describe('Use existing Chrome session with saved logins (default: true). Set to false for a fresh session.'),
    userDataDir: z.string().optional().describe('Custom Chrome user data directory path. Uses default Chrome profile location if not specified.'),
    profileName: z.string().optional().describe('Chrome profile name to use (default: "Default"). Use for different Chrome profiles.')
  },
  async ({ url, width, height, useExistingSession, userDataDir, profileName }) => {
    const browser = getBrowserManager();
    
    try {
      const result = await browser.launch({ url, width, height, useExistingSession, userDataDir, profileName });
      
      // Wait for extension to connect
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Check debug-server connection
      const status = await callDebugServer('/status');
      
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            browserLaunched: true,
            extensionConnected: status.connected || false,
            currentUrl: result.url,
            message: status.connected 
              ? 'Browser launched and extension connected successfully'
              : 'Browser launched but extension not yet connected. Try navigating to a page.'
          }, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: false, error: error.message }, null, 2)
        }],
        isError: true
      };
    }
  }
);

// Tool: navigate
server.tool(
  'navigate',
  'Navigate to a URL in the browser. Uses the extension connection by default, falls back to Playwright if extension not connected.',
  {
    url: z.string().describe('URL to navigate to'),
    waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).optional()
      .describe('When to consider navigation complete (default: domcontentloaded)'),
    usePlaywright: z.boolean().optional().describe('Force using Playwright instead of extension (default: false)')
  },
  async ({ url, waitUntil, usePlaywright = false }) => {
    try {
      // First try using the extension (works with existing browser)
      if (!usePlaywright) {
        const status = await callDebugServer('/status');
        if (status.connected) {
          const result = await callDebugServer('/navigate', {
            method: 'POST',
            body: JSON.stringify({ url })
          });
          
          if (result.success) {
            // Wait for page to stabilize then request fresh DOM
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Trigger a fresh DOM capture to update the cache
            await callDebugServer('/refresh-dom', {
              method: 'POST',
              body: JSON.stringify({ timeout: 5000 })
            });
            
            // Get tab info after navigation
            const tabInfo = await callDebugServer('/tab');
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  url: tabInfo.url || url,
                  title: tabInfo.title || '',
                  method: 'extension'
                }, null, 2)
              }]
            };
          }
        }
      }
      
      // Fall back to Playwright
      const browser = getBrowserManager();
      const result = await browser.navigate(url, { waitUntil });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            url: result.url,
            title: result.title,
            method: 'playwright'
          }, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: false, error: error.message }, null, 2)
        }],
        isError: true
      };
    }
  }
);

// Tool: capture_state
server.tool(
  'capture_state',
  'Capture current browser state: DOM, screenshot, console logs, and events. Saves to a timestamped session folder.',
  {
    name: z.string().optional().describe('Optional name for this capture session (auto-generated if not provided)')
  },
  async ({ name }) => {
    try {
      const result = await callDebugServer('/capture', {
        method: 'POST',
        body: JSON.stringify({ name })
      });
      
      if (result.error) {
        throw new Error(result.error);
      }
      
      // Return summary without full data
      const session = result.session;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            sessionName: session.name,
            captured: {
              dom: !!session.dom_snapshot?.html,
              domLength: session.dom_snapshot?.html?.length || 0,
              screenshot: !!session.screenshot?.dataUrl,
              consoleEntries: session.console_logs?.logs?.length || 0,
              events: session.events?.events?.length || 0
            },
            url: session.dom_snapshot?.url,
            consoleErrors: (session.console_logs?.logs || [])
              .filter(l => l.method === 'error')
              .map(e => e.args?.join(' ').slice(0, 100))
          }, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: false, error: error.message }, null, 2)
        }],
        isError: true
      };
    }
  }
);

// Tool: execute_action
server.tool(
  'execute_action',
  'Execute an action in the browser: click, type, run JavaScript, or scroll to element.',
  {
    action: z.enum(['click', 'type', 'run_js', 'scroll_to']).describe('Action to perform'),
    selector: z.string().optional().describe('CSS selector for click/type/scroll_to'),
    text: z.string().optional().describe('Text to type (for type action)'),
    code: z.string().optional().describe('JavaScript code to execute (for run_js action)'),
    timeout: z.number().optional().describe('Timeout in ms (default: 5000)'),
    usePlaywright: z.boolean().optional().describe('Use Playwright directly instead of extension (bypasses CSP, requires launch_browser first)')
  },
  async ({ action, selector, text, code, timeout, usePlaywright }) => {
    try {
      // Use Playwright directly if requested
      if (usePlaywright) {
        const browser = getBrowserManager();
        let result;
        
        if (action === 'click') {
          result = await browser.click(selector, timeout || 5000);
        } else if (action === 'type') {
          result = await browser.type(selector, text, timeout || 5000);
        } else if (action === 'run_js') {
          // Use Playwright's evaluate which bypasses CSP
          result = await browser.evaluate(code);
        } else {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ success: false, error: `Action '${action}' not supported with usePlaywright` }, null, 2)
            }],
            isError: true
          };
        }
        
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ success: result.success, result, commandId: 'playwright' }, null, 2)
          }],
          isError: !result.success
        };
      }
      
      // Otherwise use extension via debug server
      const result = await callDebugServer('/execute', {
        method: 'POST',
        body: JSON.stringify({ action, selector, text, code, timeout })
      });
      
      // If CSP blocked and it's run_js, suggest using Playwright
      if (!result.success && result.result?.cspBlocked) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              ...result,
              suggestion: 'This site has strict CSP. Use usePlaywright:true with launch_browser, or use get_state to read page content without JS execution.'
            }, null, 2)
          }],
          isError: true
        };
      }
      
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }],
        isError: !result.success
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: false, error: error.message }, null, 2)
        }],
        isError: true
      };
    }
  }
);

// Tool: get_state
server.tool(
  'get_state',
  'Get current browser state. By default requests fresh data from the browser. Returns DOM, console logs, and events.',
  {
    includeScreenshot: z.boolean().optional().describe('Include screenshot data (can be large)'),
    fresh: z.boolean().optional().describe('Request fresh state from browser (default: true). Set to false to use cached data.')
  },
  async ({ includeScreenshot, fresh = true }) => {
    try {
      let state;
      
      // Request fresh state from browser if requested
      if (fresh) {
        const refreshResult = await callDebugServer('/refresh-dom', {
          method: 'POST',
          body: JSON.stringify({ timeout: 5000 })
        });
        
        if (refreshResult.error && !refreshResult.error.includes('Timeout')) {
          // If refresh fails (not just timeout), fall back to cached
          console.error('Failed to refresh DOM, using cached:', refreshResult.error);
        }
      }
      
      state = await callDebugServer('/state');
      
      if (state.error) {
        throw new Error(state.error);
      }
      
      // Return summary
      const result = {
        url: state.dom?.url,
        domLength: state.dom?.html?.length || 0,
        consoleEntries: state.console?.logs?.length || 0,
        events: state.events?.events?.length || 0,
        consoleErrors: (state.console?.logs || [])
          .filter(l => l.method === 'error')
          .map(e => ({ message: e.args?.join(' ').slice(0, 200), timestamp: e.timestamp })),
        recentEvents: (state.events?.events || []).slice(-5)
      };
      
      if (includeScreenshot && state.screenshot?.dataUrl) {
        result.screenshot = state.screenshot.dataUrl;
      }
      
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: false, error: error.message }, null, 2)
        }],
        isError: true
      };
    }
  }
);

// Tool: list_sessions
server.tool(
  'list_sessions',
  'List all captured sessions (timestamped folders with DOM, screenshot, logs).',
  {},
  async () => {
    try {
      const result = await callDebugServer('/sessions');
      
      if (result.error) {
        throw new Error(result.error);
      }
      
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            count: result.sessions.length,
            sessions: result.sessions.map(s => ({
              name: s.name,
              files: s.files
            }))
          }, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: false, error: error.message }, null, 2)
        }],
        isError: true
      };
    }
  }
);

// Tool: compare_states
server.tool(
  'compare_states',
  'Compare two capture sessions and identify changes, errors, and issues.',
  {
    session1: z.string().describe('Name of first session (before)'),
    session2: z.string().describe('Name of second session (after)')
  },
  async ({ session1, session2 }) => {
    try {
      // Get both sessions
      const data1 = await callDebugServer(`/session/${session1}`);
      const data2 = await callDebugServer(`/session/${session2}`);
      
      if (data1.error) throw new Error(`Session 1: ${data1.error}`);
      if (data2.error) throw new Error(`Session 2: ${data2.error}`);
      
      // Compare
      const diff = compareSessions(data1, data2);
      const formatted = formatDiffForAI(diff);
      
      return {
        content: [{
          type: 'text',
          text: formatted
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: false, error: error.message }, null, 2)
        }],
        isError: true
      };
    }
  }
);

// Tool: get_errors
server.tool(
  'get_errors',
  'Get all console errors from current state or a specific session.',
  {
    session: z.string().optional().describe('Session name (uses current state if not provided)')
  },
  async ({ session }) => {
    try {
      let consoleLogs;
      
      if (session) {
        const data = await callDebugServer(`/session/${session}`);
        if (data.error) throw new Error(data.error);
        consoleLogs = data.console_logs;
      } else {
        const state = await callDebugServer('/state');
        if (state.error) throw new Error(state.error);
        consoleLogs = state.console;
      }
      
      const errors = extractErrors(consoleLogs);
      
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            errorCount: errors.length,
            errors: errors.map(e => ({
              message: e.message,
              timestamp: new Date(e.timestamp).toISOString(),
              url: e.url
            }))
          }, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: false, error: error.message }, null, 2)
        }],
        isError: true
      };
    }
  }
);

// Tool: get_console_logs
server.tool(
  'get_console_logs',
  'Get all console messages (log, info, warn, debug, error) - not just errors. Use this to see full console output including console.log statements.',
  {
    methods: z.array(z.enum(['log', 'info', 'warn', 'debug', 'error'])).optional()
      .describe('Filter by console method types (default: all types)'),
    limit: z.number().optional().describe('Maximum number of log entries to return (default: 100)'),
    since: z.number().optional().describe('Only return logs after this timestamp (ms since epoch)'),
    session: z.string().optional().describe('Session name (uses current state if not provided)')
  },
  async ({ methods, limit = 100, since, session }) => {
    try {
      let result;
      
      if (session) {
        // Get from session
        const data = await callDebugServer(`/session/${session}`);
        if (data.error) throw new Error(data.error);
        
        let logs = data.console_logs?.logs || [];
        
        // Apply filters manually for session data
        if (methods && methods.length > 0) {
          logs = logs.filter(l => methods.includes(l.method));
        }
        if (since) {
          logs = logs.filter(l => l.timestamp > since);
        }
        if (limit > 0) {
          logs = logs.slice(-limit);
        }
        
        // Calculate stats
        const stats = { total: logs.length, byMethod: {} };
        for (const log of logs) {
          stats.byMethod[log.method] = (stats.byMethod[log.method] || 0) + 1;
        }
        
        result = { logs, stats, filters: { methods, limit, since } };
      } else {
        // Use the /console endpoint with query params
        const params = new URLSearchParams();
        if (methods && methods.length > 0) params.set('methods', methods.join(','));
        if (limit) params.set('limit', limit.toString());
        if (since) params.set('since', since.toString());
        
        result = await callDebugServer(`/console?${params.toString()}`);
        if (result.error) throw new Error(result.error);
      }
      
      // Format logs for AI consumption
      const formattedLogs = result.logs.map(log => ({
        method: log.method,
        message: log.args?.join(' ') || '',
        timestamp: new Date(log.timestamp).toISOString(),
        url: log.url
      }));
      
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            totalLogs: result.stats?.total || formattedLogs.length,
            stats: result.stats?.byMethod || {},
            logs: formattedLogs
          }, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: false, error: error.message }, null, 2)
        }],
        isError: true
      };
    }
  }
);

// Tool: clear_console_logs
server.tool(
  'clear_console_logs',
  'Clear all captured console logs. Useful before performing an action to get clean logs.',
  {},
  async () => {
    try {
      const result = await callDebugServer('/console', { method: 'DELETE' });
      
      if (result.error) throw new Error(result.error);
      
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: true, message: 'Console logs cleared' }, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: false, error: error.message }, null, 2)
        }],
        isError: true
      };
    }
  }
);

// Tool: get_dom
server.tool(
  'get_dom',
  'Get the current DOM HTML content. By default requests fresh DOM from the browser. Use sparingly as it can be large.',
  {
    session: z.string().optional().describe('Session name (uses current state if not provided)'),
    maxLength: z.number().optional().describe('Maximum HTML length to return (default: 50000)'),
    fresh: z.boolean().optional().describe('Request fresh DOM from browser (default: true). Set to false to use cached data.')
  },
  async ({ session, maxLength = 50000, fresh = true }) => {
    try {
      let dom;
      
      if (session) {
        const data = await callDebugServer(`/session/${session}`);
        if (data.error) throw new Error(data.error);
        dom = data.dom_snapshot;
      } else {
        // Request fresh DOM if not using a session
        if (fresh) {
          const refreshResult = await callDebugServer('/refresh-dom', {
            method: 'POST',
            body: JSON.stringify({ timeout: 5000 })
          });
          
          if (refreshResult.success && refreshResult.dom) {
            dom = refreshResult.dom;
          } else {
            // Fall back to cached if refresh fails
            const state = await callDebugServer('/data/dom-snapshot.json');
            if (state.error) throw new Error(state.error);
            dom = state;
          }
        } else {
          const state = await callDebugServer('/data/dom-snapshot.json');
          if (state.error) throw new Error(state.error);
          dom = state;
        }
      }
      
      let html = dom.html || '';
      const truncated = html.length > maxLength;
      if (truncated) {
        html = html.slice(0, maxLength) + '\n... [truncated]';
      }
      
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            url: dom.url,
            timestamp: dom.timestamp,
            htmlLength: dom.html?.length || 0,
            truncated,
            html
          }, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: false, error: error.message }, null, 2)
        }],
        isError: true
      };
    }
  }
);

// Tool: wait_for_element
server.tool(
  'wait_for_element',
  'Wait for an element to appear in the page.',
  {
    selector: z.string().describe('CSS selector to wait for'),
    timeout: z.number().optional().describe('Timeout in ms (default: 10000)')
  },
  async ({ selector, timeout = 10000 }) => {
    const browser = getBrowserManager();
    
    try {
      const result = await browser.waitForElement(selector, timeout);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }],
        isError: !result.success
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: false, error: error.message }, null, 2)
        }],
        isError: true
      };
    }
  }
);

// Tool: close_browser
server.tool(
  'close_browser',
  'Close the browser. Call this when done with testing.',
  {},
  async () => {
    const browser = getBrowserManager();
    
    try {
      await browser.close();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: true, message: 'Browser closed' }, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: false, error: error.message }, null, 2)
        }],
        isError: true
      };
    }
  }
);

// Tool: get_status
server.tool(
  'get_status',
  'Get the current status of the browser and debug server connection.',
  {},
  async () => {
    const browser = getBrowserManager();
    
    try {
      const pageInfo = await browser.getPageInfo();
      const serverStatus = await callDebugServer('/status');
      
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            browser: pageInfo,
            server: serverStatus
          }, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ 
            browser: { isLaunched: false },
            server: { connected: false },
            error: error.message 
          }, null, 2)
        }]
      };
    }
  }
);

// ===== RESOURCES =====

// Resource: Current state summary
server.resource(
  'state://current',
  'Current browser state summary',
  async () => {
    const state = await callDebugServer('/state');
    
    return {
      contents: [{
        uri: 'state://current',
        mimeType: 'application/json',
        text: JSON.stringify({
          url: state.dom?.url,
          consoleErrors: (state.console?.logs || []).filter(l => l.method === 'error').length,
          totalConsole: state.console?.logs?.length || 0,
          events: state.events?.events?.length || 0
        }, null, 2)
      }]
    };
  }
);

// ===== START SERVER =====

async function main() {
  console.error('🚀 Starting Browser Debug MCP Server...');
  console.error(`📡 Debug server URL: ${DEBUG_SERVER_URL}`);
  
  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  console.error('✅ MCP Server running');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
