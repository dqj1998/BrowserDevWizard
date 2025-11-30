// Diff Utilities - Compare browser states between captures
// Provides DOM comparison, console error detection, and state change analysis

import { JSDOM } from 'jsdom';

/**
 * Compare two DOM snapshots and identify changes
 * @param {Object} before - Before state { html, url, timestamp }
 * @param {Object} after - After state { html, url, timestamp }
 * @returns {Object} Diff result
 */
export function compareDom(before, after) {
  const result = {
    urlChanged: before?.url !== after?.url,
    beforeUrl: before?.url,
    afterUrl: after?.url,
    htmlChanged: before?.html !== after?.html,
    beforeLength: before?.html?.length || 0,
    afterLength: after?.html?.length || 0,
    changes: []
  };

  if (!result.htmlChanged) {
    return result;
  }

  try {
    const domBefore = new JSDOM(before?.html || '');
    const domAfter = new JSDOM(after?.html || '');

    // Compare key elements
    const bodyBefore = domBefore.window.document.body;
    const bodyAfter = domAfter.window.document.body;

    // Count elements
    const countsBefore = countElements(bodyBefore);
    const countsAfter = countElements(bodyAfter);

    result.elementChanges = {};
    for (const tag of new Set([...Object.keys(countsBefore), ...Object.keys(countsAfter)])) {
      const before = countsBefore[tag] || 0;
      const after = countsAfter[tag] || 0;
      if (before !== after) {
        result.elementChanges[tag] = { before, after, diff: after - before };
      }
    }

    // Check for new error indicators
    const errorIndicators = ['.error', '.alert-danger', '[class*="error"]', '[class*="fail"]'];
    for (const selector of errorIndicators) {
      const beforeCount = bodyBefore.querySelectorAll(selector).length;
      const afterCount = bodyAfter.querySelectorAll(selector).length;
      if (afterCount > beforeCount) {
        result.changes.push({
          type: 'new_error_element',
          selector,
          count: afterCount - beforeCount
        });
      }
    }

    // Check form state changes
    const inputsBefore = Array.from(bodyBefore.querySelectorAll('input, textarea, select'));
    const inputsAfter = Array.from(bodyAfter.querySelectorAll('input, textarea, select'));
    
    if (inputsBefore.length !== inputsAfter.length) {
      result.changes.push({
        type: 'form_elements_changed',
        before: inputsBefore.length,
        after: inputsAfter.length
      });
    }

  } catch (error) {
    result.parseError = error.message;
  }

  return result;
}

/**
 * Count elements by tag name
 */
function countElements(element) {
  const counts = {};
  if (!element) return counts;
  
  const all = element.getElementsByTagName('*');
  for (const el of all) {
    const tag = el.tagName.toLowerCase();
    counts[tag] = (counts[tag] || 0) + 1;
  }
  return counts;
}

/**
 * Compare console logs and extract new entries
 * @param {Object} before - Before state { logs: [] }
 * @param {Object} after - After state { logs: [] }
 * @returns {Object} Console diff
 */
export function compareConsole(before, after) {
  const beforeLogs = before?.logs || [];
  const afterLogs = after?.logs || [];
  
  // Find new logs (by timestamp comparison)
  const beforeTimestamps = new Set(beforeLogs.map(l => l.timestamp));
  const newLogs = afterLogs.filter(l => !beforeTimestamps.has(l.timestamp));
  
  // Categorize new logs
  const newErrors = newLogs.filter(l => l.method === 'error');
  const newWarnings = newLogs.filter(l => l.method === 'warn');
  
  return {
    beforeCount: beforeLogs.length,
    afterCount: afterLogs.length,
    newEntriesCount: newLogs.length,
    newLogs,
    newErrors,
    newWarnings,
    hasNewErrors: newErrors.length > 0,
    hasNewWarnings: newWarnings.length > 0,
    // Format errors for AI consumption
    errorSummary: newErrors.map(e => ({
      message: e.args?.join(' ') || 'Unknown error',
      timestamp: e.timestamp,
      url: e.url
    }))
  };
}

/**
 * Compare events between sessions
 * @param {Object} before - Before state { events: [] }
 * @param {Object} after - After state { events: [] }
 * @returns {Object} Events diff
 */
export function compareEvents(before, after) {
  const beforeEvents = before?.events || [];
  const afterEvents = after?.events || [];
  
  const beforeTimestamps = new Set(beforeEvents.map(e => e.timestamp));
  const newEvents = afterEvents.filter(e => !beforeTimestamps.has(e.timestamp));
  
  // Group by action type
  const byAction = {};
  for (const event of newEvents) {
    const action = event.action || 'unknown';
    if (!byAction[action]) byAction[action] = [];
    byAction[action].push(event);
  }
  
  // Check for failures
  const failedEvents = newEvents.filter(e => e.success === false);
  
  return {
    beforeCount: beforeEvents.length,
    afterCount: afterEvents.length,
    newEventsCount: newEvents.length,
    newEvents,
    byAction,
    failedEvents,
    hasFailures: failedEvents.length > 0
  };
}

/**
 * Compare two complete session states
 * @param {Object} session1 - First session data
 * @param {Object} session2 - Second session data
 * @returns {Object} Complete diff analysis
 */
export function compareSessions(session1, session2) {
  return {
    sessions: {
      before: session1.name || 'session1',
      after: session2.name || 'session2'
    },
    dom: compareDom(session1.dom_snapshot, session2.dom_snapshot),
    console: compareConsole(session1.console_logs, session2.console_logs),
    events: compareEvents(session1.events, session2.events),
    summary: generateSummary(session1, session2)
  };
}

/**
 * Generate human-readable summary of changes
 */
function generateSummary(session1, session2) {
  const issues = [];
  const changes = [];
  
  // Check DOM
  if (session1.dom_snapshot?.html !== session2.dom_snapshot?.html) {
    changes.push('DOM content changed');
  }
  
  if (session1.dom_snapshot?.url !== session2.dom_snapshot?.url) {
    changes.push(`URL changed: ${session1.dom_snapshot?.url} → ${session2.dom_snapshot?.url}`);
  }
  
  // Check console
  const console1 = session1.console_logs?.logs || [];
  const console2 = session2.console_logs?.logs || [];
  const newErrors = console2.filter(
    l => l.method === 'error' && !console1.some(c => c.timestamp === l.timestamp)
  );
  
  if (newErrors.length > 0) {
    issues.push(`${newErrors.length} new console error(s)`);
    for (const err of newErrors.slice(0, 3)) {
      issues.push(`  - ${err.args?.join(' ').slice(0, 100)}`);
    }
  }
  
  // Check events
  const events1 = session1.events?.events || [];
  const events2 = session2.events?.events || [];
  const failedEvents = events2.filter(
    e => e.success === false && !events1.some(ev => ev.timestamp === e.timestamp)
  );
  
  if (failedEvents.length > 0) {
    issues.push(`${failedEvents.length} failed action(s)`);
    for (const evt of failedEvents.slice(0, 3)) {
      issues.push(`  - ${evt.action}: ${evt.error || 'unknown error'}`);
    }
  }
  
  return {
    hasIssues: issues.length > 0,
    hasChanges: changes.length > 0,
    issues,
    changes,
    recommendation: issues.length > 0 
      ? 'Review console errors and failed actions before continuing'
      : changes.length > 0 
        ? 'Page state changed - verify expected behavior'
        : 'No significant changes detected'
  };
}

/**
 * Extract all console errors from a session
 * @param {Object} consoleLogs - Console logs data { logs: [] }
 * @returns {Array} Error entries with formatted messages
 */
export function extractErrors(consoleLogs) {
  const logs = consoleLogs?.logs || [];
  return logs
    .filter(l => l.method === 'error')
    .map(e => ({
      message: e.args?.join(' ') || 'Unknown error',
      timestamp: e.timestamp,
      url: e.url,
      formatted: `[${new Date(e.timestamp).toISOString()}] ${e.args?.join(' ')}`
    }));
}

/**
 * Format diff result for AI consumption
 * @param {Object} diff - Diff result from compareSessions
 * @returns {string} Formatted markdown summary
 */
export function formatDiffForAI(diff) {
  const lines = ['## State Comparison Report\n'];
  
  lines.push(`**Sessions:** ${diff.sessions.before} → ${diff.sessions.after}\n`);
  
  // Summary
  lines.push('### Summary');
  if (diff.summary.hasIssues) {
    lines.push('⚠️ **Issues Found:**');
    diff.summary.issues.forEach(i => lines.push(`- ${i}`));
  }
  if (diff.summary.hasChanges) {
    lines.push('\n📝 **Changes:**');
    diff.summary.changes.forEach(c => lines.push(`- ${c}`));
  }
  if (!diff.summary.hasIssues && !diff.summary.hasChanges) {
    lines.push('✅ No significant changes or issues detected');
  }
  
  // Console errors
  if (diff.console.hasNewErrors) {
    lines.push('\n### New Console Errors');
    diff.console.errorSummary.forEach(e => {
      lines.push(`- \`${e.message.slice(0, 200)}\``);
    });
  }
  
  // DOM changes
  if (diff.dom.htmlChanged) {
    lines.push('\n### DOM Changes');
    lines.push(`- Size: ${diff.dom.beforeLength} → ${diff.dom.afterLength} chars`);
    if (diff.dom.elementChanges && Object.keys(diff.dom.elementChanges).length > 0) {
      lines.push('- Element changes:');
      for (const [tag, change] of Object.entries(diff.dom.elementChanges)) {
        lines.push(`  - \`<${tag}>\`: ${change.before} → ${change.after} (${change.diff > 0 ? '+' : ''}${change.diff})`);
      }
    }
  }
  
  lines.push(`\n**Recommendation:** ${diff.summary.recommendation}`);
  
  return lines.join('\n');
}
