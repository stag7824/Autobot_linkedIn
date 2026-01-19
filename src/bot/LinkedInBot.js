/**
 * LinkedIn Easy Apply Bot - Main Bot Class
 * 
 * Automates LinkedIn Easy Apply job applications with AI-powered form filling.
 * 
 * @license MIT
 */

import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import config, { buildSearchUrl } from '../config/index.js';
import stateManager from '../services/stateManager.js';
import { 
  initializeAI, 
  answerQuestion,
  answerCheckboxQuestion,
  getPresetAnswer,
  checkJobMatch,
  getAIStatus,
  setCurrentJobId,
} from '../services/aiService.js';
import * as jobLogger from '../services/jobLogger.js';
import * as answerCache from '../services/answerCache.js';
import {
  notifyApplicationSuccess,
  notifyApplicationError,
  notifyBotStatus,
  notifyManualIntervention,
} from '../services/notificationService.js';
import { shouldBotRun } from '../web/dashboard.js';
import {
  randomSleep,
  actionDelay,
  applicationDelay,
  humanType,
  safeClick,
  simulateHumanBehavior,
  naturalScroll,
  scrollIntoView,
  waitForElement,
  getAllElements,
  elementExists,
  sessionBreak,
  formatDuration,
} from '../utils/helpers.js';

// Enable stealth mode
if (config.bot.stealthMode) {
  puppeteer.use(StealthPlugin());
}

/**
 * LinkedIn Easy Apply Bot
 */
export class LinkedInBot {
  constructor() {
    this.browser = null;
    this.page = null;
    this.isLoggedIn = false;
    this.startTime = Date.now();
    this.debugCounter = 0;
    this.currentJobDescription = '';  // Store job description for AI context
    this.currentJobTitle = '';        // Current job title for context
    this.currentCompany = '';         // Current company for context
    this.sessionStats = {
      applied: 0,
      skipped: 0,
      failed: 0,
    };
    // Track all application interactions for data collection
    this.applicationData = null;
  }

  /**
   * Reset application data tracker for new job application
   */
  resetApplicationData(jobId, title, company) {
    this.applicationData = {
      jobId,
      title,
      company,
      startedAt: new Date().toISOString(),
      completedAt: null,
      steps: [],
      formFields: [],
      actions: [],
      totalSteps: 0,
    };
  }

  /**
   * Log an action taken during application
   */
  logAction(actionType, details) {
    if (!this.applicationData) return;
    this.applicationData.actions.push({
      timestamp: new Date().toISOString(),
      type: actionType,
      ...details,
    });
  }

  /**
   * Log a form field interaction
   */
  logFormField(fieldType, label, value, action, options = null) {
    if (!this.applicationData) return;
    this.applicationData.formFields.push({
      timestamp: new Date().toISOString(),
      fieldType,
      label: label || 'unknown',
      value,
      action,
      options: options || undefined,
    });
  }

  /**
   * Take a debug snapshot (screenshot + URL + page info) in development mode
   */
  async debugSnapshot(label) {
    if (config.env.isProduction) return;
    
    this.debugCounter++;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `debug_${this.debugCounter}_${label.replace(/\s+/g, '_')}_${timestamp}`;
    
    try {
      const url = this.page.url();
      const title = await this.page.title();
      
      // Take screenshot
      await this.page.screenshot({ 
        path: `./data/debug/${filename}.png`,
        fullPage: false 
      });
      
      console.log(`📸 [DEBUG ${this.debugCounter}] ${label}`);
      console.log(`   URL: ${url}`);
      console.log(`   Title: ${title}`);
      
      // Log visible dialogs/modals (important for Easy Apply debugging)
      const dialogs = await this.page.evaluate(() => {
        const dialogEls = document.querySelectorAll('[role="dialog"], [role="alertdialog"], .artdeco-modal');
        return Array.from(dialogEls).map(d => {
          const heading = d.querySelector('h2, h3, .artdeco-modal__header');
          const hasEasyApply = d.textContent?.toLowerCase().includes('easy apply') || 
                              d.textContent?.toLowerCase().includes('application');
          return {
            heading: heading?.textContent?.trim().substring(0, 60),
            isEasyApply: hasEasyApply,
            className: d.className?.substring(0, 50)
          };
        }).filter(d => d.heading || d.isEasyApply);
      }).catch(() => []);
      
      if (dialogs.length > 0) {
        console.log(`   Dialogs found: ${dialogs.map(d => d.heading || (d.isEasyApply ? 'Easy Apply Modal' : 'Unknown')).join(', ')}`);
      } else {
        console.log(`   No dialogs/modals found on page`);
      }
      
      // Log Easy Apply related elements
      const easyApplyInfo = await this.page.evaluate(() => {
        const easyApplyLink = document.querySelector('a[href*="/apply/"]');
        const easyApplyButton = Array.from(document.querySelectorAll('button')).find(b => 
          b.textContent?.toLowerCase().includes('easy apply'));
        return {
          hasLink: !!easyApplyLink,
          linkHref: easyApplyLink?.href?.substring(0, 80),
          hasButton: !!easyApplyButton,
          buttonText: easyApplyButton?.textContent?.trim().substring(0, 30)
        };
      }).catch(() => ({}));
      
      if (easyApplyInfo.hasLink) {
        console.log(`   Easy Apply Link: ${easyApplyInfo.linkHref}`);
      }
      if (easyApplyInfo.hasButton) {
        console.log(`   Easy Apply Button: "${easyApplyInfo.buttonText}"`);
      }
      
    } catch (err) {
      console.log(`📸 [DEBUG ${this.debugCounter}] ${label} - Error: ${err.message}`);
    }
  }

  /**
   * Initialize browser
   */
  async init() {
    console.log('🚀 Initializing browser...');
    
    // Use persistent session directory to avoid re-login
    const sessionDir = config.bot.sessionPath || './data/session';
    console.log(`📁 Using session directory: ${sessionDir}`);
    
    // Clean up stale Chrome lock files (fixes "profile in use" error in Docker)
    await this.cleanupChromeLocks(sessionDir);
    
    // Check if running in Docker (use system Chromium)
    const isDocker = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.DOCKER;
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
    
    if (executablePath) {
      console.log(`🐳 Docker mode: Using ${executablePath}`);
    }
    
    this.browser = await puppeteer.launch({
      headless: config.bot.headless ? 'new' : false,
      executablePath: executablePath,
      defaultViewport: { width: 1280, height: 900 },
      userDataDir: sessionDir,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--window-size=1280,900',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-extensions',
        '--no-first-run',
        // '--no-zygote',
        // '--single-process',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-translate',
        '--hide-scrollbars',
        '--mute-audio',
        '--metrics-recording-only',
        // Disable crash reporting completely
        '--disable-breakpad',
        '--disable-crash-reporter',
        '--disable-crashpad',
        '--no-crashpad',
        // '--crash-dumps-dir=/tmp',
        '--enable-features=NetworkService,NetworkServiceInProcess',
      ],
      // Ignore HTTPS errors (for some corporate proxies)
      ignoreHTTPSErrors: true,
      // Disable crash dumps
      env: {
        ...process.env,
        CHROME_CRASHPAD_DISABLE: '1',
        DISABLE_CRASHPAD: '1',
      },
    });

    this.page = await this.browser.newPage();
    
    // Set user agent
    await this.page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // Set extra headers
    await this.page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
    });

    console.log('✅ Browser initialized');
    
    // Initialize AI (Gemini + OpenRouter backup)
    await initializeAI();
    
    return this;
  }

  /**
   * Login to LinkedIn
   */
  async login() {
    console.log('🔐 Logging in to LinkedIn...');
    
    await this.page.goto(config.linkedin.loginUrl, { 
      waitUntil: 'domcontentloaded',
      timeout: 30000 
    });
    
    await randomSleep(2000, 3000);

    // Check if already logged in
    if (this.page.url().includes('/feed')) {
      console.log('✅ Already logged in');
      this.isLoggedIn = true;
      return true;
    }

    // Fill login form
    const { selectors } = config;
    
    await this.page.waitForSelector(selectors.login.emailInput, { timeout: 10000 });
    await humanType(this.page, selectors.login.emailInput, config.auth.email);
    await randomSleep(500, 1000);
    
    await humanType(this.page, selectors.login.passwordInput, config.auth.password);
    await randomSleep(500, 1000);
    
    await safeClick(this.page, selectors.login.submitButton);
    await randomSleep(3000, 5000);

    // Check for verification/captcha
    const hasVerification = await elementExists(this.page, selectors.login.verificationCheck);
    if (hasVerification) {
      console.log('⚠️ Security verification required - please complete manually');
      await notifyManualIntervention('Security verification required on LinkedIn');
      
      // Wait for verification to complete (5 minutes max)
      const maxWait = 5 * 60 * 1000;
      const startWait = Date.now();
      
      while (Date.now() - startWait < maxWait) {
        const stillOnVerification = await elementExists(this.page, selectors.login.verificationCheck);
        const onFeed = this.page.url().includes('/feed') || this.page.url().includes('/jobs');
        
        if (!stillOnVerification || onFeed) {
          console.log('✅ Verification completed');
          break;
        }
        await randomSleep(3000, 5000);
      }
    }

    // Verify login success
    await randomSleep(2000, 3000);
    const currentUrl = this.page.url();
    
    if (currentUrl.includes('/feed') || currentUrl.includes('/jobs') || currentUrl.includes('/in/')) {
      console.log('✅ Login successful');
      this.isLoggedIn = true;
      return true;
    }

    throw new Error('Login failed - could not verify successful login');
  }

  /**
   * Search for jobs
   * @param {string} keyword - Search keyword
   * @param {number} page - Page number (0-indexed)
   * @param {string} location - Optional location override for multi-location search
   */
  async searchJobs(keyword, page = 0, location = null) {
    const locationStr = location ? ` in "${location}"` : '';
    console.log(`🔍 Searching for "${keyword}"${locationStr} jobs (page ${page + 1})...`);
    
    const searchUrl = buildSearchUrl(keyword, page, location);
    
    // Retry navigation up to 3 times
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.page.goto(searchUrl, { 
          waitUntil: 'domcontentloaded',
          timeout: 45000 
        });
        
        await randomSleep(2000, 3000);
        await this.page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 }).catch(() => {});
        await simulateHumanBehavior(this.page);
        
        // Wait for job list
        await this.page.waitForSelector(
          '.scaffold-layout__list, .jobs-search-results-list', 
          { timeout: 20000 }
        ).catch(() => console.log('⚠️ Job list selector not found'));
        
        await randomSleep(2000, 3000);
        return true;
      } catch (err) {
        console.log(`⚠️ Search attempt ${attempt + 1}/3 failed: ${err.message}`);
        if (attempt < 2) await randomSleep(5000, 8000);
        else throw err;
      }
    }
  }

  /**
   * Get job cards from current page
   */
  async getJobCards() {
    await naturalScroll(this.page, 500);
    await randomSleep(1000, 2000);

    return await this.page.evaluate(() => {
      const cards = document.querySelectorAll('.scaffold-layout__list-item, .jobs-search-results__list-item');
      const jobs = [];

      cards.forEach(card => {
        try {
          const linkEl = card.querySelector('a[href*="/jobs/view/"]');
          if (!linkEl) return;

          const href = linkEl.getAttribute('href');
          const jobId = href.match(/\/view\/(\d+)/)?.[1];
          if (!jobId) return;

          const titleEl = card.querySelector('.job-card-list__title, .artdeco-entity-lockup__title, .job-card-container__link');
          const companyEl = card.querySelector('.job-card-container__company-name, .artdeco-entity-lockup__subtitle, .job-card-container__primary-description');
          const locationEl = card.querySelector('.job-card-container__metadata-item, .artdeco-entity-lockup__caption');
          
          // Multiple selectors for Easy Apply badge - LinkedIn changes these frequently
          const easyApplySelectors = [
            '.job-card-container__apply-method',
            '[class*="easy-apply"]',
            '.job-card-list__footer-wrapper svg[data-test-icon="lightning-bolt"]',
            'li-icon[type="linkedin-bug"]',
            '.job-card-container__footer-job-state',
          ];
          
          let hasEasyApply = false;
          for (const sel of easyApplySelectors) {
            const el = card.querySelector(sel);
            if (el) {
              const text = el.textContent?.toLowerCase() || '';
              if (text.includes('easy apply') || text.includes('linkedin') || el.querySelector('svg')) {
                hasEasyApply = true;
                break;
              }
            }
          }
          
          // If search was filtered for Easy Apply (f_AL=true), assume all jobs are Easy Apply
          // This is a fallback if the badge detection fails
          const searchParams = new URLSearchParams(window.location.search);
          const isEasyApplySearch = searchParams.get('f_AL') === 'true';
          
          jobs.push({
            jobId,
            title: titleEl?.textContent?.trim() || 'Unknown',
            company: companyEl?.textContent?.trim() || 'Unknown',
            location: locationEl?.textContent?.trim() || '',
            href,
            hasEasyApply: hasEasyApply || isEasyApplySearch, // Assume Easy Apply if searching with filter
            alreadyApplied: card.textContent?.toLowerCase().includes('applied'),
          });
        } catch (e) {
          // Skip invalid cards
        }
      });

      return jobs;
    });
  }

  /**
   * Apply to a job
   */
  async applyToJob(job) {
    const { jobId, title, company, href } = job;

    // Check if already applied
    if (stateManager.hasApplied(jobId)) {
      console.log(`⏭️ Already applied: ${title}`);
      this.sessionStats.skipped++;
      stateManager.incrementSkipped();
      return { success: false, reason: 'already_applied' };
    }

    if (job.alreadyApplied) {
      console.log(`⏭️ Already applied (LinkedIn): ${title}`);
      stateManager.addAppliedJob(jobId, { title, company, source: 'linkedin' });
      this.sessionStats.skipped++;
      return { success: false, reason: 'already_applied_linkedin' };
    }

    console.log(`\n📝 Applying to: ${title} at ${company}`);
    console.log(`   Job ID: ${jobId}, URL: ${href}`);
    
    // Store current job context for AI
    this.currentJobTitle = title;
    this.currentCompany = company;
    
    // Initialize application data tracking
    this.resetApplicationData(jobId, title, company);
    this.logAction('application_started', { jobId, title, company, href });
    
    // Initialize job logger for detailed logging
    const fullUrl = `https://www.linkedin.com/jobs/view/${jobId}`;
    jobLogger.startJobLog(jobId, title, company, fullUrl);
    setCurrentJobId(jobId);
    jobLogger.log(jobId, `Application started`);

    try {
      // Navigate to job page - use direct job view URL
      console.log(`   Navigating to: ${fullUrl}`);
      
      await this.page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await this.page.waitForNetworkIdle({ idleTime: 1000, timeout: 10000 }).catch(() => {});
      await randomSleep(2000, 4000);
      
      await this.debugSnapshot('after_navigate_to_job');

      // Verify we're on the right page
      const currentUrl = this.page.url();
      if (!currentUrl.includes('/jobs/') && !currentUrl.includes('/view/')) {
        console.log(`⚠️ Navigation went wrong! Current URL: ${currentUrl}`);
        await this.debugSnapshot('wrong_page');
        return { success: false, reason: 'navigation_failed' };
      }

      // Note: Bad job title check moved to run() loop for efficiency (skips from grid)

      // Check job requirements if COMPLETE_REQUIREMENTS is true
      if (config.jobFilter.completeRequirements) {
        const jobDescription = await this.getJobDescription();
        const match = await checkJobMatch(jobDescription);
        
        if (!match.match) {
          console.log(`⏭️ Skipping: ${match.reason}`);
          this.sessionStats.skipped++;
          stateManager.incrementSkipped();
          return { success: false, reason: match.reason };
        }
      }

      // Check for bad words in job description and store for AI context
      const description = await this.getJobDescription();
      this.currentJobDescription = description;  // Store for AI to use
      
      const badWordFound = config.jobFilter.badWords.find(word => 
        description.toLowerCase().includes(word.toLowerCase())
      );
      
      if (badWordFound) {
        console.log(`⏭️ Skipping: Contains "${badWordFound}"`);
        this.sessionStats.skipped++;
        stateManager.incrementSkipped();
        return { success: false, reason: `bad_word: ${badWordFound}` };
      }

      await this.debugSnapshot('before_find_easy_apply');

      // Find Easy Apply button
      const easyApplyBtn = await this.findEasyApplyButton();
      if (!easyApplyBtn) {
        console.log(`⏭️ No Easy Apply button found`);
        await this.debugSnapshot('no_easy_apply_button');
        this.sessionStats.skipped++;
        return { success: false, reason: 'no_easy_apply' };
      }
      
      // Log button info before clicking
      const btnInfo = await this.page.evaluate(el => ({
        text: el.textContent?.trim(),
        ariaLabel: el.getAttribute('aria-label'),
        className: el.className,
        tagName: el.tagName,
        href: el.href || null
      }), easyApplyBtn);
      console.log(`   🖱️ Clicking button: "${btnInfo.text}" (${btnInfo.ariaLabel || btnInfo.className})`);
      
      // For anchor tags, navigate directly to the href to ensure the apply page opens
      // LinkedIn's JavaScript click handlers may not work reliably in puppeteer
      if (btnInfo.tagName === 'A' && btnInfo.href && btnInfo.href.includes('/apply/')) {
        console.log(`   📍 Navigating to Easy Apply URL: ${btnInfo.href.substring(0, 80)}...`);
        await this.page.goto(btnInfo.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await randomSleep(2000, 3000);
      } else {
        // For button elements, use puppeteer's native click method (more reliable than DOM click)
        await easyApplyBtn.click();
        await randomSleep(2000, 3000);
      }
      
      await this.debugSnapshot('after_click_easy_apply');
      
      // Verify we didn't navigate away
      const urlAfterClick = this.page.url();
      if (urlAfterClick.includes('/learning/') || urlAfterClick.includes('/premium/')) {
        console.log(`⚠️ Clicked wrong button! Ended up at: ${urlAfterClick}`);
        await this.debugSnapshot('wrong_navigation');
        // Try to go back
        await this.page.goBack();
        await randomSleep(1000, 2000);
        return { success: false, reason: 'clicked_wrong_button' };
      }
      
      // UPDATED January 2026: Clicking the Easy Apply LINK opens the modal DIRECTLY on the main page
      // There's NO need to click anything inside an iframe - the /preload/ iframe is just for LinkedIn's internal use
      console.log(`   Waiting for Easy Apply modal to appear on main page...`);
      
      // Wait for modal to appear - modal opens DIRECTLY on main page after clicking Easy Apply link
      let modalAppeared = await this.waitForEasyApplyModal(8000);
      
      if (!modalAppeared) {
        console.log(`⚠️ Modal didn't appear on first click, retrying...`);
        await this.debugSnapshot('no_modal_first_try');
        
        // Check for "Save this application?" dialog - means modal was accidentally dismissed
        const saveDialog = await this.page.evaluate(() => {
          const dialogs = document.querySelectorAll('[role="alertdialog"], [role="dialog"]');
          for (const dialog of dialogs) {
            if (dialog.textContent?.includes('Save this application')) {
              return true;
            }
          }
          return false;
        }).catch(() => false);
        
        if (saveDialog) {
          console.log(`   ⚠️ Save dialog detected - clicking Discard`);
          await this.page.evaluate(() => {
            const buttons = document.querySelectorAll('button');
            for (const btn of buttons) {
              if (btn.textContent?.toLowerCase().includes('discard')) {
                btn.click();
                return;
              }
            }
          });
          await randomSleep(1000, 1500);
        }
        
        // Try clicking Easy Apply button again
        const easyApplyBtn2 = await this.findEasyApplyButton();
        if (easyApplyBtn2) {
          console.log(`   🖱️ Clicking Easy Apply button again...`);
          await this.page.evaluate(el => el.click(), easyApplyBtn2);
          await randomSleep(2000, 3000);
          await this.debugSnapshot('after_second_click');
          
          // Wait for modal again
          modalAppeared = await this.waitForEasyApplyModal(5000);
        }
        
        if (!modalAppeared) {
          console.log(`❌ Easy Apply modal failed to appear`);
          await this.debugSnapshot('modal_never_appeared');
          this.sessionStats.failed++;
          stateManager.incrementFailed();
          return { success: false, reason: 'modal_not_appearing' };
        }
      }
      
      console.log(`   ✅ Easy Apply modal is open, proceeding with application...`);
      await this.debugSnapshot('modal_opened_successfully');

      // Handle the application modal
      const applied = await this.handleEasyApplyModal();

      if (applied) {
        // Complete application data
        if (this.applicationData) {
          this.applicationData.completedAt = new Date().toISOString();
          this.applicationData.status = 'success';
          this.logAction('application_completed', { success: true });
        }
        
        // Finalize job log
        jobLogger.logSuccess(jobId, `Application submitted successfully`);
        const logText = jobLogger.finalizeJobLog(jobId, 'SUCCESS');
        setCurrentJobId(null);
        
        stateManager.addAppliedJob(jobId, { 
          title, 
          company, 
          url: fullUrl,
          applicationData: this.applicationData,
          logText, // Detailed logs for Pocketbase
        });
        this.sessionStats.applied++;
        console.log(`✅ Successfully applied to: ${title}`);
        await notifyApplicationSuccess(title, company);
        return { success: true };
      } else {
        // Log failed application data
        if (this.applicationData) {
          this.applicationData.completedAt = new Date().toISOString();
          this.applicationData.status = 'failed';
          this.logAction('application_failed', { reason: 'incomplete' });
        }
        
        // Finalize job log with failure
        jobLogger.logError(jobId, 'Application incomplete', 'Could not complete all steps');
        const logText = jobLogger.finalizeJobLog(jobId, 'FAILED', 'Application incomplete');
        setCurrentJobId(null);
        
        await this.debugSnapshot('application_failed');
        this.sessionStats.failed++;
        stateManager.incrementFailed();
        return { success: false, reason: 'application_incomplete' };
      }
    } catch (error) {
      console.error(`❌ Error applying to ${title}:`, error.message);
      
      // Finalize job log with error
      jobLogger.logError(jobId, error.message, 'Exception during application');
      jobLogger.finalizeJobLog(jobId, 'ERROR', error.message);
      setCurrentJobId(null);
      
      await this.debugSnapshot('error_' + error.message.substring(0, 20).replace(/\s+/g, '_'));
      stateManager.logError(error, { jobId, title, company });
      this.sessionStats.failed++;
      stateManager.incrementFailed();
      await notifyApplicationError(title, company, error.message);
      
      // Close any open modals
      await this.closeModal();
      
      return { success: false, reason: error.message };
    }
  }

  /**
   * Get job description from page
   */
  async getJobDescription() {
    try {
      return await this.page.evaluate(() => {
        const descEl = document.querySelector('.jobs-description, .jobs-box__html-content, [class*="description"]');
        return descEl?.textContent?.trim() || '';
      });
    } catch {
      return '';
    }
  }

  /**
   * Find Easy Apply button - improved with strict matching
   * UPDATED: LinkedIn now uses anchor tags (links) for Easy Apply on job detail pages
   */
  async findEasyApplyButton() {
    console.log(`   Searching for Easy Apply button...`);
    
    // Method 1: Look for ANCHOR TAG with "Easy Apply" text (NEW LinkedIn UI - January 2026)
    // On /jobs/view/ID/ pages, Easy Apply is now an anchor tag with URL containing "/apply/"
    const easyApplyLink = await this.page.evaluate(() => {
      // Look for anchor tags with Easy Apply
      const links = Array.from(document.querySelectorAll('a'));
      for (const link of links) {
        const text = link.textContent?.trim().toLowerCase();
        const href = link.href?.toLowerCase() || '';
        const ariaLabel = link.getAttribute('aria-label')?.toLowerCase() || '';
        
        // Check if it's the Easy Apply link
        if ((text?.includes('easy apply') || ariaLabel?.includes('easy apply')) &&
            href.includes('/apply/') &&
            !text?.includes('premium') && 
            !text?.includes('learning')) {
          return { found: true, type: 'link' };
        }
      }
      return { found: false };
    });
    
    if (easyApplyLink?.found) {
      // Get the actual anchor element
      const links = await this.page.$$('a');
      for (const link of links) {
        const info = await this.page.evaluate(el => ({
          text: el.textContent?.trim().toLowerCase(),
          href: el.href?.toLowerCase() || '',
          ariaLabel: el.getAttribute('aria-label')?.toLowerCase() || ''
        }), link);
        
        if ((info.text?.includes('easy apply') || info.ariaLabel?.includes('easy apply')) &&
            info.href.includes('/apply/') &&
            !info.text?.includes('premium') && 
            !info.text?.includes('learning')) {
          console.log(`   Found Easy Apply LINK (anchor tag) - new LinkedIn UI`);
          return link;
        }
      }
    }
    
    // Method 2: Look for BUTTON with "Easy Apply" text (search results page or older UI)
    const easyApplyByText = await this.page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      for (const btn of buttons) {
        const text = btn.textContent?.trim().toLowerCase();
        const ariaLabel = btn.getAttribute('aria-label')?.toLowerCase() || '';
        
        // Must contain "easy apply" and NOT be a premium/learning button
        if ((text?.includes('easy apply') || ariaLabel?.includes('easy apply')) && 
            !text?.includes('premium') && 
            !text?.includes('learning') &&
            !text?.includes('upgrade')) {
          return true; // Found it
        }
      }
      return false;
    });
    
    if (easyApplyByText) {
      // Get the actual button element
      const buttons = await this.page.$$('button');
      for (const btn of buttons) {
        const info = await this.page.evaluate(el => ({
          text: el.textContent?.trim().toLowerCase(),
          ariaLabel: el.getAttribute('aria-label')?.toLowerCase() || ''
        }), btn);
        
        if ((info.text?.includes('easy apply') || info.ariaLabel?.includes('easy apply')) && 
            !info.text?.includes('premium') && 
            !info.text?.includes('learning')) {
          console.log(`   Found Easy Apply BUTTON by text match`);
          return btn;
        }
      }
    }
    
    // Method 3: Look for specific LinkedIn Easy Apply selectors (buttons AND links)
    const selectors = [
      // Link selectors (new UI)
      'a[href*="/apply/"]',
      'a.jobs-apply-button',
      // Button selectors (search results, older UI)
      'button.jobs-apply-button--top-card',
      'button.jobs-apply-button[aria-label*="Easy Apply"]',
      'button[aria-label*="Easy Apply"]',
      '.jobs-apply-button--top-card button',
      '.jobs-s-apply button[aria-label*="Easy Apply"]',
    ];

    for (const selector of selectors) {
      try {
        const elements = await this.page.$$(selector);
        for (const el of elements) {
          const info = await this.page.evaluate(element => ({
            text: element.textContent?.toLowerCase(),
            ariaLabel: element.getAttribute('aria-label')?.toLowerCase() || '',
            tagName: element.tagName.toLowerCase()
          }), el);
          
          // Verify it's actually Easy Apply
          if (info.text?.includes('easy apply') || info.ariaLabel?.includes('easy apply')) {
            console.log(`   Found Easy Apply ${info.tagName.toUpperCase()} via selector: ${selector}`);
            return el;
          }
        }
      } catch {
        // Continue to next selector
      }
    }
    
    // Method 4: Look in the job details card specifically (buttons AND links)
    const jobCardElement = await this.page.evaluate(() => {
      // Look for the Easy Apply button/link in the job details section
      const jobCard = document.querySelector('.jobs-details, .job-details-jobs-unified-top-card, .jobs-unified-top-card, main');
      if (jobCard) {
        // Check for link first (new UI)
        const link = jobCard.querySelector('a[href*="/apply/"]');
        if (link?.textContent?.toLowerCase().includes('easy apply')) {
          return { found: true, type: 'link' };
        }
        // Check for button (older UI)
        const btn = jobCard.querySelector('button');
        if (btn?.textContent?.toLowerCase().includes('easy apply')) {
          return { found: true, type: 'button' };
        }
      }
      return { found: false };
    });
    
    if (jobCardElement?.found) {
      const jobCard = await this.page.$('.jobs-details, .job-details-jobs-unified-top-card, .jobs-unified-top-card, main');
      if (jobCard) {
        if (jobCardElement.type === 'link') {
          const link = await jobCard.$('a[href*="/apply/"]');
          if (link) {
            console.log(`   Found Easy Apply LINK in job card`);
            return link;
          }
        } else {
          const btn = await jobCard.$('button');
          if (btn) {
            console.log(`   Found Easy Apply BUTTON in job card`);
            return btn;
          }
        }
      }
    }

    console.log(`   No Easy Apply button/link found with any method`);
    return null;
  }

  /**
   * Get the preload iframe that LinkedIn uses for Easy Apply
   * LinkedIn now loads the entire Easy Apply flow inside an iframe at /preload/
   * @returns {Promise<Frame|null>} The preload frame or null if not found
   */
  async getPreloadIframe() {
    const frames = this.page.frames();
    const preloadFrame = frames.find(frame => {
      const url = frame.url();
      return url.includes('/preload/') || url.includes('preload');
    });
    return preloadFrame || null;
  }

  /**
   * Click Easy Apply button inside LinkedIn's preload iframe
   * LinkedIn now loads an intermediate iframe at /preload/ when clicking Easy Apply
   * We need to find and click the actual Easy Apply button inside that iframe
   * @returns {Promise<{clicked: boolean, frame: Frame|null}>} Whether we clicked and the frame reference
   */
  async clickEasyApplyInIframe() {
    try {
      console.log(`   Looking for Easy Apply iframe...`);
      
      // Get all frames
      const frames = this.page.frames();
      console.log(`   Found ${frames.length} frames on page`);
      
      // Find the preload iframe
      const preloadFrame = await this.getPreloadIframe();
      
      if (!preloadFrame) {
        console.log(`   No preload iframe found`);
        return { clicked: false, frame: null };
      }
      
      console.log(`   Found preload iframe: ${preloadFrame.url()}`);
      
      // Store reference to the active frame for modal handling
      this.activeFrame = preloadFrame;
      
      // Wait for the iframe content to load
      await randomSleep(500, 1000);
      
      // Look for Easy Apply button inside the iframe
      const easyApplyButton = await preloadFrame.evaluate(() => {
        // Look for button with Easy Apply text
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          const text = btn.textContent?.toLowerCase() || '';
          const ariaLabel = btn.getAttribute('aria-label')?.toLowerCase() || '';
          
          if (text.includes('easy apply') || ariaLabel.includes('easy apply')) {
            // Click it
            btn.click();
            return { found: true, text: btn.textContent?.trim() };
          }
        }
        
        // Also check for links that might be styled as buttons
        const links = document.querySelectorAll('a');
        for (const link of links) {
          const text = link.textContent?.toLowerCase() || '';
          const href = link.getAttribute('href') || '';
          
          if ((text.includes('easy apply') || href.includes('/apply/')) && !href.includes('guideOverlay')) {
            link.click();
            return { found: true, text: link.textContent?.trim(), isLink: true };
          }
        }
        
        return { found: false };
      });
      
      if (easyApplyButton?.found) {
        console.log(`   ✅ Clicked Easy Apply in iframe: "${easyApplyButton.text}"`);
        return { clicked: true, frame: preloadFrame };
      }
      
      console.log(`   No Easy Apply button found in iframe`);
      return { clicked: false, frame: preloadFrame };
    } catch (error) {
      console.log(`   Error accessing iframe: ${error.message}`);
      return { clicked: false, frame: null };
    }
  }
  
  /**
   * Get the frame context for executing actions
   * UPDATED January 2026: Clicking the Easy Apply LINK directly opens the modal on main page.
   * No iframe interaction needed anymore.
   * @returns {Promise<Page>} The main page (always, since modal is on main page)
   */
  async getActiveContext() {
    // The application modal always appears on the main page
    return this.page;
  }

  /**
   * Wait for Easy Apply modal to appear on the main page
   * OR detect when we're directly on the apply page (after navigating to /apply/ URL)
   * @param {number} timeout - Maximum time to wait in ms
   * @returns {Promise<boolean>} Whether the modal appeared
   */
  async waitForEasyApplyModal(timeout = 8000) {
    const startTime = Date.now();
    const checkInterval = 500;
    
    while (Date.now() - startTime < timeout) {
      // First check if we're on the direct apply page (URL contains /apply/)
      const currentUrl = this.page.url();
      if (currentUrl.includes('/apply/')) {
        console.log(`   ✅ On Easy Apply page (direct navigation)`);
        // Wait a moment for the page to fully load
        await new Promise(r => setTimeout(r, 1000));
        return true;
      }
      
      // Check for Easy Apply modal using multiple detection methods
      const modalFound = await this.page.evaluate(() => {
        const dialogs = document.querySelectorAll('[role="dialog"], .artdeco-modal, .jobs-easy-apply-modal');
        
        for (const dialog of dialogs) {
          const text = dialog.textContent || '';
          const lowerText = text.toLowerCase();
          
          // Exclude messaging widget and other non-Easy Apply dialogs
          if (text.includes('Open Emoji Keyboard') || 
              text.includes('Compose message') ||
              text.includes('Premium features')) {
            continue;
          }
          
          // Check for Easy Apply indicators
          const isEasyApply = 
            dialog.classList.contains('jobs-easy-apply-modal') ||
            dialog.className.includes('easy-apply') ||
            lowerText.includes('contact info') ||
            lowerText.includes('resume') ||
            lowerText.includes('job application progress') ||
            lowerText.includes('continue to next step') ||
            lowerText.includes('submit application') ||
            lowerText.includes('review your application') ||
            (lowerText.includes('apply to') && lowerText.includes('email'));
          
          if (isEasyApply) {
            // Also verify it has the expected buttons
            const buttons = dialog.querySelectorAll('button');
            const buttonTexts = Array.from(buttons).map(b => b.textContent?.trim()?.toLowerCase() || '');
            const hasExpectedButton = buttonTexts.some(t => 
              t.includes('next') || 
              t.includes('continue') || 
              t.includes('submit') || 
              t.includes('review') ||
              t.includes('dismiss')
            );
            
            if (hasExpectedButton) {
              return { found: true, title: dialog.querySelector('h2, h3')?.textContent?.trim() || 'Easy Apply' };
            }
          }
        }
        return { found: false };
      }).catch(() => ({ found: false }));
      
      if (modalFound.found) {
        console.log(`   ✅ Easy Apply modal detected: "${modalFound.title}"`);
        return true;
      }
      
      await new Promise(r => setTimeout(r, checkInterval));
    }
    
    return false;
  }

  /**
   * Handle Easy Apply modal (or direct apply page)
   */
  async handleEasyApplyModal() {
    const maxSteps = 10;
    let step = 0;
    const jobId = this.applicationData?.jobId;

    console.log('📝 Starting Easy Apply modal handler...');
    this.logAction('modal_started', { maxSteps });
    if (jobId) jobLogger.logSection(jobId, 'Easy Apply Modal');
    
    // Check if we're on a direct apply page (URL contains /apply/)
    const isDirectApplyPage = this.page.url().includes('/apply/');
    if (isDirectApplyPage) {
      console.log(`   📍 Direct apply page detected - application form is embedded in page`);
    }

    while (step < maxSteps) {
      step++;
      console.log(`\n--- Step ${step}/${maxSteps} ---`);
      this.logAction('step_started', { step, maxSteps });
      await randomSleep(1500, 2500);
      
      // Take debug snapshot at each step
      await this.debugSnapshot(`modal_step_${step}`);

      // The form appears on main page (either as modal or directly on /apply/ page)
      const context = this.page;
      console.log(`   Looking for application form on main page...`);

      // Find the application form container
      // Works for both modal dialogs AND direct /apply/ page
      const formContainer = await context.evaluate(() => {
        // First try: dialog/modal (traditional flow)
        const dialogs = document.querySelectorAll('[role="dialog"], .artdeco-modal, .jobs-easy-apply-modal');
        
        for (const dialog of dialogs) {
          const text = dialog.textContent || '';
          const lowerText = text.toLowerCase();
          
          // Exclude messaging widget
          if (text.includes('Open Emoji Keyboard') || text.includes('Compose message')) {
            continue;
          }
          
          // Method 1: Check for Easy Apply modal by class name
          if (dialog.classList.contains('jobs-easy-apply-modal') || 
              dialog.className.includes('easy-apply')) {
            return { found: true, method: 'class-match' };
          }
          
          // Method 2: Check for presence of Easy Apply buttons (Next/Submit/Review)
          const buttons = dialog.querySelectorAll('button');
          const buttonTexts = Array.from(buttons).map(b => b.textContent?.trim()?.toLowerCase() || '');
          const hasEasyApplyButtons = buttonTexts.some(t => 
            t.includes('next') || 
            t.includes('continue') || 
            t.includes('submit application') ||
            t.includes('review')
          );
          // Also check if there's a Dismiss button (typical for Easy Apply modal)
          const hasDismiss = buttonTexts.some(t => t.includes('dismiss'));
          
          if (hasEasyApplyButtons && hasDismiss) {
            return { found: true, method: 'button-match' };
          }
          
          // Method 3: Check for Easy Apply text content indicators
          if (lowerText.includes('job application progress') || 
              lowerText.includes('continue to next step') ||
              lowerText.includes('submit application') ||
              lowerText.includes('review your application') ||
              lowerText.includes('contact info') ||
              (lowerText.includes('apply to') && lowerText.includes('email address'))) {
            return { found: true, method: 'text-match' };
          }
        }
        
        // Second try: Direct apply page (URL contains /apply/)
        // The form is embedded directly on the page, not in a modal
        if (window.location.href.includes('/apply/')) {
          // Look for the application form container on the page
          const applyContainers = document.querySelectorAll('.jobs-easy-apply-content, .artdeco-card, main form, [class*="apply"]');
          for (const container of applyContainers) {
            const text = container.textContent || '';
            const lowerText = text.toLowerCase();
            const buttons = container.querySelectorAll('button');
            const buttonTexts = Array.from(buttons).map(b => b.textContent?.trim()?.toLowerCase() || '');
            
            const hasApplyButtons = buttonTexts.some(t => 
              t.includes('next') || 
              t.includes('continue') || 
              t.includes('submit') || 
              t.includes('review')
            );
            
            if (hasApplyButtons || lowerText.includes('contact info') || 
                lowerText.includes('resume') || lowerText.includes('application')) {
              return { found: true, method: 'direct-apply-page' };
            }
          }
        }
        
        return { found: false };
      });
      
      if (formContainer?.found) {
        console.log(`✅ Application form detected via ${formContainer.method}`);
      }

      // Check for "Save this application?" dialog which means modal was dismissed
      // Dialog appears on main page
      let saveDialog = await this.page.evaluate(() => {
        const dialogs = document.querySelectorAll('[role="alertdialog"], [role="dialog"]');
        for (const dialog of dialogs) {
          const text = dialog.textContent || '';
          if (text.includes('Save this application')) {
            return { found: true, text: 'Save this application?' };
          }
        }
        return { found: false };
      }).catch(() => ({ found: false }));
      
      if (saveDialog?.found) {
        console.log('⚠️ "Save this application?" dialog detected - modal was dismissed accidentally');
        // Click Discard button on main page
        await this.page.evaluate(() => {
          const buttons = document.querySelectorAll('button');
          for (const btn of buttons) {
            if (btn.textContent?.toLowerCase().includes('discard')) {
              btn.click();
              return;
            }
          }
        }).catch(() => {});
        await randomSleep(1500, 2000);
        
        // Try to click Easy Apply again on main page
        const easyApplyBtn = await this.findEasyApplyButton();
        if (easyApplyBtn) {
          await this.page.evaluate(el => el.click(), easyApplyBtn);
          await randomSleep(2000, 2500);
        }
        continue; // Retry this step
      }

      if (!formContainer?.found) {
        console.log('⚠️ Application form not found, checking if application succeeded...');
        if (await this.checkApplicationSuccess()) {
          return true;
        }
        console.log('❌ Form disappeared without success');
        return false;
      }

      // Log current form state - get headings from any visible form with Easy Apply buttons
      const modalText = await context.evaluate(() => {
        // First try dialogs
        const dialogs = document.querySelectorAll('[role="dialog"], .artdeco-modal, .jobs-easy-apply-modal');
        for (const dialog of dialogs) {
          // Find modal with Dismiss/Next buttons (Easy Apply indicators)
          const buttons = dialog.querySelectorAll('button');
          const buttonTexts = Array.from(buttons).map(b => b.textContent?.trim()?.toLowerCase() || '');
          const hasEasyApplyButtons = buttonTexts.some(t => 
            t.includes('next') || t.includes('continue') || t.includes('submit') || t.includes('review')
          );
          
          if (hasEasyApplyButtons) {
            const headings = dialog.querySelectorAll('h2, h3, .artdeco-modal__header');
            return Array.from(headings).map(h => h.textContent?.trim()).filter(Boolean).join(' | ') || 'Easy Apply Step';
          }
        }
        
        // Fallback: try direct apply page
        if (window.location.href.includes('/apply/')) {
          const headings = document.querySelectorAll('h1, h2, h3, .artdeco-card h2');
          return Array.from(headings).slice(0, 3).map(h => h.textContent?.trim()).filter(Boolean).join(' | ') || 'Apply Page';
        }
        
        return 'Unknown form state';
      });
      console.log(`📋 Modal state: ${modalText}`);
      
      // Log step to job logger
      if (jobId) jobLogger.logStep(jobId, step, maxSteps, modalText);

      // Check for success
      if (await this.checkApplicationSuccess()) {
        return true;
      }

      // Check for errors
      const hasError = await elementExists(this.page, config.selectors.easyApply.errorMessage);
      if (hasError) {
        console.log('⚠️ Form has errors, attempting to fix...');
      }

      // Fill any form fields
      await this.fillFormFields();

      // Handle checkboxes (consent, etc.)
      await this.handleCheckboxes();

      // Try to proceed - check Submit first (final step)
      if (await this.tryClickSubmit()) {
        console.log('🚀 Clicked Submit, waiting for result...');
        this.logAction('button_clicked', { button: 'submit', step });
        await randomSleep(2000, 3000);
        if (await this.checkApplicationSuccess()) {
          this.logAction('application_success', { step });
          if (this.applicationData) this.applicationData.totalSteps = step;
          return true;
        }
        // If submit didn't lead to success, might be validation error
        continue;
      }

      // Try Review (step before Submit)
      if (await this.tryClickReview()) {
        console.log('📋 Clicked Review, moving to next step...');
        this.logAction('button_clicked', { button: 'review', step });
        continue;
      }

      // Try Next/Continue
      if (await this.tryClickNext()) {
        console.log('➡️ Clicked Next, moving to next step...');
        this.logAction('button_clicked', { button: 'next', step });
        continue;
      }

      // No progress made - log available buttons for debugging
      const availableButtons = await context.evaluate(() => {
        const dialogs = document.querySelectorAll('[role="dialog"], .artdeco-modal, .jobs-easy-apply-modal');
        for (const dialog of dialogs) {
          const text = dialog.textContent || '';
          
          // Exclude messaging widget
          if (text.includes('Open Emoji Keyboard') || text.includes('Compose message')) {
            continue;
          }
          
          const btns = dialog.querySelectorAll('button');
          const buttonTexts = Array.from(btns).map(b => b.textContent?.trim()?.toLowerCase() || '');
          const hasDismiss = buttonTexts.some(t => t.includes('dismiss'));
          const hasEasyApplyButtons = buttonTexts.some(t => 
            t.includes('next') || t.includes('continue') || t.includes('submit') || t.includes('review')
          );
          
          if (hasDismiss || hasEasyApplyButtons) {
            return Array.from(btns).map(b => ({
              text: b.textContent?.trim()?.substring(0, 50),
              disabled: b.disabled,
              ariaLabel: b.getAttribute('aria-label'),
            }));
          }
        }
        return ['No Easy Apply modal found'];
      });
      console.log('⚠️ Could not proceed. Available buttons:', JSON.stringify(availableButtons, null, 2));
    }

    console.log('❌ Application did not complete after max steps');
    await this.closeModal();
    return false;
  }

  /**
   * Fill form fields intelligently - based on Python bot's answer_questions pattern
   * Finds form elements within the Easy Apply modal and fills them appropriately
   */
  async fillFormFields() {
    console.log('📝 Scanning for form fields...');
    
    // Get the active context (iframe or main page)
    const context = await this.getActiveContext();
    const isInIframe = context !== this.page;
    
    // Find the Easy Apply modal first - in the correct context
    const modalSelector = '.jobs-easy-apply-modal, [role="dialog"]:not(:has(.msg-overlay-list-bubble))';
    const modal = isInIframe 
      ? await context.$(modalSelector)
      : await this.page.$(modalSelector);
      
    if (!modal) {
      console.log('⚠️ No Easy Apply modal found for form filling');
      return;
    }
    
    // Get all form element groups - LinkedIn uses these data attributes
    // Similar to Python's: ".//div[@data-test-form-element]"
    const formGroups = await modal.$$('[data-test-form-element], .fb-form-element, .jobs-easy-apply-form-element, .artdeco-text-input, .fb-dash-form-element');
    console.log(`   Found ${formGroups.length} form element groups`);

    for (const group of formGroups) {
      try {
        // Get label text for this form group - use appropriate context for evaluate
        const evaluateContext = isInIframe ? context : this.page;
        const label = await evaluateContext.evaluate(el => {
          // Try multiple selectors for labels
          const labelSelectors = [
            'label span',
            'label',
            '.fb-form-element-label',
            '.artdeco-text-input--label',
            '[data-test-form-element-label]',
            '.jobs-easy-apply-form-element__label',
          ];
          for (const sel of labelSelectors) {
            const labelEl = el.querySelector(sel);
            if (labelEl) return labelEl.textContent?.trim() || '';
          }
          // Fallback: check for nearby label
          const parent = el.closest('.fb-dash-form-element') || el.parentElement;
          const parentLabel = parent?.querySelector('label');
          return parentLabel?.textContent?.trim() || '';
        }, group);

        if (label) {
          console.log(`   📋 Form field: "${label.substring(0, 50)}${label.length > 50 ? '...' : ''}"`);
        }

        // Skip file inputs (resume upload) - LinkedIn already has our resume
        const fileInput = await group.$('input[type="file"]');
        if (fileInput) {
          if (config.bot.skipResumeUpload) {
            console.log('   ⏭️ Skipping resume upload');
          }
          continue;
        }

        // Handle DROPDOWNS (select elements) - common for country, experience level
        const select = await group.$('select');
        if (select) {
          await this.handleDropdown(select, label);
          continue;
        }

        // Handle RADIO BUTTONS - common for Yes/No questions
        const radioContainer = await group.$('fieldset, [role="radiogroup"]');
        if (radioContainer) {
          const radios = await radioContainer.$$('input[type="radio"]');
          if (radios.length > 0) {
            await this.handleRadioButtons(radioContainer, radios, label);
            continue;
          }
        }

        // Handle TEXT INPUTS - location, phone, etc.
        const textInput = await group.$('input[type="text"], input[type="tel"], input[type="email"], input[type="number"]');
        if (textInput) {
          await this.handleTextInput(textInput, label);
          continue;
        }

        // Handle TEXTAREAS - cover letter, additional info
        const textarea = await group.$('textarea');
        if (textarea) {
          await this.handleTextarea(textarea, label);
          continue;
        }
      } catch (e) {
        console.log(`   ⚠️ Error processing form field: ${e.message}`);
      }
    }
  }

  /**
   * Get current job context for AI
   */
  getJobContext() {
    return {
      title: this.currentJobTitle || '',
      company: this.currentCompany || '',
      description: this.currentJobDescription || '',
    };
  }

  /**
   * Handle text input field with potential autocomplete (like location/city)
   */
  async handleTextInput(input, label) {
    const jobId = this.applicationData?.jobId;
    const currentValue = await this.page.evaluate(el => el.value, input);
    
    // Check if input is in a disabled/readonly state
    const isDisabled = await this.page.evaluate(el => el.disabled || el.readOnly, input);
    if (isDisabled) {
      console.log(`   ⏭️ Skipping disabled field: ${label}`);
      return;
    }
    
    if (currentValue) {
      console.log(`   ✓ Already filled: ${label} = "${currentValue.substring(0, 30)}"`);
      this.logFormField('text_input', label, currentValue, 'already_filled');
      if (jobId) jobLogger.logFormField(jobId, { fieldType: 'text_input', label, currentValue, action: 'already_filled' });
      return;
    }

    // Get appropriate answer for this field
    // Priority: 1) Cached/Verified answers 2) Preset answers 3) AI
    let answer = null;
    let answerSource = 'unknown';
    
    // 1. Check cache first (includes user-verified corrections)
    const cached = answerCache.getCachedAnswer(label);
    if (cached) {
      answer = cached.answer;
      answerSource = cached.source; // 'verified' or 'cached'
      if (jobId) jobLogger.logAIRequest(jobId, {
        question: label,
        questionType: 'text',
        source: answerSource,
        cachedAnswer: answer,
      });
    }
    
    // 2. Check preset answers (name, phone, basic info)
    if (!answer) {
      const presetAnswer = getPresetAnswer(label);
      if (presetAnswer) {
        answer = presetAnswer;
        answerSource = 'preset';
        if (jobId) jobLogger.logAIRequest(jobId, {
          question: label,
          questionType: 'text',
          presetAnswer,
        });
      }
    }
    
    // 3. Fall back to AI
    if (!answer) {
      answer = await answerQuestion(label, null, this.getJobContext());
      answerSource = 'ai';
    }
    
    if (!answer) {
      console.log(`   ⚠️ No answer found for: ${label}`);
      this.logFormField('text_input', label, null, 'no_answer');
      if (jobId) jobLogger.logWarning(jobId, `No answer found for: ${label}`);
      return;
    }

    // Check if this is a location/city field with autocomplete
    const isLocationField = label.toLowerCase().includes('city') || 
                           label.toLowerCase().includes('location') ||
                           label.toLowerCase().includes('address') ||
                           label.toLowerCase().includes('where');
    
    // Clear and type the answer
    await input.click({ clickCount: 3 });
    await randomSleep(200, 400);
    await input.type(answer, { delay: 80 });
    console.log(`   ✅ Filled: ${label} = "${answer}" (${answerSource})`);
    this.logFormField('text_input', label, answer, 'typed');
    
    // Record to questions history for dashboard review
    answerCache.recordToHistory({
      question: label,
      answer,
      source: answerSource,
      fieldType: 'text_input',
      jobId,
      company: this.applicationData?.company || '',
      jobTitle: this.applicationData?.title || '',
    });
    
    // Cache the answer if not already cached (for future applications)
    if (answerSource !== 'verified' && answerSource !== 'cached') {
      answerCache.cacheAnswer(label, answer, answerSource, 'text');
    }
    
    // Handle autocomplete dropdown for location fields
    if (isLocationField) {
      console.log(`   🔍 Waiting for location autocomplete suggestions...`);
      await randomSleep(1500, 2000);  // Wait for autocomplete suggestions to load
      
      // Try multiple selectors for autocomplete dropdown
      const autocompleteSelectors = [
        '.basic-typeahead__selectable',
        '[role="listbox"] [role="option"]',
        '.search-typeahead-v2__hit',
        '.fb-single-typeahead-entity',
        '.artdeco-typeahead__result',
        'div[data-basic-typeahead-option]',
      ];
      
      let selectedOption = false;
      for (const selector of autocompleteSelectors) {
        const options = await this.page.$$(selector);
        if (options.length > 0) {
          // Click the first option which should be the best match
          try {
            await options[0].click();
            selectedOption = true;
            const optionText = await this.page.evaluate(el => el.textContent?.trim()?.substring(0, 50), options[0]);
            console.log(`   ✅ Selected autocomplete: "${optionText}"`);
            break;
          } catch (e) {
            console.log(`   ⚠️ Failed to click option with ${selector}: ${e.message}`);
          }
        }
      }
      
      if (!selectedOption) {
        // Try pressing down arrow and enter as fallback
        console.log(`   ⚠️ No autocomplete dropdown found, trying keyboard navigation...`);
        await this.page.keyboard.press('ArrowDown');
        await randomSleep(300, 500);
        await this.page.keyboard.press('Enter');
      }
      
      await randomSleep(500, 800);
    }
  }

  /**
   * Handle textarea field
   */
  async handleTextarea(textarea, label) {
    const currentValue = await this.page.evaluate(el => el.value, textarea);
    if (currentValue) {
      console.log(`   ✓ Already filled: ${label}`);
      this.logFormField('textarea', label, currentValue.substring(0, 100), 'already_filled');
      return;
    }

    const answer = getPresetAnswer(label) || await answerQuestion(label, null, this.getJobContext());
    if (answer) {
      await textarea.click({ clickCount: 3 });
      await textarea.type(answer, { delay: 30 });
      console.log(`   ✅ Filled textarea: ${label}`);
      this.logFormField('textarea', label, answer, 'typed');
    } else {
      this.logFormField('textarea', label, null, 'no_answer');
    }
  }

  /**
   * Handle dropdown/select field
   */
  async handleDropdown(select, label) {
    const jobId = this.applicationData?.jobId;
    
    // Get current selection
    const currentSelection = await this.page.evaluate(el => {
      const selectedOption = el.options[el.selectedIndex];
      return selectedOption?.text || '';
    }, select);
    
    // Get all options
    const options = await this.page.evaluate(el => {
      return Array.from(el.options).map(o => ({ value: o.value, text: o.text }));
    }, select);
    
    const optionTexts = options.map(o => o.text);
    
    // Skip if already selected a real option (not placeholder)
    if (currentSelection && !currentSelection.toLowerCase().includes('select') && options.length > 1) {
      console.log(`   ✓ Already selected: ${label} = "${currentSelection}"`);
      this.logFormField('dropdown', label, currentSelection, 'already_selected', optionTexts);
      if (jobId) jobLogger.logFormField(jobId, { fieldType: 'dropdown', label, currentValue: currentSelection, action: 'already_selected' });
      return;
    }

    if (options.length <= 1) return;

    // Get appropriate answer - Priority: 1) Cache 2) Preset 3) AI
    let answer = null;
    let answerSource = 'unknown';
    
    // 1. Check cache first (includes user-verified corrections)
    const cached = answerCache.getCachedAnswer(label, optionTexts);
    if (cached) {
      answer = cached.answer;
      answerSource = cached.source;
      if (jobId) jobLogger.logAIRequest(jobId, {
        question: label,
        questionType: 'multiple_choice',
        options: optionTexts,
        source: answerSource,
        cachedAnswer: answer,
      });
    }
    
    // 2. Check preset answers
    if (!answer) {
      const presetAnswer = getPresetAnswer(label);
      if (presetAnswer) {
        answer = presetAnswer;
        answerSource = 'preset';
        if (jobId) jobLogger.logAIRequest(jobId, {
          question: label,
          questionType: 'multiple_choice',
          options: optionTexts,
          presetAnswer,
        });
      }
    }
    
    // 3. Fall back to AI
    if (!answer) {
      answer = await answerQuestion(label, optionTexts, this.getJobContext());
      answerSource = 'ai';
    }
    
    if (answer) {
      // Find best matching option
      const matchOption = options.find(o => 
        o.text.toLowerCase() === answer.toLowerCase() ||
        o.text.toLowerCase().includes(answer.toLowerCase()) ||
        answer.toLowerCase().includes(o.text.toLowerCase())
      );
      
      if (matchOption && matchOption.value) {
        await select.select(matchOption.value);
        console.log(`   ✅ Selected: ${label} = "${matchOption.text}" (${answerSource})`);
        this.logFormField('dropdown', label, matchOption.text, 'selected', optionTexts);
        
        // Record to history and cache
        answerCache.recordToHistory({
          question: label,
          answer: matchOption.text,
          source: answerSource,
          fieldType: 'dropdown',
          jobId,
          company: this.applicationData?.company || '',
          jobTitle: this.applicationData?.title || '',
          options: optionTexts,
        });
        
        // Cache if not already cached
        if (answerSource !== 'verified' && answerSource !== 'cached') {
          answerCache.cacheAnswer(label, matchOption.text, answerSource, 'choice');
        }
      } else {
        // If no match, select first non-placeholder option
        const firstRealOption = options.find(o => o.value && !o.text.toLowerCase().includes('select'));
        if (firstRealOption) {
          await select.select(firstRealOption.value);
          console.log(`   ⚡ Default selected: ${label} = "${firstRealOption.text}"`);
          this.logFormField('dropdown', label, firstRealOption.text, 'default_selected', optionTexts);
          
          // Record to history (but don't cache default selections)
          answerCache.recordToHistory({
            question: label,
            answer: firstRealOption.text,
            source: 'default',
            fieldType: 'dropdown',
            jobId,
            company: this.applicationData?.company || '',
            jobTitle: this.applicationData?.title || '',
            options: optionTexts,
          });
        }
      }
    }
  }

  /**
   * Handle radio button group
   */
  async handleRadioButtons(container, radios, label) {
    const jobId = this.applicationData?.jobId;
    
    // Check if already selected
    const isChecked = await this.page.evaluate(
      els => els.some(el => el.checked),
      radios
    );
    
    // Get radio labels
    const radioLabels = await this.page.evaluate(cont => {
      const labels = cont.querySelectorAll('label');
      return Array.from(labels).map(l => l.textContent?.trim() || '');
    }, container);
    
    if (isChecked) {
      const checkedLabel = await this.page.evaluate((els, labels) => {
        for (let i = 0; i < els.length; i++) {
          if (els[i].checked) return labels[i] || 'unknown';
        }
        return 'unknown';
      }, radios, radioLabels);
      console.log(`   ✓ Already answered: ${label}`);
      this.logFormField('radio', label, checkedLabel, 'already_selected', radioLabels);
      if (jobId) jobLogger.logFormField(jobId, { fieldType: 'radio', label, currentValue: checkedLabel, action: 'already_selected' });
      return;
    }

    // Get appropriate answer - Priority: 1) Cache 2) Preset 3) AI
    let answer = null;
    let answerSource = 'unknown';
    
    // 1. Check cache first (includes user-verified corrections)
    const cached = answerCache.getCachedAnswer(label, radioLabels);
    if (cached) {
      answer = cached.answer;
      answerSource = cached.source;
      if (jobId) jobLogger.logAIRequest(jobId, {
        question: label,
        questionType: 'multiple_choice',
        options: radioLabels,
        source: answerSource,
        cachedAnswer: answer,
      });
    }
    
    // 2. Check preset answers
    if (!answer) {
      const presetAnswer = getPresetAnswer(label);
      if (presetAnswer) {
        answer = presetAnswer;
        answerSource = 'preset';
        if (jobId) jobLogger.logAIRequest(jobId, {
          question: label,
          questionType: 'multiple_choice',
          options: radioLabels,
          presetAnswer,
        });
      }
    }
    
    // 3. Fall back to AI
    if (!answer) {
      answer = await answerQuestion(label, radioLabels, this.getJobContext());
      answerSource = 'ai';
    }
    
    if (answer) {
      // Find matching radio button
      for (let i = 0; i < radios.length; i++) {
        const radioLabel = radioLabels[i] || '';
        if (radioLabel.toLowerCase().includes(answer.toLowerCase()) ||
            answer.toLowerCase().includes(radioLabel.toLowerCase()) ||
            (answer.toLowerCase() === 'yes' && radioLabel.toLowerCase().includes('yes')) ||
            (answer.toLowerCase() === 'no' && radioLabel.toLowerCase().includes('no'))) {
          await radios[i].click();
          console.log(`   ✅ Selected radio: ${label} = "${radioLabel}" (${answerSource})`);
          this.logFormField('radio', label, radioLabel, 'selected', radioLabels);
          if (jobId) jobLogger.logFormField(jobId, { fieldType: 'radio', label, newValue: radioLabel, action: 'selected' });
          
          // Record to history and cache
          answerCache.recordToHistory({
            question: label,
            answer: radioLabel,
            source: answerSource,
            fieldType: 'radio',
            jobId,
            company: this.applicationData?.company || '',
            jobTitle: this.applicationData?.title || '',
            options: radioLabels,
          });
          
          // Cache if not already cached
          if (answerSource !== 'verified' && answerSource !== 'cached') {
            answerCache.cacheAnswer(label, radioLabel, answerSource, 'choice');
          }
          return;
        }
      }
    }
    
    // Default: select first option
    if (radios.length > 0) {
      await radios[0].click();
      console.log(`   ⚡ Default selected first radio option for: ${label}`);
      this.logFormField('radio', label, radioLabels[0] || 'first', 'default_selected', radioLabels);
      
      // Record to questions history
      answerCache.recordToHistory({
        question: label,
        answer: radioLabels[0] || 'first',
        source: 'default',
        fieldType: 'radio',
        jobId,
        company: this.applicationData?.company || '',
        jobTitle: this.applicationData?.title || '',
        options: radioLabels,
      });
    }
  }

  /**
   * Handle checkboxes (consent, terms, privacy notices, etc.)
   * CRITICAL: Must check ALL unchecked checkboxes for applications to succeed
   * Python bot always clicks unchecked checkboxes regardless of required status
   */
  async handleCheckboxes() {
    console.log('☑️ Checking for checkboxes...');
    
    // Find the Easy Apply modal
    const modalSelector = '.jobs-easy-apply-modal, [role="dialog"]:not(:has(.msg-overlay-list-bubble))';
    const modal = await this.page.$(modalSelector);
    if (!modal) return;
    
    // Get all checkboxes in the modal
    const checkboxes = await modal.$$('input[type="checkbox"]');
    console.log(`   Found ${checkboxes.length} checkbox(es)`);
    
    for (const checkbox of checkboxes) {
      try {
        const isChecked = await this.page.evaluate(el => el.checked, checkbox);
        const checkboxId = await this.page.evaluate(el => el.id || el.name || 'unnamed', checkbox);
        
        // Get the label for this checkbox
        const labelText = await this.page.evaluate(el => {
          // Try finding associated label
          const id = el.id;
          if (id) {
            const label = document.querySelector(`label[for="${id}"]`);
            if (label) return label.textContent?.trim();
          }
          // Try parent label
          const parentLabel = el.closest('label');
          if (parentLabel) return parentLabel.textContent?.trim();
          // Try sibling label
          const siblingLabel = el.parentElement?.querySelector('label');
          if (siblingLabel) return siblingLabel.textContent?.trim();
          return '';
        }, checkbox);
        
        const labelLower = (labelText || '').toLowerCase();
        
        // Handle "Follow" checkboxes - UNCHECK them if checked (user doesn't want to follow companies)
        if (labelLower.includes('follow') && !labelLower.includes('up')) {
          if (isChecked) {
            // Uncheck the Follow checkbox
            await this.page.evaluate(el => {
              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, checkbox);
            await randomSleep(200, 400);
            
            const unchecked = await this.page.evaluate(el => {
              try {
                const id = el.id;
                if (id) {
                  const label = document.querySelector(`label[for="${id}"]`);
                  if (label) {
                    label.click();
                    return true;
                  }
                }
                el.click();
                return true;
              } catch {
                return false;
              }
            }, checkbox);
            
            if (unchecked) {
              console.log(`   ❌ Unchecked Follow: "${labelText?.substring(0, 50)}"`);
              this.logFormField('checkbox', labelText, false, 'unchecked');
            }
            await randomSleep(200, 400);
          } else {
            console.log(`   ⏭️ Follow already unchecked: "${labelText?.substring(0, 50)}"`);
            this.logFormField('checkbox', labelText, false, 'already_unchecked');
          }
          continue;
        }
        
        if (!isChecked) {
          // Use AI to decide whether to check this checkbox
          let shouldCheck = false;
          
          try {
            const jobContext = this.getJobContext();
            const aiDecision = await answerCheckboxQuestion(labelText, jobContext);
            shouldCheck = aiDecision.toLowerCase().trim() === 'true';
            console.log(`   🤖 AI decision for "${labelText?.substring(0, 40)}...": ${shouldCheck ? 'CHECK' : 'SKIP'}`);
          } catch (aiError) {
            console.log(`   ⚠️ AI error, skipping checkbox: ${aiError.message}`);
            shouldCheck = false;
          }
          
          if (!shouldCheck) {
            console.log(`   ⏭️ Skipping (AI said no): "${labelText?.substring(0, 50)}"`);
            this.logFormField('checkbox', labelText, false, 'skipped_by_ai');
            continue;
          }
          
          // Click the checkbox - using JavaScript click for reliability
          await this.page.evaluate(el => {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }, checkbox);
          await randomSleep(200, 400);
          
          // Try clicking the label first (more reliable), then the checkbox
          const clicked = await this.page.evaluate(el => {
            try {
              const id = el.id;
              if (id) {
                const label = document.querySelector(`label[for="${id}"]`);
                if (label) {
                  label.click();
                  return true;
                }
              }
              // Click checkbox directly
              el.click();
              return true;
            } catch {
              return false;
            }
          }, checkbox);
          
          if (clicked) {
            const labelPreview = labelText ? labelText.substring(0, 50) : checkboxId;
            console.log(`   ✅ Checked: "${labelPreview}${labelText?.length > 50 ? '...' : ''}"`);
            this.logFormField('checkbox', labelText, true, 'checked');
          }
          
          await randomSleep(200, 400);
        } else {
          console.log(`   ✓ Already checked: ${(labelText || checkboxId).substring(0, 50)}`);
          this.logFormField('checkbox', labelText || checkboxId, true, 'already_checked');
        }
      } catch (e) {
        console.log(`   ⚠️ Error handling checkbox: ${e.message}`);
      }
    }
  }

  /**
   * Get the Easy Apply modal element (not the messaging widget)
   * Returns the modal element or null if not found
   */
  async getEasyApplyModal() {
    return await this.page.evaluateHandle(() => {
      const dialogs = document.querySelectorAll('[role="dialog"], .artdeco-modal, .jobs-easy-apply-modal');
      for (const dialog of dialogs) {
        const text = dialog.textContent || '';
        // The Easy Apply modal contains these specific texts
        if (text.includes('job application progress') || 
            text.includes('Your job application progress') ||
            text.includes('Submit application') ||
            text.includes('Continue to next step') ||
            text.includes('Review your application') ||
            text.includes('Apply to')) {
          // Make sure it's not the messaging widget
          if (!text.includes('Open Emoji Keyboard') && !text.includes('Compose message')) {
            return dialog;
          }
        }
      }
      return null;
    });
  }

  /**
   * Try to click Submit button
   * LinkedIn uses: "Submit application" as button text (not aria-label)
   */
  async tryClickSubmit() {
    // Get the active context (iframe or main page)
    const context = await this.getActiveContext();
    
    // Get buttons from ANY visible Easy Apply modal 
    const buttons = await context.evaluate(() => {
      const dialogs = document.querySelectorAll('[role="dialog"], .artdeco-modal, .jobs-easy-apply-modal');
      for (const dialog of dialogs) {
        const text = dialog.textContent || '';
        
        // Exclude messaging widget
        if (text.includes('Open Emoji Keyboard') || text.includes('Compose message')) {
          continue;
        }
        
        const btns = dialog.querySelectorAll('button');
        const buttonTexts = Array.from(btns).map(b => b.textContent?.trim()?.toLowerCase() || '');
        const hasDismiss = buttonTexts.some(t => t.includes('dismiss'));
        const hasEasyApplyButtons = buttonTexts.some(t => 
          t.includes('next') || t.includes('continue') || t.includes('submit') || t.includes('review')
        );
        
        if (hasDismiss || hasEasyApplyButtons) {
          return Array.from(btns).map((b, idx) => ({
            idx,
            text: b.textContent?.trim() || '',
            disabled: b.disabled,
            ariaLabel: b.getAttribute('aria-label') || '',
          }));
        }
      }
      return [];
    }).catch(() => []);
    
    // Priority 1: Exact match "Submit application"
    for (const btnInfo of buttons) {
      if (btnInfo.text === 'Submit application' && !btnInfo.disabled) {
        console.log('✅ Found "Submit application" button');
        const success = await this.clickModalButtonByIndex(btnInfo.idx);
        if (success) return true;
      }
    }
    
    // Priority 2: aria-label match
    for (const btnInfo of buttons) {
      if (btnInfo.ariaLabel.includes('Submit application') && !btnInfo.disabled) {
        console.log('✅ Found Submit button via aria-label');
        const success = await this.clickModalButtonByIndex(btnInfo.idx);
        if (success) return true;
      }
    }

    // Priority 3: Fuzzy text match (but not "review" buttons)
    for (const btnInfo of buttons) {
      const text = btnInfo.text.toLowerCase();
      if (text.includes('submit') && !text.includes('review') && !btnInfo.disabled) {
        console.log(`✅ Found submit button via fuzzy match: "${btnInfo.text}"`);
        const success = await this.clickModalButtonByIndex(btnInfo.idx);
        if (success) return true;
      }
    }

    return false;
  }

  /**
   * Try to click Review button
   * LinkedIn uses: "Review" or "Review your application" as button text
   */
  async tryClickReview() {
    // Get the active context (iframe or main page)
    const context = await this.getActiveContext();
    
    // Get buttons from ANY visible Easy Apply modal 
    const buttons = await context.evaluate(() => {
      const dialogs = document.querySelectorAll('[role="dialog"], .artdeco-modal, .jobs-easy-apply-modal');
      for (const dialog of dialogs) {
        const text = dialog.textContent || '';
        
        // Exclude messaging widget
        if (text.includes('Open Emoji Keyboard') || text.includes('Compose message')) {
          continue;
        }
        
        const btns = dialog.querySelectorAll('button');
        const buttonTexts = Array.from(btns).map(b => b.textContent?.trim()?.toLowerCase() || '');
        const hasDismiss = buttonTexts.some(t => t.includes('dismiss'));
        const hasEasyApplyButtons = buttonTexts.some(t => 
          t.includes('next') || t.includes('continue') || t.includes('submit') || t.includes('review')
        );
        
        if (hasDismiss || hasEasyApplyButtons) {
          return Array.from(btns).map((b, idx) => ({
            idx,
            text: b.textContent?.trim() || '',
            disabled: b.disabled,
            ariaLabel: b.getAttribute('aria-label') || '',
          }));
        }
      }
      return [];
    }).catch(() => []);
    
    // Priority 1: Exact match "Review" (new LinkedIn UI)
    for (const btnInfo of buttons) {
      if (btnInfo.text === 'Review' && !btnInfo.disabled) {
        console.log('✅ Found "Review" button');
        const success = await this.clickModalButtonByIndex(btnInfo.idx);
        if (success) return true;
      }
    }
    
    // Priority 2: Exact match "Review your application" (legacy LinkedIn UI)
    for (const btnInfo of buttons) {
      if (btnInfo.text === 'Review your application' && !btnInfo.disabled) {
        console.log('✅ Found "Review your application" button');
        const success = await this.clickModalButtonByIndex(btnInfo.idx);
        if (success) return true;
      }
    }
    
    // Priority 3: aria-label match
    for (const btnInfo of buttons) {
      const ariaLower = btnInfo.ariaLabel.toLowerCase();
      if ((ariaLower.includes('review your application') || ariaLower === 'review') && !btnInfo.disabled) {
        console.log(`✅ Found Review button via aria-label: "${btnInfo.ariaLabel}"`);
        const success = await this.clickModalButtonByIndex(btnInfo.idx);
        if (success) return true;
      }
    }

    // Priority 4: Fuzzy text match (but not "Mark feedback", edit buttons, or Next)
    for (const btnInfo of buttons) {
      const text = btnInfo.text.toLowerCase();
      if (text.includes('review') && 
          !text.includes('mark') && 
          !text.includes('edit') && 
          !text.includes('next') && 
          !btnInfo.disabled) {
        console.log(`✅ Found review button via fuzzy match: "${btnInfo.text}"`);
        const success = await this.clickModalButtonByIndex(btnInfo.idx);
        if (success) return true;
      }
    }

    return false;
  }

  /**
   * Try to click Next button
   * LinkedIn uses: "Next" or "Continue to next step" as button text
   */
  async tryClickNext() {
    // Get the active context (iframe or main page)
    const context = await this.getActiveContext();
    
    // Get buttons from ANY visible Easy Apply modal 
    const buttons = await context.evaluate(() => {
      const dialogs = document.querySelectorAll('[role="dialog"], .artdeco-modal, .jobs-easy-apply-modal');
      for (const dialog of dialogs) {
        const text = dialog.textContent || '';
        
        // Exclude messaging widget
        if (text.includes('Open Emoji Keyboard') || text.includes('Compose message')) {
          continue;
        }
        
        // Get all buttons in this dialog
        const btns = dialog.querySelectorAll('button');
        const buttonTexts = Array.from(btns).map(b => b.textContent?.trim()?.toLowerCase() || '');
        
        // Check if this looks like an Easy Apply modal (has Dismiss + Next/Submit/Review)
        const hasDismiss = buttonTexts.some(t => t.includes('dismiss'));
        const hasEasyApplyButtons = buttonTexts.some(t => 
          t.includes('next') || t.includes('continue') || t.includes('submit') || t.includes('review')
        );
        
        if (hasDismiss || hasEasyApplyButtons) {
          return Array.from(btns).map((b, idx) => ({
            idx,
            text: b.textContent?.trim() || '',
            disabled: b.disabled,
            ariaLabel: b.getAttribute('aria-label') || '',
          }));
        }
      }
      return [];
    }).catch(() => []);
    
    if (buttons.length > 0) {
      console.log(`   Found ${buttons.length} buttons in modal:`, buttons.map(b => b.text).filter(t => t).join(', '));
    }
    
    // Priority 1: Exact match "Next" (new LinkedIn UI)
    for (const btnInfo of buttons) {
      if (btnInfo.text === 'Next' && !btnInfo.disabled) {
        console.log('✅ Found "Next" button');
        const success = await this.clickModalButtonByIndex(btnInfo.idx);
        if (success) return true;
      }
    }
    
    // Priority 2: Exact match "Continue to next step" (legacy LinkedIn UI)
    for (const btnInfo of buttons) {
      if (btnInfo.text === 'Continue to next step' && !btnInfo.disabled) {
        console.log('✅ Found "Continue to next step" button');
        const success = await this.clickModalButtonByIndex(btnInfo.idx);
        if (success) return true;
      }
    }
    
    // Priority 3: aria-label match
    for (const btnInfo of buttons) {
      const ariaLower = btnInfo.ariaLabel.toLowerCase();
      if ((ariaLower.includes('continue to next step') || ariaLower.includes('next')) && !btnInfo.disabled) {
        console.log(`✅ Found Next button via aria-label: "${btnInfo.ariaLabel}"`);
        const success = await this.clickModalButtonByIndex(btnInfo.idx);
        if (success) return true;
      }
    }

    // Priority 4: Fuzzy text match (next/continue but not back, review, or submit)
    for (const btnInfo of buttons) {
      const text = btnInfo.text.toLowerCase();
      if ((text.includes('next') || text === 'continue') && 
          !text.includes('back') && 
          !text.includes('review') && 
          !text.includes('submit') && 
          !btnInfo.disabled) {
        console.log(`✅ Found next button via fuzzy match: "${btnInfo.text}"`);
        const success = await this.clickModalButtonByIndex(btnInfo.idx);
        if (success) return true;
      }
    }

    console.log('⚠️ Could not find Next/Continue button');
    return false;
  }
  
  /**
   * Click a button in the Easy Apply modal by its index
   */
  async clickModalButtonByIndex(idx) {
    // Get the active context (iframe or main page)
    const context = await this.getActiveContext();
    
    return await context.evaluate((buttonIdx) => {
      const dialogs = document.querySelectorAll('[role="dialog"], .artdeco-modal, .jobs-easy-apply-modal');
      for (const dialog of dialogs) {
        const text = dialog.textContent || '';
        
        // Exclude messaging widget
        if (text.includes('Open Emoji Keyboard') || text.includes('Compose message')) {
          continue;
        }
        
        const btns = dialog.querySelectorAll('button');
        const buttonTexts = Array.from(btns).map(b => b.textContent?.trim()?.toLowerCase() || '');
        const hasDismiss = buttonTexts.some(t => t.includes('dismiss'));
        const hasEasyApplyButtons = buttonTexts.some(t => 
          t.includes('next') || t.includes('continue') || t.includes('submit') || t.includes('review') || t.includes('done')
        );
        
        if (hasDismiss || hasEasyApplyButtons) {
          if (btns[buttonIdx]) {
            btns[buttonIdx].click();
            return true;
          }
        }
      }
      return false;
    }, idx).catch(() => false);
  }

  /**
   * Click a button by its span text content (like Python's wait_span_click)
   * This is more reliable as LinkedIn buttons often have text in nested span elements
   */
  async clickButtonBySpanText(buttonText) {
    // Get the active context (iframe or main page)
    const context = await this.getActiveContext();
    
    const clicked = await context.evaluate((targetText) => {
      const dialogs = document.querySelectorAll('[role="dialog"], .artdeco-modal, .jobs-easy-apply-modal');
      for (const dialog of dialogs) {
        const text = dialog.textContent || '';
        
        // Exclude messaging widget
        if (text.includes('Open Emoji Keyboard') || text.includes('Compose message')) {
          continue;
        }
        
        const btns = dialog.querySelectorAll('button');
        for (const btn of btns) {
          // Check button text content directly
          const btnText = btn.textContent?.trim() || '';
          // Also check for span children with text
          const spanText = btn.querySelector('span')?.textContent?.trim() || '';
          
          if (btnText === targetText || spanText === targetText) {
            if (!btn.disabled) {
              btn.click();
              return { success: true, text: btnText };
            }
          }
        }
      }
      return { success: false };
    }, buttonText).catch(() => ({ success: false }));
    
    if (clicked.success) {
      console.log(`✅ Clicked button: "${clicked.text}"`);
    }
    return clicked.success;
  }

  /**
   * Check if application was successful
   * Also handles the "Done" button that appears after successful submission
   */
  async checkApplicationSuccess() {
    try {
      // Get the active context (iframe or main page)
      const context = await this.getActiveContext();
      
      // Check context (iframe or main page) for success indicators
      const successCheck = await context.evaluate(() => {
        const pageText = document.body.innerText?.toLowerCase() || '';
        
        // Check for success phrases
        const successPhrases = [
          'application sent',
          'application submitted', 
          'your application was sent',
          'you applied for this job',
          'application was successfully sent',
          'successfully applied',
        ];
        
        for (const phrase of successPhrases) {
          if (pageText.includes(phrase)) {
            return { success: true, phrase };
          }
        }
        
        // Also check if there's a "Done" button visible (shows after success)
        const dialogs = document.querySelectorAll('[role="dialog"], .artdeco-modal');
        for (const dialog of dialogs) {
          const dialogText = dialog.textContent?.toLowerCase() || '';
          if (dialogText.includes('application') && 
              (dialogText.includes('sent') || dialogText.includes('submitted'))) {
            // Look for Done button
            const doneBtn = dialog.querySelector('button');
            const hasDoneBtn = Array.from(dialog.querySelectorAll('button'))
              .some(b => b.textContent?.trim().toLowerCase() === 'done');
            if (hasDoneBtn) {
              return { success: true, phrase: 'done_button_visible' };
            }
          }
        }
        
        return { success: false };
      });
      
      if (successCheck.success) {
        console.log(`🎉 Application success detected: ${successCheck.phrase}`);
        
        // Try to click "Done" button if present
        await this.clickButtonBySpanText('Done');
        await randomSleep(500, 1000);
        
        // Close the success modal
        await this.closeModal();
        return true;
      }
      
      // Legacy check for dismiss button in success context
      const dismissBtn = await this.page.$('button[aria-label="Dismiss"]');
      if (dismissBtn) {
        const modalText = await this.page.evaluate(el => {
          const modal = el.closest('.artdeco-modal, [role="dialog"]');
          return modal?.textContent?.toLowerCase() || '';
        }, dismissBtn);
        
        if (modalText.includes('application') && 
            (modalText.includes('sent') || modalText.includes('submitted'))) {
          console.log('🎉 Application success detected via dismiss button context');
          await this.closeModal();
          return true;
        }
      }
    } catch (e) {
      console.log(`⚠️ Error checking success: ${e.message}`);
    }

    return false;
  }

  /**
   * Close modal
   */
  async closeModal() {
    try {
      // Try dismiss button first
      await safeClick(this.page, 'button[aria-label="Dismiss"]', 2000);
      await randomSleep(500, 1000);
      
      // If discard dialog appears
      const discardBtn = await this.page.$('button[data-test-dialog-secondary-btn]');
      if (discardBtn) {
        await discardBtn.click();
      }
    } catch {
      // Modal might already be closed
    }
  }

  /**
   * Main run loop
   */
  async run() {
    try {
      await this.init();
      await this.login();

      if (!this.isLoggedIn) {
        throw new Error('Failed to login');
      }

      await notifyBotStatus('Started', `Processing ${config.search.terms.length} search term(s)`);

      // Get search terms (optionally randomize)
      let searchTerms = [...config.search.terms];
      if (config.search.randomize) {
        searchTerms = searchTerms.sort(() => Math.random() - 0.5);
      }

      // Get locations - support both single SEARCH_LOCATION and multiple SEARCH_LOCATIONS
      let searchLocations = config.search.locations.length > 0 
        ? [...config.search.locations]
        : (config.search.location ? [config.search.location] : [null]); // null = no location filter
      
      if (config.search.randomizeLocations && searchLocations.length > 1) {
        searchLocations = searchLocations.sort(() => Math.random() - 0.5);
      }

      const totalLocations = searchLocations.filter(l => l !== null).length;
      if (totalLocations > 1) {
        console.log(`📍 Will search across ${totalLocations} location(s): ${searchLocations.join(', ')}`);
      }
      
      let stoppedByUser = false;
      let limitReached = false;

      // Process each location
      for (const currentLocation of searchLocations) {
        if (stoppedByUser || limitReached) break;
        
        let locationApplications = 0;  // Successful applications only
        let locationJobsProcessed = 0;  // All jobs processed (applied + skipped from grid)
        const locationDisplay = currentLocation || 'Worldwide';
        
        // Determine which counter to use for switching based on switchCountMode
        const countMode = config.search.switchCountMode || 'all';
        const getLocationCount = () => countMode === 'all' ? locationJobsProcessed : locationApplications;
        
        if (searchLocations.length > 1 || currentLocation) {
          console.log(`\n📍 ═══════════════════════════════════════════`);
          console.log(`📍 Searching in location: ${locationDisplay}`);
          console.log(`📍 Switch mode: ${countMode === 'all' ? 'All jobs (applied + skipped)' : 'Only successful applications'}`);
          console.log(`📍 ═══════════════════════════════════════════`);
        }

        // Process each search term for this location
        for (const term of searchTerms) {
          // Check if stop was requested from dashboard
          if (!shouldBotRun()) {
            console.log('⏹️ Stop requested from dashboard');
            stoppedByUser = true;
            break;
          }
          
          if (stateManager.isLimitReached()) {
            console.log('📊 Daily limit reached!');
            limitReached = true;
            break;
          }

          // Switch to next location after N jobs processed (based on count mode)
          if (searchLocations.length > 1 && getLocationCount() >= config.search.switchLocationAfter) {
            console.log(`📍 Switching location after ${getLocationCount()} jobs processed (${locationApplications} applied, ${locationJobsProcessed - locationApplications} skipped)`);
            break;
          }

          console.log(`\n🎯 Processing topic: ${term}${currentLocation ? ` in ${currentLocation}` : ''}`);
          let page = 0;
          let termApplications = 0;
          let termJobsProcessed = 0;
          
          // Determine which counter to use for term switching
          const getTermCount = () => countMode === 'all' ? termJobsProcessed : termApplications;

          while (getTermCount() < config.search.switchAfter) {
            if (!shouldBotRun()) {
              console.log('⏹️ Stop requested from dashboard');
              stoppedByUser = true;
              break;
            }
            if (stateManager.isLimitReached()) {
              limitReached = true;
              break;
            }
            if (searchLocations.length > 1 && getLocationCount() >= config.search.switchLocationAfter) {
              break;
            }

            await this.searchJobs(term, page, currentLocation);
            const jobs = await this.getJobCards();

            if (jobs.length === 0) {
              console.log('📭 No more jobs found');
              break;
            }

            console.log(`📋 Found ${jobs.length} jobs on page ${page + 1}`);
            
            // Debug: log Easy Apply stats
            const easyApplyJobs = jobs.filter(j => j.hasEasyApply);
            const alreadyAppliedJobs = jobs.filter(j => j.alreadyApplied);
            if (easyApplyJobs.length < jobs.length) {
              console.log(`   ℹ️  ${easyApplyJobs.length}/${jobs.length} have Easy Apply, ${alreadyAppliedJobs.length} already applied`);
            }

            for (const job of jobs) {
              if (!shouldBotRun()) break;
              if (stateManager.isLimitReached()) break;
              if (getTermCount() >= config.search.switchAfter) break;
              if (searchLocations.length > 1 && getLocationCount() >= config.search.switchLocationAfter) break;

              // Skip if already applied
              if (job.alreadyApplied) {
                continue;
              }

              // Only process Easy Apply jobs
              if (!job.hasEasyApply) {
                continue;
              }

              // Skip bad job titles directly from grid (without opening job page)
              const badJobTitles = config.jobFilter.badJobTitles || [];
              if (badJobTitles.length > 0) {
                const jobTitleLower = job.title.toLowerCase();
                const badTitleFound = badJobTitles.find(badTitle => 
                  jobTitleLower.includes(badTitle.toLowerCase())
                );
                if (badTitleFound) {
                  console.log(`⏭️ Skipping from grid: "${job.title}" contains "${badTitleFound}"`);
                  this.sessionStats.skipped++;
                  stateManager.incrementSkipped();
                  // Count as processed for switching purposes
                  termJobsProcessed++;
                  locationJobsProcessed++;
                  continue;
                }
              }

              const result = await this.applyToJob(job);
              
              // Always count as processed
              termJobsProcessed++;
              locationJobsProcessed++;
              
              if (result.success) {
                termApplications++;
                locationApplications++;
              }

              // Session break for anti-detection
              if (this.sessionStats.applied > 0 && 
                  this.sessionStats.applied % config.delays.sessionBreak.after === 0) {
                await sessionBreak();
              }

              await applicationDelay();
            }

            page++;
            
            // Max pages per term
            if (page >= 10) break;
          }

          console.log(`✅ Finished "${term}"${currentLocation ? ` in ${currentLocation}` : ''}: ${termApplications} applied, ${termJobsProcessed} processed`);
        }

        if (searchLocations.length > 1) {
          console.log(`📍 Finished location "${locationDisplay}": ${locationApplications} applied, ${locationJobsProcessed} total processed`);
        }
      }

      // Send completion notification based on how bot stopped
      const stats = this.sessionStats;
      const runtime = formatDuration(Date.now() - this.startTime);
      
      if (stoppedByUser) {
        await notifyBotStatus('Stopped', `Stopped by user. Applied: ${stats.applied}, Skipped: ${stats.skipped}, Failed: ${stats.failed}. Runtime: ${runtime}`);
      } else if (limitReached) {
        await notifyBotStatus('Completed', `Daily limit reached! Applied: ${stats.applied}, Skipped: ${stats.skipped}, Failed: ${stats.failed}. Runtime: ${runtime}`);
      } else {
        await notifyBotStatus('Completed', `Finished all search terms. Applied: ${stats.applied}, Skipped: ${stats.skipped}, Failed: ${stats.failed}. Runtime: ${runtime}`);
      }

      return this.sessionStats;
    } catch (error) {
      // Send error notification
      const runtime = formatDuration(Date.now() - this.startTime);
      await notifyBotStatus('Error', `Bot crashed: ${error.message}. Runtime: ${runtime}`);
      throw error;
    } finally {
      await this.close();
    }
  }

  /**
   * Clean up stale Chrome lock files to fix "profile in use" errors
   * This is especially important in Docker environments where containers restart
   */
  async cleanupChromeLocks(sessionDir) {
    const lockFiles = [
      'SingletonLock',
      'SingletonSocket',
      'SingletonCookie',
      '.org.chromium.Chromium.lock',
    ];
    
    console.log('🧹 Cleaning up Chrome lock files...');
    
    for (const lockFile of lockFiles) {
      const lockPath = path.join(sessionDir, lockFile);
      try {
        if (fs.existsSync(lockPath)) {
          fs.unlinkSync(lockPath);
          console.log(`   ✓ Removed: ${lockFile}`);
        }
      } catch (e) {
        console.log(`   ⚠️ Could not remove ${lockFile}: ${e.message}`);
      }
    }
  }

  /**
   * Close browser
   */
  async close() {
    if (this.browser) {
      console.log('🔒 Closing browser...');
      await this.browser.close();
      this.browser = null;
    }
  }

  /**
   * Get session statistics
   */
  getStats() {
    const runtime = formatDuration(Date.now() - this.startTime);
    return {
      ...this.sessionStats,
      runtime,
      ...stateManager.getStats(),
    };
  }
}

export default LinkedInBot;
