// Browser Dev Bridge - Popup Script

const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const connectBtn = document.getElementById('connectBtn');
const captureAllBtn = document.getElementById('captureAllBtn');
const domBtn = document.getElementById('domBtn');
const screenshotBtn = document.getElementById('screenshotBtn');

// Update UI based on connection status
function updateStatus(connected) {
  if (connected) {
    statusDot.className = 'status-dot connected';
    statusText.textContent = 'Connected';
    connectBtn.textContent = 'Reconnect';
    captureAllBtn.disabled = false;
    domBtn.disabled = false;
    screenshotBtn.disabled = false;
  } else {
    statusDot.className = 'status-dot disconnected';
    statusText.textContent = 'Disconnected';
    connectBtn.textContent = 'Connect';
    captureAllBtn.disabled = true;
    domBtn.disabled = true;
    screenshotBtn.disabled = true;
  }
}

// Check current status on popup open
chrome.runtime.sendMessage({ type: 'get_status' }, (response) => {
  if (response) {
    updateStatus(response.connected);
  }
});

// Connect button
connectBtn.addEventListener('click', () => {
  connectBtn.disabled = true;
  connectBtn.textContent = 'Connecting...';
  
  chrome.runtime.sendMessage({ type: 'connect' }, () => {
    // Check status after a short delay
    setTimeout(() => {
      chrome.runtime.sendMessage({ type: 'get_status' }, (response) => {
        updateStatus(response?.connected || false);
        connectBtn.disabled = false;
      });
    }, 1000);
  });
});

// Capture DOM button
domBtn.addEventListener('click', () => {
  domBtn.disabled = true;
  domBtn.textContent = 'Capturing...';
  
  chrome.runtime.sendMessage({ type: 'request_dom' }, () => {
    setTimeout(() => {
      domBtn.disabled = false;
      domBtn.textContent = 'Capture DOM';
    }, 500);
  });
});

// Capture Screenshot button
screenshotBtn.addEventListener('click', () => {
  screenshotBtn.disabled = true;
  screenshotBtn.textContent = 'Capturing...';
  
  chrome.runtime.sendMessage({ type: 'capture_screenshot' }, () => {
    setTimeout(() => {
      screenshotBtn.disabled = false;
      screenshotBtn.textContent = 'Capture Screenshot';
    }, 500);
  });
});

// Capture All button - saves everything to timestamped folder
captureAllBtn.addEventListener('click', () => {
  captureAllBtn.disabled = true;
  captureAllBtn.textContent = '⏳ Capturing...';
  
  chrome.runtime.sendMessage({ type: 'capture_all' }, () => {
    setTimeout(() => {
      captureAllBtn.disabled = false;
      captureAllBtn.textContent = '📸 Capture All';
    }, 1500);
  });
});
