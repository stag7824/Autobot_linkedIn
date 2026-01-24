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
        const allButtons = Array.from(document.querySelectorAll('button'));
        const easyApplyButton = allButtons.find(b => 
          b.textContent?.toLowerCase().includes('easy apply'));
        
        // Get ALL buttons that might be related to applying
        const applyRelatedButtons = allButtons.filter(b => {
          const text = b.textContent?.toLowerCase() || '';
          return text.includes('easy apply') || text.includes('apply') || text.includes('premium');
        }).map(b => ({
          text: b.textContent?.trim().substring(0, 50),
          ariaLabel: b.getAttribute('aria-label')?.substring(0, 50),
          classes: b.className?.substring(0, 50)
        }));
        
        return {
          hasLink: !!easyApplyLink,
          linkHref: easyApplyLink?.href?.substring(0, 80),
          hasButton: !!easyApplyButton,
          buttonText: easyApplyButton?.textContent?.trim().substring(0, 30),
          allApplyButtons: applyRelatedButtons
        };
      }).catch(() => ({}));
      
      if (easyApplyInfo.hasLink) {
        console.log(`   Easy Apply Link: ${easyApplyInfo.linkHref}`);
      }
      if (easyApplyInfo.hasButton) {
        console.log(`   Easy Apply Button: "${easyApplyInfo.buttonText}"`);
      }
      if (easyApplyInfo.allApplyButtons?.length > 0) {
        console.log(`   All Apply-related buttons: ${JSON.stringify(easyApplyInfo.allApplyButtons)}`);
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

      // IMPORTANT: Dismiss any premium promotion overlays that might intercept clicks
      await this.dismissPremiumOverlays();
      
      // Small wait after dismissing overlays
      await randomSleep(500, 1000);

      // Find Easy Apply button/link to confirm the job has Easy Apply
      const easyApplyBtn = await this.findEasyApplyButton();
      if (!easyApplyBtn) {
        console.log(`⏭️ No Easy Apply button found`);
        await this.debugSnapshot('no_easy_apply_button');
        this.sessionStats.skipped++;
        return { success: false, reason: 'no_easy_apply' };
      }
      
      // Log button info to confirm Easy Apply is available
      const btnInfo = await this.page.evaluate(el => ({
        text: el.textContent?.trim(),
        ariaLabel: el.getAttribute('aria-label'),
        className: el.className,
        tagName: el.tagName
      }), easyApplyBtn);
      console.log(`   ✅ Easy Apply available: ${btnInfo.tagName} "${btnInfo.text || btnInfo.ariaLabel}"`);
      
      // CRITICAL FIX: Instead of clicking the button (which may go to Premium page on non-Premium accounts),
      // navigate directly to the Easy Apply URL using the job ID.
      // This bypasses any Premium upsell interception and goes straight to the application form.
      // The Easy Apply URL format is: https://www.linkedin.com/jobs/view/{jobId}/apply/?openSDUIApplyFlow=true
      const easyApplyUrl = `https://www.linkedin.com/jobs/view/${jobId}/apply/?openSDUIApplyFlow=true`;
      console.log(`   📍 Navigating directly to Easy Apply URL (bypassing button click)`);
      console.log(`   🔗 URL: ${easyApplyUrl}`);
      
      await this.page.goto(easyApplyUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await randomSleep(2000, 3000);
      
      await this.debugSnapshot('after_navigate_to_apply');
      
      // Verify we didn't get redirected to Premium page
      const applyPageUrl = this.page.url();
      if (applyPageUrl.includes('/premium/') || applyPageUrl.includes('/redeem') || 
          applyPageUrl.includes('/upsell') || applyPageUrl.includes('/learning/')) {
        console.log(`⚠️ Got redirected to Premium page: ${applyPageUrl}`);
        await this.debugSnapshot('premium_redirect');
        await this.page.goBack();
        await randomSleep(1000, 2000);
        return { success: false, reason: 'premium_redirect' };
      }
      
      // Note: After navigating to /apply/, LinkedIn may redirect back to /jobs/view/{id}/ with the modal open
      // So we check if we're on a jobs page (not premium), rather than checking for /apply/ in URL
      if (!applyPageUrl.includes('/jobs/')) {
        console.log(`⚠️ Did not land on jobs page, current URL: ${applyPageUrl}`);
        await this.debugSnapshot('wrong_page_after_navigate');
        return { success: false, reason: 'wrong_page' };
      }
      
      console.log(`   ✅ On jobs page: ${applyPageUrl}`);
      console.log(`   Waiting for Easy Apply modal to appear...`);
      
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
        
        // Try navigating to apply URL again instead of clicking button
        console.log(`   🔄 Retrying direct navigation to apply URL...`);
        await this.page.goto(easyApplyUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await randomSleep(2000, 3000);
        await this.debugSnapshot('after_second_navigation');
        
        // Wait for modal again
        modalAppeared = await this.waitForEasyApplyModal(5000);
        
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
   * Dismiss any premium promotion overlays that might intercept clicks
   * LinkedIn shows promotional cards that can overlay the Easy Apply button
   */
  async dismissPremiumOverlays() {
    try {
      console.log(`   Checking for premium overlays to dismiss...`);
      
      // Find and click any "Dismiss" buttons on premium promotions
      const dismissed = await this.page.evaluate(() => {
        let dismissedCount = 0;
        
        // Look for various dismiss buttons
        const dismissSelectors = [
          // Specific premium promotion dismiss buttons
          'button[class*="dismiss"]',
          'button[aria-label*="Dismiss"]',
          'button[aria-label*="dismiss"]',
          '[class*="upsell"] button[class*="dismiss"]',
          '[class*="premium"] button[class*="dismiss"]',
          // Close buttons on overlays
          '[class*="card-upsell"] button',
          '[class*="premium-promo"] button[class*="close"]',
          // Generic close/dismiss on promotions
          '[class*="promotion"] [class*="dismiss"]',
          '[class*="promotion"] [class*="close"]'
        ];
        
        for (const selector of dismissSelectors) {
          const buttons = document.querySelectorAll(selector);
          for (const btn of buttons) {
            const text = btn.textContent?.toLowerCase() || '';
            const ariaLabel = btn.getAttribute('aria-label')?.toLowerCase() || '';
            const className = btn.className?.toLowerCase() || '';
            
            // Check if this is a dismiss/close button for a promotion
            if (text.includes('dismiss') || ariaLabel.includes('dismiss') || 
                text.includes('close') || ariaLabel.includes('close') ||
                className.includes('dismiss') || className.includes('close')) {
              try {
                btn.click();
                dismissedCount++;
              } catch (e) {
                // Ignore click errors
              }
            }
          }
        }
        
        // Also try to click away from any overlay by clicking on body
        // But only if there's an overlay present
        const overlays = document.querySelectorAll('[class*="upsell"], [class*="promotion"], [class*="premium-card"]');
        
        return { dismissed: dismissedCount, overlaysFound: overlays.length };
      });
      
      if (dismissed.dismissed > 0) {
        console.log(`   ✅ Dismissed ${dismissed.dismissed} premium overlay(s)`);
        await randomSleep(500, 1000);
      } else if (dismissed.overlaysFound > 0) {
        console.log(`   ⚠️ Found ${dismissed.overlaysFound} overlay(s) but couldn't dismiss - trying escape key`);
        await this.page.keyboard.press('Escape');
        await randomSleep(300, 500);
      }
      
    } catch (err) {
      console.log(`   Warning: Could not dismiss overlays: ${err.message}`);
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
   * UPDATED January 2026: LinkedIn now uses anchor tags (links) for Easy Apply on job detail pages
   * FIXED: Prioritize link detection and add strict validation to avoid clicking wrong elements
   */
  async findEasyApplyButton() {
    console.log(`   Searching for Easy Apply button...`);
    
    // PRIORITY 1: Look for ANCHOR TAG with "/apply/" in href - MOST RELIABLE method
    // On /jobs/view/ID/ pages, Easy Apply is an anchor tag with URL containing "/apply/"
    // This is the safest because we validate the destination URL
    try {
      const applyLinks = await this.page.$$('a[href*="/apply/"]');
      console.log(`   [DEBUG] Found ${applyLinks.length} links with /apply/ in href`);
      
      for (const applyLink of applyLinks) {
        const linkInfo = await this.page.evaluate(el => ({
          text: el.textContent?.trim().toLowerCase(),
          href: el.href,
          ariaLabel: el.getAttribute('aria-label')?.toLowerCase() || ''
        }), applyLink);
        
        console.log(`   [DEBUG] Checking link: text="${linkInfo.text?.substring(0,30)}", href="${linkInfo.href?.substring(0,60)}"`);
        
        // Validate it's actually an Easy Apply link (not some other apply link)
        if ((linkInfo.text?.includes('easy apply') || linkInfo.ariaLabel?.includes('easy apply')) &&
            linkInfo.href.includes('/apply/') &&
            !linkInfo.href.includes('/premium/') &&
            !linkInfo.href.includes('/learning/')) {
          console.log(`   Found Easy Apply LINK via href selector (priority method)`);
          return applyLink;
        }
      }
      console.log(`   [DEBUG] No valid Easy Apply link found in priority 1`);
    } catch (err) {
      console.log(`   Priority 1 method failed: ${err.message}`);
    }
    
    // PRIORITY 2: Search all anchor tags for Easy Apply (backup for above)
    const easyApplyLink = await this.page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      for (const link of links) {
        const text = link.textContent?.trim().toLowerCase();
        const href = link.href?.toLowerCase() || '';
        const ariaLabel = link.getAttribute('aria-label')?.toLowerCase() || '';
        
        // Must have "/apply/" in href AND contain "easy apply" text
        if (href.includes('/apply/') &&
            (text?.includes('easy apply') || ariaLabel?.includes('easy apply')) &&
            !text?.includes('premium') && 
            !text?.includes('learning') &&
            !href.includes('/premium/') &&
            !href.includes('/learning/')) {
          return { found: true, type: 'link' };
        }
      }
      return { found: false };
    });
    
    if (easyApplyLink?.found) {
      const links = await this.page.$$('a');
      for (const link of links) {
        const info = await this.page.evaluate(el => ({
          text: el.textContent?.trim().toLowerCase(),
          href: el.href?.toLowerCase() || '',
          ariaLabel: el.getAttribute('aria-label')?.toLowerCase() || ''
        }), link);
        
        if (info.href.includes('/apply/') &&
            (info.text?.includes('easy apply') || info.ariaLabel?.includes('easy apply')) &&
            !info.text?.includes('premium') && 
            !info.text?.includes('learning')) {
          console.log(`   Found Easy Apply LINK (anchor tag) - search method`);
          return link;
        }
      }
    }
    
    // PRIORITY 3: Look for BUTTON with "Easy Apply" text (search results page)
    // IMPORTANT: Only match buttons that have BOTH text AND aria-label containing "easy apply"
    // This prevents matching Premium upsell buttons that might have aria-label "easy apply"
    const easyApplyByText = await this.page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      
      // First, find all valid Easy Apply buttons (excluding those in premium context)
      const validButtons = [];
      
      for (const btn of buttons) {
        const text = btn.textContent?.trim().toLowerCase();
        const ariaLabel = btn.getAttribute('aria-label')?.toLowerCase() || '';
        
        // STRICT: Must have "easy apply" in the actual button TEXT (not just aria-label)
        // This prevents matching wrong buttons like Premium upsells
        const hasEasyApplyText = text?.includes('easy apply');
        const isPremiumOrLearning = text?.includes('premium') || text?.includes('learning') || 
                                    text?.includes('upgrade') || text?.includes('try premium');
        
        // Check parent elements for premium/learning/upsell context (go up multiple levels)
        let inBadContext = false;
        let parent = btn.parentElement;
        for (let i = 0; i < 10 && parent; i++) {
          const parentClass = parent.className?.toLowerCase() || '';
          if (parentClass.includes('premium') || parentClass.includes('upsell') || 
              parentClass.includes('learning') || parentClass.includes('promotion') ||
              parentClass.includes('card-upsell')) {
            inBadContext = true;
            break;
          }
          parent = parent.parentElement;
        }
        
        if (hasEasyApplyText && !isPremiumOrLearning && !inBadContext) {
          // Check if button is inside job details section (not floating header)
          const isInJobDetails = !!btn.closest('.jobs-unified-top-card, .jobs-details, .job-details, .jobs-search__job-details, [class*="job-details"]');
          validButtons.push({
            text,
            ariaLabel,
            isInJobDetails,
            rect: btn.getBoundingClientRect()
          });
        }
      }
      
      // Prefer button in job details section
      const detailsButton = validButtons.find(b => b.isInJobDetails);
      if (detailsButton) {
        return { found: true, text: detailsButton.text, ariaLabel: detailsButton.ariaLabel, preferJobDetails: true };
      }
      
      // Otherwise return first valid button
      if (validButtons.length > 0) {
        return { found: true, text: validButtons[0].text, ariaLabel: validButtons[0].ariaLabel, preferJobDetails: false };
      }
      
      return { found: false };
    });
    
    if (easyApplyByText?.found) {
      const buttons = await this.page.$$('button');
      for (const btn of buttons) {
        const info = await this.page.evaluate(el => {
          const text = el.textContent?.trim().toLowerCase();
          const ariaLabel = el.getAttribute('aria-label')?.toLowerCase() || '';
          
          // Check parent context
          let inBadContext = false;
          let parent = el.parentElement;
          for (let i = 0; i < 10 && parent; i++) {
            const parentClass = parent.className?.toLowerCase() || '';
            if (parentClass.includes('premium') || parentClass.includes('upsell') || 
                parentClass.includes('learning') || parentClass.includes('promotion') ||
                parentClass.includes('card-upsell')) {
              inBadContext = true;
              break;
            }
            parent = parent.parentElement;
          }
          
          const isInJobDetails = !!el.closest('.jobs-unified-top-card, .jobs-details, .job-details, .jobs-search__job-details, [class*="job-details"]');
          
          return { text, ariaLabel, inBadContext, isInJobDetails };
        }, btn);
        
        // STRICT: Only match if text contains "easy apply" (not just aria-label)
        const hasEasyApplyText = info.text?.includes('easy apply');
        
        // Prefer button in job details, or first valid button if none in details
        if (hasEasyApplyText && !info.inBadContext) {
          // If we're looking for job details button and this is one, return it
          if (easyApplyByText.preferJobDetails && info.isInJobDetails) {
            console.log(`   Found Easy Apply BUTTON in job details section`);
            return btn;
          }
          // If we don't need job details specifically, take first valid
          if (!easyApplyByText.preferJobDetails) {
            console.log(`   Found Easy Apply BUTTON by strict text match`);
            return btn;
          }
        }
      }
      
      // Second pass: accept any valid button if we didn't find job details one
      if (easyApplyByText.preferJobDetails) {
        for (const btn of buttons) {
          const info = await this.page.evaluate(el => {
            const text = el.textContent?.trim().toLowerCase();
            let inBadContext = false;
            let parent = el.parentElement;
            for (let i = 0; i < 10 && parent; i++) {
              const parentClass = parent.className?.toLowerCase() || '';
              if (parentClass.includes('premium') || parentClass.includes('upsell') || 
                  parentClass.includes('learning') || parentClass.includes('promotion') ||
                  parentClass.includes('card-upsell')) {
                inBadContext = true;
                break;
              }
              parent = parent.parentElement;
            }
            return { text, inBadContext };
          }, btn);
          
          if (info.text?.includes('easy apply') && !info.inBadContext) {
            console.log(`   Found Easy Apply BUTTON (fallback)`);
            return btn;
          }
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
    
    // Track modal state to detect stuck loops
    let lastModalText = '';
    let stuckCount = 0;
    const maxStuckRetries = 3; // Skip job if stuck for 3 consecutive attempts

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
      
      // Stuck detection: if modal state hasn't changed, increment stuck counter
      if (modalText === lastModalText) {
        stuckCount++;
        console.log(`   ⚠️ Stuck on same page (attempt ${stuckCount}/${maxStuckRetries})`);
        
        if (stuckCount >= maxStuckRetries) {
          // Try to read actual error messages before giving up
          const errorMessages = await this.page.evaluate(() => {
            const errors = document.querySelectorAll('.artdeco-inline-feedback--error, [data-test-form-element-error], .fb-form-element-error');
            return Array.from(errors).map(e => e.textContent?.trim()).filter(Boolean);
          }).catch(() => []);
          
          if (errorMessages.length > 0) {
            console.log(`   ❌ Form validation errors: ${errorMessages.join(', ')}`);
          }
          
          console.log(`   ❌ Stuck for ${maxStuckRetries} attempts - skipping this job`);
          await this.closeModal();
          return false;
        }
      } else {
        stuckCount = 0; // Reset counter on progress
        lastModalText = modalText;
      }
      
      // Log step to job logger
      if (jobId) jobLogger.logStep(jobId, step, maxSteps, modalText);

      // Check for success
      if (await this.checkApplicationSuccess()) {
        return true;
      }

      // Check for errors and try to fix them
      const hasError = await elementExists(this.page, config.selectors.easyApply.errorMessage);
      if (hasError) {
        console.log('⚠️ Form has errors, attempting to fix...');
        
        // If we're stuck with errors, try more aggressive field fixing
        if (stuckCount > 0) {
          console.log('   🔧 Attempting aggressive field fix (clearing and re-entering)...');
          await this.fixFormErrors();
        }
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
   * Fix form errors by finding fields with error messages and asking AI for correct values
   * This is called when we're stuck with validation errors
   */
  async fixFormErrors() {
    const context = await this.getActiveContext();
    
    // Find all error messages and their associated form fields
    const errorFields = await context.evaluate(() => {
      const errors = [];
      const errorElements = document.querySelectorAll('.artdeco-inline-feedback--error');
      
      for (const error of errorElements) {
        const errorText = error.textContent?.trim() || '';
        
        // Find the associated input field (usually sibling or within same container)
        const container = error.closest('.fb-form-element, .artdeco-text-input, [data-test-form-element], .fb-dash-form-element');
        if (container) {
          const input = container.querySelector('input, textarea, select');
          const label = container.querySelector('label')?.textContent?.trim() || '';
          
          if (input) {
            errors.push({
              errorText,
              label,
              inputType: input.tagName.toLowerCase(),
              inputName: input.name || '',
              currentValue: input.value || '',
              htmlType: input.type || 'text',
            });
          }
        }
      }
      
      return errors;
    }).catch(() => []);
    
    if (errorFields.length === 0) {
      console.log('   No error fields found to fix');
      return;
    }
    
    console.log(`   📋 Found ${errorFields.length} field(s) with errors:`);
    for (const field of errorFields) {
      console.log(`      - "${field.label}": ${field.errorText} (current: "${field.currentValue}")`);
    }
    
    // Find and re-fill the error fields with AI assistance
    const modalSelector = '.jobs-easy-apply-modal, [role="dialog"]:not(:has(.msg-overlay-list-bubble))';
    const modal = await this.page.$(modalSelector);
    if (!modal) return;
    
    for (const errorField of errorFields) {
      try {
        // Ask AI for the correct value based on the error message
        const aiPrompt = `Field: "${errorField.label}"
Current value: "${errorField.currentValue}"
Error message: "${errorField.errorText}"
Field type: ${errorField.htmlType}

What should the correct value be? Reply with ONLY the value, no explanation.`;
        
        console.log(`   🤖 Asking AI to fix: "${errorField.label}" (error: ${errorField.errorText})`);
        const aiAnswer = await answerQuestion(aiPrompt, null, this.getJobContext());
        
        if (aiAnswer && aiAnswer !== errorField.currentValue) {
          // Find the input field
          const inputs = await modal.$$('input, textarea');
          for (const input of inputs) {
            const inputName = await this.page.evaluate(el => el.name, input);
            if (inputName === errorField.inputName || !errorField.inputName) {
              const inputLabel = await this.page.evaluate(el => {
                const container = el.closest('.fb-form-element, .artdeco-text-input, [data-test-form-element]');
                return container?.querySelector('label')?.textContent?.trim() || '';
              }, input);
              
              if (inputLabel.includes(errorField.label.substring(0, 20)) || errorField.label.includes(inputLabel.substring(0, 20))) {
                // Clear and re-enter with AI answer
                await input.click({ clickCount: 3 });
                await this.page.keyboard.press('Backspace');
                await randomSleep(200, 300);
                await input.type(aiAnswer, { delay: 50 });
                
                // Trigger events
                await this.page.evaluate(el => {
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                  el.dispatchEvent(new Event('blur', { bubbles: true }));
                }, input);
                
                console.log(`   ✅ AI fixed field "${errorField.label}": "${errorField.currentValue}" → "${aiAnswer}"`);
                
                // Clear bad cache entry and cache the new answer
                answerCache.clearCachedAnswer(errorField.label);
                answerCache.cacheAnswer(errorField.label, aiAnswer, 'ai-fix', 'text');
                break;
              }
            }
          }
        } else {
          console.log(`   ⚠️ AI couldn't provide a different answer for "${errorField.label}"`);
        }
      } catch (e) {
        console.log(`   ⚠️ Could not fix field: ${e.message}`);
      }
    }
    
    await randomSleep(500, 800);
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

    // Check if this is a numeric field (input type="number" or has numeric validation)
    const inputType = await this.page.evaluate(el => el.type, input);
    const isNumericField = inputType === 'number' || 
                          label.toLowerCase().includes('number') ||
                          label.toLowerCase().includes('years') ||
                          label.toLowerCase().includes('months') ||
                          label.toLowerCase().includes('weeks') ||
                          label.toLowerCase().includes('days');
    
    // Convert text answers to numeric for number fields
    if (isNumericField) {
      const lowerAnswer = answer.toLowerCase();
      if (lowerAnswer === 'immediately' || lowerAnswer === 'now' || lowerAnswer === 'asap') {
        answer = '0';
        console.log(`   🔢 Converted text "${lowerAnswer}" to numeric "0" for number field`);
      } else if (lowerAnswer.includes('week')) {
        // Extract number from "2 weeks" etc
        const match = answer.match(/(\d+)/);
        if (match) answer = match[1];
      } else if (lowerAnswer.includes('month')) {
        // Convert months to weeks (rough estimate)
        const match = answer.match(/(\d+)/);
        if (match) answer = String(parseInt(match[1]) * 4);
      }
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
    
    // Filter out placeholder values - these are NOT valid answers
    const isPlaceholder = (text) => {
      if (!text) return true;
      const lower = text.toLowerCase().trim();
      return lower.includes('select an option') || 
             lower.includes('select option') ||
             lower === 'select' ||
             lower === '--' ||
             lower === '-' ||
             lower === '';
    };
    
    // If answer is a placeholder, clear it and force default selection
    if (answer && isPlaceholder(answer)) {
      console.log(`   ⚠️ AI/Cache returned placeholder "${answer}" - will use default`);
      // Clear bad cache entry
      answerCache.clearCachedAnswer(label);
      answer = null;
    }
    
    if (answer) {
      // Find best matching option (excluding placeholders)
      const matchOption = options.find(o => 
        !isPlaceholder(o.text) && (
          o.text.toLowerCase() === answer.toLowerCase() ||
          o.text.toLowerCase().includes(answer.toLowerCase()) ||
          answer.toLowerCase().includes(o.text.toLowerCase())
        )
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
        await this.selectDefaultDropdownOption(select, options, label, answer, answerSource, jobId, optionTexts);
      }
    } else {
      // No answer available (AI returned placeholder or no answer) - select default
      await this.selectDefaultDropdownOption(select, options, label, null, 'default', jobId, optionTexts);
    }
  }

  /**
   * Select the first non-placeholder option in a dropdown
   */
  async selectDefaultDropdownOption(select, options, label, attemptedAnswer, answerSource, jobId, optionTexts) {
    const isPlaceholder = (text) => {
      if (!text) return true;
      const lower = text.toLowerCase().trim();
      return lower.includes('select an option') || 
             lower.includes('select option') ||
             lower === 'select' ||
             lower === '--' ||
             lower === '-' ||
             lower === '';
    };
    
    const firstRealOption = options.find(o => o.value && !isPlaceholder(o.text));
    if (firstRealOption) {
      await select.select(firstRealOption.value);
      const reason = attemptedAnswer ? `no match for "${attemptedAnswer}"` : 'no valid answer';
      console.log(`   ⚡ Default selected: ${label} = "${firstRealOption.text}" (${reason})`);
      // Clear bad cache entry if we had to default
      if (answerSource === 'cached') {
        answerCache.clearCachedAnswer(label);
      }
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
    } else {
      console.log(`   ⚠️ No valid options found for: ${label}`);
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
    if (!modal) {
      console.log('   ⚠️ No modal found for checkbox handling');
      return;
    }
    
    // Get all checkboxes in the modal - try multiple selectors
    let checkboxes = await modal.$$('input[type="checkbox"]');
    
    // Also try finding checkboxes via label elements (LinkedIn sometimes hides the actual input)
    if (checkboxes.length === 0) {
      checkboxes = await modal.$$('label input[type="checkbox"], [data-test-text-selectable-option] input');
    }
    
    console.log(`   Found ${checkboxes.length} checkbox(es)`);
    
    // Also check for consent text on the page and find all unchecked boxes
    const pageHasConsent = await this.page.evaluate(() => {
      const text = document.body.innerText?.toLowerCase() || '';
      return text.includes('i consent') || text.includes('privacy policy') || text.includes('declare');
    });
    
    if (pageHasConsent) {
      console.log(`   📋 Page contains consent language - will auto-check all consent boxes`);
    }
    
    for (const checkbox of checkboxes) {
      try {
        const isChecked = await this.page.evaluate(el => el.checked, checkbox);
        const checkboxId = await this.page.evaluate(el => el.id || el.name || 'unnamed', checkbox);
        
        // Get the label for this checkbox - try multiple methods
        const labelInfo = await this.page.evaluate(el => {
          let labelText = '';
          
          // Method 1: Find label by for attribute
          const id = el.id;
          if (id) {
            const label = document.querySelector(`label[for="${id}"]`);
            if (label) labelText = label.textContent?.trim() || '';
          }
          
          // Method 2: Parent label
          if (!labelText) {
            const parentLabel = el.closest('label');
            if (parentLabel) labelText = parentLabel.textContent?.trim() || '';
          }
          
          // Method 3: Sibling or nearby text
          if (!labelText) {
            const parent = el.parentElement;
            if (parent) {
              const siblingLabel = parent.querySelector('label, span, p');
              if (siblingLabel) labelText = siblingLabel.textContent?.trim() || '';
            }
          }
          
          // Method 4: Check container for any text
          if (!labelText) {
            const container = el.closest('.artdeco-text-input, .fb-form-element, [data-test-form-element], div');
            if (container) {
              labelText = container.textContent?.trim()?.substring(0, 200) || '';
            }
          }
          
          // Also get the full context around the checkbox
          const fullContext = el.closest('.fb-form-element, [data-test-form-element], .artdeco-text-input, div')?.textContent?.trim()?.substring(0, 300) || '';
          
          return { labelText, fullContext };
        }, checkbox);
        
        const labelText = labelInfo.labelText || labelInfo.fullContext;
        const labelLower = (labelText || '').toLowerCase();
        const contextLower = (labelInfo.fullContext || '').toLowerCase();
        
        console.log(`   📋 Checkbox: "${labelText?.substring(0, 60) || 'no label'}..." checked=${isChecked}`);
        
        // Handle "Follow" checkboxes - UNCHECK them if checked
        if (labelLower.includes('follow') && !labelLower.includes('up')) {
          if (isChecked) {
            await this.page.evaluate(el => el.scrollIntoView({ behavior: 'smooth', block: 'center' }), checkbox);
            await randomSleep(200, 400);
            await this.page.evaluate(el => {
              const id = el.id;
              if (id) {
                const label = document.querySelector(`label[for="${id}"]`);
                if (label) { label.click(); return; }
              }
              el.click();
            }, checkbox);
            console.log(`   ❌ Unchecked Follow checkbox`);
          }
          continue;
        }
        
        if (!isChecked) {
          // Check if this is a consent/terms checkbox - be very broad
          const isConsentCheckbox = 
            labelLower.includes('consent') ||
            labelLower.includes('i consent') ||
            labelLower.includes('agree') ||
            labelLower.includes('terms') ||
            labelLower.includes('privacy') ||
            labelLower.includes('gdpr') ||
            labelLower.includes('data processing') ||
            labelLower.includes('acknowledge') ||
            labelLower.includes('confirm') ||
            labelLower.includes('accept') ||
            labelLower.includes('policy') ||
            labelLower.includes('declare') ||
            labelLower.includes('understand') ||
            // Also check the full context
            contextLower.includes('privacy policy') ||
            contextLower.includes('i consent') ||
            contextLower.includes('declare that');
          
          let shouldCheck = false;
          
          if (isConsentCheckbox) {
            shouldCheck = true;
            console.log(`   ✅ Auto-checking consent checkbox: "${labelText?.substring(0, 50)}..."`);
          } else {
            // Use AI for non-consent checkboxes
            try {
              const jobContext = this.getJobContext();
              const aiDecision = await answerCheckboxQuestion(labelText, jobContext);
              shouldCheck = aiDecision.toLowerCase().trim() === 'true';
              console.log(`   🤖 AI decision for "${labelText?.substring(0, 40)}...": ${shouldCheck ? 'CHECK' : 'SKIP'}`);
            } catch (aiError) {
              console.log(`   ⚠️ AI error: ${aiError.message}`);
              // Default to checking if it looks like a consent box from context
              if (contextLower.includes('privacy') || contextLower.includes('consent')) {
                shouldCheck = true;
                console.log(`   ✅ Defaulting to check (context suggests consent)`);
              }
            }
          }
          
          if (!shouldCheck) {
            console.log(`   ⏭️ Skipping checkbox`);
            continue;
          }
          
          // Click the checkbox - scroll first, then click
          await this.page.evaluate(el => el.scrollIntoView({ behavior: 'smooth', block: 'center' }), checkbox);
          await randomSleep(300, 500);
          
          // Try multiple click methods
          const clicked = await this.page.evaluate(el => {
            try {
              // Method 1: Click label
              const id = el.id;
              if (id) {
                const label = document.querySelector(`label[for="${id}"]`);
                if (label) {
                  label.click();
                  return 'label';
                }
              }
              
              // Method 2: Click parent label
              const parentLabel = el.closest('label');
              if (parentLabel) {
                parentLabel.click();
                return 'parent-label';
              }
              
              // Method 3: Direct click
              el.click();
              return 'direct';
            } catch (e) {
              return false;
            }
          }, checkbox);
          
          // Verify it was checked
          await randomSleep(200, 300);
          const nowChecked = await this.page.evaluate(el => el.checked, checkbox);
          
          if (nowChecked) {
            console.log(`   ✅ Checked via ${clicked}: "${labelText?.substring(0, 40)}..."`);
          } else {
            // Try forcing the check
            await this.page.evaluate(el => {
              el.checked = true;
              el.dispatchEvent(new Event('change', { bubbles: true }));
              el.dispatchEvent(new Event('input', { bubbles: true }));
            }, checkbox);
            console.log(`   ✅ Force-checked: "${labelText?.substring(0, 40)}..."`);
          }
          
          await randomSleep(200, 400);
        } else {
          console.log(`   ✓ Already checked: "${labelText?.substring(0, 40)}..."`);
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
   * IMPORTANT: Scrolls button into view before clicking
   */
  async clickModalButtonByIndex(idx) {
    // Get the active context (iframe or main page)
    const context = await this.getActiveContext();
    
    // First, scroll the button into view
    await context.evaluate((buttonIdx) => {
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
            // CRITICAL: Scroll button into view before clicking
            btns[buttonIdx].scrollIntoView({ behavior: 'smooth', block: 'center' });
            return true;
          }
        }
      }
      return false;
    }, idx).catch(() => false);
    
    // Wait for scroll animation to complete
    await randomSleep(400, 600);
    
    // Now click the button
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
        // STRICT: Only check within dialogs/modals, not the entire page
        // This prevents false positives from old text elsewhere on the page
        const dialogs = document.querySelectorAll('[role="dialog"], .artdeco-modal, .jobs-easy-apply-modal, [role="alertdialog"]');
        
        for (const dialog of dialogs) {
          const dialogText = dialog.textContent?.toLowerCase() || '';
          
          // Skip messaging dialogs
          if (dialogText.includes('compose message') || dialogText.includes('emoji keyboard')) {
            continue;
          }
          
          // Check for explicit success phrases WITHIN THE DIALOG
          const successPhrases = [
            'application sent',
            'application submitted', 
            'your application was sent',
            'application was successfully sent',
            'successfully applied',
          ];
          
          for (const phrase of successPhrases) {
            if (dialogText.includes(phrase)) {
              // Double-check: look for Done button to confirm it's really a success screen
              const buttons = dialog.querySelectorAll('button');
              const buttonTexts = Array.from(buttons).map(b => b.textContent?.trim().toLowerCase() || '');
              const hasDoneOrDismiss = buttonTexts.some(t => t === 'done' || t === 'dismiss');
              const hasFormButtons = buttonTexts.some(t => 
                t.includes('next') || t.includes('submit') || t.includes('review') || t.includes('back')
              );
              
              // Success screen should have Done/Dismiss but NOT any form navigation buttons
              if (hasDoneOrDismiss && !hasFormButtons) {
                return { success: true, phrase, confidence: 'high' };
              }
              // If we have form buttons, it's NOT success
              if (hasFormButtons) {
                continue;
              }
              // Medium confidence only if no form buttons
              return { success: true, phrase, confidence: 'medium' };
            }
          }
          
          // Also check if there's a "Done" button visible without further form fields
          const buttons = dialog.querySelectorAll('button');
          const buttonTexts = Array.from(buttons).map(b => b.textContent?.trim().toLowerCase() || '');
          const hasDoneBtn = buttonTexts.some(t => t === 'done');
          const hasFormButtons = buttonTexts.some(t => 
            t.includes('next') || t.includes('submit') || t.includes('review') || t.includes('back')
          );
          
          // If we have a Done button but no form progression buttons, likely success
          if (hasDoneBtn && !hasFormButtons && dialogText.includes('application')) {
            return { success: true, phrase: 'done_button_no_form_buttons', confidence: 'medium' };
          }
        }
        
        // ALSO check the URL - if we got redirected to a "post-apply" page
        if (window.location.href.includes('/post-apply/') || 
            window.location.href.includes('applied=true')) {
          return { success: true, phrase: 'url_indicates_success', confidence: 'high' };
        }
        
        return { success: false };
      });
      
      if (successCheck.success) {
        console.log(`🎉 Application success detected: ${successCheck.phrase} (confidence: ${successCheck.confidence})`);
        
        // Only proceed if we're confident
        if (successCheck.confidence === 'high' || successCheck.confidence === 'medium') {
          // Try to click "Done" button if present
          await this.clickButtonBySpanText('Done');
          await randomSleep(500, 1000);
          
          // Close the success modal
          await this.closeModal();
          return true;
        }
      }
      
      // Legacy check for dismiss button in success context - BE VERY STRICT
      const dismissBtn = await this.page.$('button[aria-label="Dismiss"]');
      if (dismissBtn) {
        const modalInfo = await this.page.evaluate(el => {
          const modal = el.closest('.artdeco-modal, [role="dialog"]');
          const modalText = modal?.textContent?.toLowerCase() || '';
          const buttons = modal?.querySelectorAll('button') || [];
          const buttonTexts = Array.from(buttons).map(b => b.textContent?.trim().toLowerCase() || '');
          
          return {
            modalText,
            buttonTexts,
            hasBack: buttonTexts.some(t => t.includes('back')),
            hasNext: buttonTexts.some(t => t.includes('next')),
            hasSubmit: buttonTexts.some(t => t.includes('submit')),
            hasReview: buttonTexts.some(t => t.includes('review')),
            hasDone: buttonTexts.some(t => t === 'done'),
          };
        }, dismissBtn);
        
        // VERY STRICT: Must have success phrase, Done button, AND no form navigation buttons
        const hasSuccessPhrase = modalInfo.modalText.includes('application sent') || 
            modalInfo.modalText.includes('application submitted') ||
            modalInfo.modalText.includes('your application was sent');
        const hasFormButtons = modalInfo.hasBack || modalInfo.hasNext || modalInfo.hasSubmit || modalInfo.hasReview;
        
        // Only consider success if we have explicit success text AND Done button AND no form buttons
        if (hasSuccessPhrase && modalInfo.hasDone && !hasFormButtons) {
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
