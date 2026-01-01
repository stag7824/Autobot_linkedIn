/**
 * LinkedIn Easy Apply Bot - Utility Functions
 * 
 * Helper functions for delays, human-like behavior, and DOM manipulation.
 * 
 * @license MIT
 */

import config from '../config/index.js';

/**
 * Random delay between min and max milliseconds
 */
export function randomSleep(min, max) {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * Sleep for action delay
 */
export async function actionDelay() {
  const { min, max } = config.delays.betweenActions;
  await randomSleep(min, max);
}

/**
 * Sleep between applications (respects Gemini API rate limits)
 * In production: 2-3 minutes to stay under 5 RPM / 20 RPD limits
 * In development: 5-15 seconds for quick testing
 */
export async function applicationDelay() {
  const { min, max } = config.delays.betweenApplications;
  
  if (config.env.isProduction) {
    const delaySeconds = Math.floor((min + max) / 2 / 1000);
    console.log(`⏳ Waiting ${delaySeconds}s between applications (API rate limit protection)...`);
  }
  
  await randomSleep(min, max);
}

/**
 * Type text with human-like delays
 */
export async function humanType(page, selector, text) {
  const element = await page.$(selector);
  if (!element) return false;
  
  await element.click();
  await randomSleep(100, 300);
  
  // Clear existing text
  await page.evaluate(el => el.value = '', element);
  
  // Type character by character
  for (const char of text) {
    await page.keyboard.type(char, { 
      delay: Math.random() * (config.delays.typing.max - config.delays.typing.min) + config.delays.typing.min 
    });
  }
  
  return true;
}

/**
 * Safe click with retry
 */
export async function safeClick(page, selector, timeout = 5000) {
  try {
    await page.waitForSelector(selector, { timeout, visible: true });
    await randomSleep(200, 500);
    await page.click(selector);
    return true;
  } catch {
    return false;
  }
}

/**
 * Safe click on element handle
 */
export async function safeClickElement(element) {
  try {
    await randomSleep(200, 500);
    await element.click();
    return true;
  } catch {
    return false;
  }
}

/**
 * Simulate human-like mouse movement
 */
export async function simulateHumanBehavior(page) {
  try {
    // Random mouse movement
    const viewport = await page.viewport();
    if (viewport) {
      const x = Math.random() * viewport.width * 0.8 + viewport.width * 0.1;
      const y = Math.random() * viewport.height * 0.8 + viewport.height * 0.1;
      await page.mouse.move(x, y, { steps: 10 });
    }
    
    // Random short pause
    await randomSleep(500, 1500);
  } catch {
    // Ignore errors
  }
}

/**
 * Natural scrolling
 */
export async function naturalScroll(page, amount = 300) {
  const steps = Math.floor(Math.random() * 3) + 2;
  const stepAmount = amount / steps;
  
  for (let i = 0; i < steps; i++) {
    await page.evaluate((scroll) => {
      window.scrollBy({ top: scroll, behavior: 'smooth' });
    }, stepAmount);
    await randomSleep(100, 300);
  }
}

/**
 * Scroll element into view
 */
export async function scrollIntoView(page, element) {
  await page.evaluate(el => {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, element);
  await randomSleep(500, 1000);
}

/**
 * Get text content of element
 */
export async function getElementText(page, selector) {
  try {
    const element = await page.$(selector);
    if (!element) return '';
    return await page.evaluate(el => el.textContent?.trim() || '', element);
  } catch {
    return '';
  }
}

/**
 * Wait for navigation or timeout
 */
export async function waitForNavigation(page, timeout = 30000) {
  try {
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if element exists
 */
export async function elementExists(page, selector) {
  try {
    const element = await page.$(selector);
    return !!element;
  } catch {
    return false;
  }
}

/**
 * Wait for element and get it
 */
export async function waitForElement(page, selector, timeout = 10000) {
  try {
    await page.waitForSelector(selector, { timeout, visible: true });
    return await page.$(selector);
  } catch {
    return null;
  }
}

/**
 * Get all elements matching selector
 */
export async function getAllElements(page, selector) {
  try {
    return await page.$$(selector);
  } catch {
    return [];
  }
}

/**
 * Fill input field
 */
export async function fillInput(page, selector, value) {
  try {
    const element = await page.$(selector);
    if (!element) return false;
    
    await element.click({ clickCount: 3 }); // Select all
    await randomSleep(100, 200);
    await element.type(value, { delay: Math.random() * 50 + 30 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Select dropdown option
 */
export async function selectOption(page, selector, value) {
  try {
    await page.select(selector, value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check/uncheck checkbox
 */
export async function setCheckbox(page, selector, checked) {
  try {
    const element = await page.$(selector);
    if (!element) return false;
    
    const isChecked = await page.evaluate(el => el.checked, element);
    if (isChecked !== checked) {
      await element.click();
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Take session break (anti-detection)
 */
export async function sessionBreak() {
  const { min, max } = config.delays.sessionBreak.duration;
  const duration = Math.floor(Math.random() * (max - min)) + min;
  console.log(`☕ Taking a break for ${Math.round(duration / 1000)} seconds...`);
  await new Promise(resolve => setTimeout(resolve, duration));
}

/**
 * Format time duration
 */
export function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

/**
 * Retry function with exponential backoff
 */
export async function retry(fn, maxRetries = 3, baseDelay = 1000) {
  let lastError;
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i < maxRetries - 1) {
        const delay = baseDelay * Math.pow(2, i);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw lastError;
}

export default {
  randomSleep,
  actionDelay,
  applicationDelay,
  humanType,
  safeClick,
  safeClickElement,
  simulateHumanBehavior,
  naturalScroll,
  scrollIntoView,
  getElementText,
  waitForNavigation,
  elementExists,
  waitForElement,
  getAllElements,
  fillInput,
  selectOption,
  setCheckbox,
  sessionBreak,
  formatDuration,
  retry,
};
