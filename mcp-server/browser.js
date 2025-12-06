// Browser Manager - Playwright launcher with Chrome extension support
// Launches Chrome with the debug extension loaded and manages browser lifecycle

import { chromium } from 'playwright';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(__dirname, '..', 'extension');

// Default Chrome user data directory paths by OS
function getDefaultChromeUserDataDir() {
  const platform = os.platform();
  const homeDir = os.homedir();
  
  switch (platform) {
    case 'darwin': // macOS
      return path.join(homeDir, 'Library', 'Application Support', 'Google', 'Chrome');
    case 'win32': // Windows
      return path.join(homeDir, 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
    case 'linux':
      return path.join(homeDir, '.config', 'google-chrome');
    default:
      return '';
  }
}

class BrowserManager {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.isLaunched = false;
  }

  /**
   * Launch Chrome with the debug extension loaded
   * @param {Object} options - Launch options
   * @param {string} options.url - Initial URL to navigate to
   * @param {boolean} options.headless - Run in headless mode (default: false, extension needs UI)
   * @param {number} options.width - Viewport width
   * @param {number} options.height - Viewport height
   * @param {string} options.userDataDir - Chrome user data directory (for existing session)
   * @param {boolean} options.useExistingSession - Use existing Chrome session with logins (default: true)
   * @param {string} options.profileName - Chrome profile name (default: 'Default')
   */
  async launch(options = {}) {
    const {
      url,
      headless = false, // Extensions require headed mode
      width = 1280,
      height = 720,
      userDataDir,
      useExistingSession = true,
      profileName = 'Default'
    } = options;

    if (this.isLaunched) {
      throw new Error('Browser already launched. Call close() first.');
    }

    // Determine user data directory
    let dataDir = '';
    if (useExistingSession) {
      dataDir = userDataDir || getDefaultChromeUserDataDir();
      console.log(`🔐 Using existing Chrome session from: ${dataDir}`);
      console.log(`⚠️  Note: Close your regular Chrome browser first if using existing session!`);
    }

    console.log(`🚀 Launching Chrome with extension: ${EXTENSION_PATH}`);

    // Build launch args
    const launchArgs = [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run',
      '--no-default-browser-check'
    ];

    // Add profile directory if using existing session
    if (useExistingSession && profileName) {
      launchArgs.push(`--profile-directory=${profileName}`);
    }

    // Launch options
    const launchOptions = {
      headless: false, // Extensions don't work in headless
      args: launchArgs,
      viewport: { width, height }
    };

    // Use actual Chrome browser (not Chromium) for existing sessions
    if (useExistingSession) {
      launchOptions.channel = 'chrome';
      launchOptions.ignoreDefaultArgs = ['--disable-extensions', '--enable-automation'];
    }

    console.log(`📁 User data dir: ${dataDir || '(temporary)'}`);
    console.log(`🔧 Launch args:`, launchArgs);

    // Launch Chrome with extension
    try {
      this.context = await chromium.launchPersistentContext(dataDir, launchOptions);
    } catch (error) {
      if (error.message.includes('lock') || error.message.includes('already in use') || error.message.includes('user data directory')) {
        throw new Error(`Cannot use existing Chrome session - Chrome may already be running. Please close Chrome first, or set useExistingSession: false. Original error: ${error.message}`);
      }
      throw error;
    }

    // Get the first page or create one
    const pages = this.context.pages();
    this.page = pages.length > 0 ? pages[0] : await this.context.newPage();
    this.isLaunched = true;

    // Set up error handlers
    this.page.on('pageerror', (error) => {
      console.error('Page error:', error.message);
    });

    this.page.on('crash', () => {
      console.error('Page crashed!');
      this.isLaunched = false;
    });

    this.context.on('close', () => {
      console.log('Browser context closed');
      this.isLaunched = false;
      this.browser = null;
      this.context = null;
      this.page = null;
    });

    // Navigate to URL if provided
    if (url) {
      await this.navigate(url);
    }

    console.log('✅ Browser launched successfully');
    return { success: true, url: this.page.url() };
  }

  /**
   * Navigate to a URL
   * @param {string} url - URL to navigate to
   * @param {Object} options - Navigation options
   */
  async navigate(url, options = {}) {
    if (!this.isLaunched || !this.page) {
      throw new Error('Browser not launched');
    }

    const { waitUntil = 'domcontentloaded', timeout = 30000 } = options;

    console.log(`🔗 Navigating to: ${url}`);
    await this.page.goto(url, { waitUntil, timeout });
    
    // Wait a bit for extension to connect
    await this.page.waitForTimeout(1000);
    
    return { success: true, url: this.page.url(), title: await this.page.title() };
  }

  /**
   * Wait for an element to appear
   * @param {string} selector - CSS selector
   * @param {number} timeout - Timeout in ms
   */
  async waitForElement(selector, timeout = 10000) {
    if (!this.isLaunched || !this.page) {
      throw new Error('Browser not launched');
    }

    try {
      await this.page.waitForSelector(selector, { timeout });
      return { success: true, found: true };
    } catch (error) {
      return { success: false, found: false, error: error.message };
    }
  }

  /**
   * Wait for network to be idle
   * @param {number} timeout - Timeout in ms
   */
  async waitForNetworkIdle(timeout = 10000) {
    if (!this.isLaunched || !this.page) {
      throw new Error('Browser not launched');
    }

    try {
      await this.page.waitForLoadState('networkidle', { timeout });
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Take a screenshot using Playwright (backup for extension)
   * @param {Object} options - Screenshot options
   */
  async screenshot(options = {}) {
    if (!this.isLaunched || !this.page) {
      throw new Error('Browser not launched');
    }

    const { fullPage = false } = options;
    const buffer = await this.page.screenshot({ fullPage, type: 'png' });
    const base64 = buffer.toString('base64');
    
    return {
      success: true,
      dataUrl: `data:image/png;base64,${base64}`,
      timestamp: Date.now()
    };
  }

  /**
   * Get page info
   */
  async getPageInfo() {
    if (!this.isLaunched || !this.page) {
      return { isLaunched: false };
    }

    return {
      isLaunched: true,
      url: this.page.url(),
      title: await this.page.title()
    };
  }

  /**
   * Reload the current page
   */
  async reload() {
    if (!this.isLaunched || !this.page) {
      throw new Error('Browser not launched');
    }

    await this.page.reload({ waitUntil: 'domcontentloaded' });
    return { success: true, url: this.page.url() };
  }

  /**
   * Go back in history
   */
  async goBack() {
    if (!this.isLaunched || !this.page) {
      throw new Error('Browser not launched');
    }

    await this.page.goBack();
    return { success: true, url: this.page.url() };
  }

  /**
   * Go forward in history
   */
  async goForward() {
    if (!this.isLaunched || !this.page) {
      throw new Error('Browser not launched');
    }

    await this.page.goForward();
    return { success: true, url: this.page.url() };
  }

  /**
   * Click on an element using Playwright directly
   * @param {string} selector - CSS selector
   * @param {number} timeout - Timeout in ms
   */
  async click(selector, timeout = 5000) {
    if (!this.isLaunched || !this.page) {
      throw new Error('Browser not launched');
    }

    try {
      await this.page.click(selector, { timeout });
      return { success: true, action: 'click', selector };
    } catch (error) {
      return { success: false, action: 'click', selector, error: error.message };
    }
  }

  /**
   * Type text into an element using Playwright directly
   * @param {string} selector - CSS selector
   * @param {string} text - Text to type
   * @param {number} timeout - Timeout in ms
   */
  async type(selector, text, timeout = 5000) {
    if (!this.isLaunched || !this.page) {
      throw new Error('Browser not launched');
    }

    try {
      await this.page.click(selector, { timeout });
      await this.page.type(selector, text, { delay: 50 });
      return { success: true, action: 'type', selector, text };
    } catch (error) {
      return { success: false, action: 'type', selector, error: error.message };
    }
  }

  /**
   * Fill an element with text (faster than type, replaces content)
   * @param {string} selector - CSS selector
   * @param {string} text - Text to fill
   * @param {number} timeout - Timeout in ms
   */
  async fill(selector, text, timeout = 5000) {
    if (!this.isLaunched || !this.page) {
      throw new Error('Browser not launched');
    }

    try {
      await this.page.fill(selector, text, { timeout });
      return { success: true, action: 'fill', selector, text };
    } catch (error) {
      return { success: false, action: 'fill', selector, error: error.message };
    }
  }

  /**
   * Press a key or key combination
   * @param {string} key - Key to press (e.g., 'Enter', 'Tab', 'Control+A')
   */
  async pressKey(key) {
    if (!this.isLaunched || !this.page) {
      throw new Error('Browser not launched');
    }

    try {
      await this.page.keyboard.press(key);
      return { success: true, action: 'press', key };
    } catch (error) {
      return { success: false, action: 'press', key, error: error.message };
    }
  }

  /**
   * Get the current page content (DOM)
   */
  async getContent() {
    if (!this.isLaunched || !this.page) {
      throw new Error('Browser not launched');
    }

    const content = await this.page.content();
    return { success: true, html: content, length: content.length };
  }

  /**
   * Evaluate JavaScript code in the page context using Playwright
   * This bypasses CSP restrictions as it uses the browser's debugger protocol
   * @param {string} code - JavaScript code to evaluate
   */
  async evaluate(code) {
    if (!this.isLaunched || !this.page) {
      throw new Error('Browser not launched. Use launch_browser first, or usePlaywright only works with Playwright-launched browsers.');
    }

    try {
      // Use Playwright's evaluate which uses CDP and bypasses CSP
      const result = await this.page.evaluate((codeToRun) => {
        // Execute the code and return the result
        const fn = new Function('return (' + codeToRun + ')');
        return fn();
      }, code);

      // Format result
      if (result === undefined) {
        return { success: true, result: 'undefined' };
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
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Close the browser
   */
  async close() {
    if (this.context) {
      console.log('👋 Closing browser...');
      await this.context.close();
      this.browser = null;
      this.context = null;
      this.page = null;
      this.isLaunched = false;
    }
    return { success: true };
  }
}

// Singleton instance
let browserManager = null;

export function getBrowserManager() {
  if (!browserManager) {
    browserManager = new BrowserManager();
  }
  return browserManager;
}

export { BrowserManager };
