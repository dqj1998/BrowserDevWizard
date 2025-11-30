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
  'Navigate to a URL in the browser. Waits for page load.',
  {
    url: z.string().describe('URL to navigate to'),
    waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).optional()
      .describe('When to consider navigation complete (default: domcontentloaded)')
  },
  async ({ url, waitUntil }) => {
    const browser = getBrowserManager();
    
    try {
      const result = await browser.navigate(url, { waitUntil });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            url: result.url,
            title: result.title
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
    usePlaywright: z.boolean().optional().describe('Use Playwright directly instead of extension (more reliable)')
  },
  async ({ action, selector, text, code, timeout, usePlaywright }) => {
    try {
      // Use Playwright directly for click/type if requested or as fallback
      if (usePlaywright && (action === 'click' || action === 'type')) {
        const browser = getBrowserManager();
        let result;
        
        if (action === 'click') {
          result = await browser.click(selector, timeout || 5000);
        } else if (action === 'type') {
          result = await browser.type(selector, text, timeout || 5000);
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
  'Get current browser state without saving a capture session. Returns DOM, console logs, and events.',
  {
    includeScreenshot: z.boolean().optional().describe('Include screenshot data (can be large)')
  },
  async ({ includeScreenshot }) => {
    try {
      const state = await callDebugServer('/state');
      
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

// Tool: get_dom
server.tool(
  'get_dom',
  'Get the current DOM HTML content. Use sparingly as it can be large.',
  {
    session: z.string().optional().describe('Session name (uses current state if not provided)'),
    maxLength: z.number().optional().describe('Maximum HTML length to return (default: 50000)')
  },
  async ({ session, maxLength = 50000 }) => {
    try {
      let dom;
      
      if (session) {
        const data = await callDebugServer(`/session/${session}`);
        if (data.error) throw new Error(data.error);
        dom = data.dom_snapshot;
      } else {
        const state = await callDebugServer('/data/dom-snapshot.json');
        if (state.error) throw new Error(state.error);
        dom = state;
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
