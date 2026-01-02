/**
 * LinkedIn Easy Apply Bot - Configuration Loader
 * 
 * Loads all configuration from environment variables with validation and defaults.
 * 
 * @license MIT
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from project root (2 levels up from src/config/)
dotenv.config({ path: join(__dirname, '..', '..', '.env') });

/**
 * Parse JSON from environment variable with fallback
 * Handles double-escaped JSON strings from Coolify/Docker
 */
function parseJSON(envVar, defaultValue) {
  if (!envVar) return defaultValue;
  
  let value = envVar;
  
  // Handle double-escaped JSON from Coolify (\" becomes \\\")
  // Try to detect and fix double-escaping
  if (value.includes('\\"') || value.includes('\\\\')) {
    // Replace escaped quotes with regular quotes
    value = value.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  
  try {
    const parsed = JSON.parse(value);
    console.log(`✅ Parsed env var successfully: ${Array.isArray(parsed) ? `array with ${parsed.length} items` : typeof parsed}`);
    return parsed;
  } catch (e) {
    console.error(`⚠️ Failed to parse JSON env var: ${envVar?.substring(0, 100)}...`);
    console.error(`   After cleanup: ${value?.substring(0, 100)}...`);
    console.error(`   Error: ${e.message}`);
    return defaultValue;
  }
}

/**
 * Parse boolean from environment variable
 */
function parseBool(envVar, defaultValue = false) {
  if (envVar === undefined || envVar === '') return defaultValue;
  return envVar.toLowerCase() === 'true';
}

/**
 * Parse integer from environment variable
 */
function parseInt(envVar, defaultValue) {
  const parsed = Number.parseInt(envVar, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Complete configuration object loaded from environment variables
 */
// Determine if we're in production mode
const isProduction = process.env.NODE_ENV === 'production';

const config = {
  // ═══════════════════════════════════════════════════════════════════════════
  // ENVIRONMENT
  // ═══════════════════════════════════════════════════════════════════════════
  env: {
    nodeEnv: process.env.NODE_ENV || 'development',
    isProduction,
    isDevelopment: !isProduction,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // AUTHENTICATION
  // ═══════════════════════════════════════════════════════════════════════════
  auth: {
    email: process.env.USER_ID || '',
    password: process.env.USER_PASSWORD || '',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // BOT SETTINGS
  // ═══════════════════════════════════════════════════════════════════════════
  bot: {
    dailyLimit: parseInt(process.env.DAILY_LIMIT, 100),
    headless: parseBool(process.env.HEADLESS, false),
    savePath: process.env.SAVE_PATH || './data/',
    sessionPath: process.env.SESSION_PATH || './data/session', // Browser session persistence
    runNonStop: parseBool(process.env.RUN_NON_STOP, false),
    pauseBeforeSubmit: parseBool(process.env.PAUSE_BEFORE_SUBMIT, false),
    pauseAtFailedQuestion: parseBool(process.env.PAUSE_AT_FAILED_QUESTION, false),
    followCompanies: parseBool(process.env.FOLLOW_COMPANIES, false),
    clickGap: parseInt(process.env.CLICK_GAP, 1),
    stealthMode: parseBool(process.env.STEALTH_MODE, true),
    keepScreenAwake: parseBool(process.env.KEEP_SCREEN_AWAKE, true),
    skipResumeUpload: parseBool(process.env.SKIP_RESUME_UPLOAD, true), // LinkedIn already has resume
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // SEARCH CONFIGURATION
  // ═══════════════════════════════════════════════════════════════════════════
  search: {
    terms: parseJSON(process.env.SEARCH_TERMS, ['Software Engineer']),
    location: process.env.SEARCH_LOCATION || '',
    switchAfter: parseInt(process.env.SWITCH_AFTER, 30),
    randomize: parseBool(process.env.RANDOMIZE_SEARCH, false),
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // LINKEDIN FILTERS
  // ═══════════════════════════════════════════════════════════════════════════
  filters: {
    sortBy: process.env.SORT_BY || 'Most recent',
    datePosted: process.env.DATE_POSTED || 'Past week',
    salary: process.env.SALARY || '',
    easyApplyOnly: parseBool(process.env.EASY_APPLY_ONLY, true),
    experienceLevel: parseJSON(process.env.EXPERIENCE_LEVEL, []),
    jobType: parseJSON(process.env.JOB_TYPE, ['Full-time']),
    onSite: parseJSON(process.env.ON_SITE, []),
    companies: parseJSON(process.env.COMPANIES, []),
    locations: parseJSON(process.env.LOCATIONS, []),
    under10Applicants: parseBool(process.env.UNDER_10_APPLICANTS, false),
    inYourNetwork: parseBool(process.env.IN_YOUR_NETWORK, false),
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // JOB FILTERING
  // ═══════════════════════════════════════════════════════════════════════════
  jobFilter: {
    badWords: parseJSON(process.env.BAD_WORDS, []),
    badJobTitles: parseJSON(process.env.BAD_JOB_TITLES, []),
    companyBadWords: parseJSON(process.env.COMPANY_BAD_WORDS, []),
    companyGoodWords: parseJSON(process.env.COMPANY_GOOD_WORDS, []),
    hasSecurityClearance: parseBool(process.env.HAS_SECURITY_CLEARANCE, false),
    hasMasters: parseBool(process.env.HAS_MASTERS, false),
    currentExperience: parseInt(process.env.CURRENT_EXPERIENCE, -1),
    completeRequirements: parseBool(process.env.COMPLETE_REQUIREMENTS, false),
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // PERSONAL INFORMATION
  // ═══════════════════════════════════════════════════════════════════════════
  personal: {
    firstName: process.env.FIRST_NAME || '',
    middleName: process.env.MIDDLE_NAME || '',
    lastName: process.env.LAST_NAME || '',
    phoneNumber: process.env.PHONE_NUMBER || '',
    currentCity: process.env.CURRENT_CITY || '',
    street: process.env.STREET || '',
    state: process.env.STATE || '',
    zipcode: process.env.ZIPCODE || '',
    country: process.env.COUNTRY || 'United States',
    // Equal Opportunity
    ethnicity: process.env.ETHNICITY || '',
    gender: process.env.GENDER || '',
    disabilityStatus: process.env.DISABILITY_STATUS || 'Decline',
    veteranStatus: process.env.VETERAN_STATUS || 'Decline',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // APPLICATION DETAILS
  // ═══════════════════════════════════════════════════════════════════════════
  application: {
    yearsOfExperience: process.env.YEARS_OF_EXPERIENCE || '3',
    requireVisa: process.env.REQUIRE_VISA || 'Yes',
    website: process.env.WEBSITE || '',
    linkedInUrl: process.env.LINKEDIN_URL || '',
    citizenshipStatus: process.env.CITIZENSHIP_STATUS || '',
    desiredSalary: parseInt(process.env.DESIRED_SALARY, 0),
    maxSalary: parseInt(process.env.MAX_SALARY, 0),
    salaryCurrency: process.env.SALARY_CURRENCY || 'USD',
    currentSalary: parseInt(process.env.CURRENT_SALARY, 0),
    noticePeriod: parseInt(process.env.NOTICE_PERIOD, 0),
    recentEmployer: process.env.RECENT_EMPLOYER || '',
    confidenceLevel: process.env.CONFIDENCE_LEVEL || '8',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // RESUME DATA
  // ═══════════════════════════════════════════════════════════════════════════
  resume: {
    path: process.env.RESUME_PATH || './data/resume.pdf',
    headline: process.env.LINKEDIN_HEADLINE || '',
    summary: process.env.LINKEDIN_SUMMARY || '',
    coverLetter: process.env.COVER_LETTER || '',
    userInfo: process.env.USER_INFO || '',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // AI CONFIGURATION
  // ═══════════════════════════════════════════════════════════════════════════
  ai: {
    // Gemini (Primary)
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    // OpenRouter (Backup - Mimo model, free tier)
    openrouterApiKey: process.env.OPENROUTER_API_KEY || process.env.OPENROUTE_API_KEY || '',
    openrouterModel: process.env.OPENROUTER_MODEL || 'xiaomi/mimo-v2-flash:free',
    enabled: !!(process.env.GEMINI_API_KEY || process.env.OPENROUTER_API_KEY || process.env.OPENROUTE_API_KEY),
    // Gemini Free Tier Rate Limits
    rateLimits: {
      rpm: parseInt(process.env.GEMINI_RPM, 5),   // Requests per minute
      rpd: parseInt(process.env.GEMINI_RPD, 20),  // Requests per day
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // WEB DASHBOARD
  // ═══════════════════════════════════════════════════════════════════════════
  web: {
    enabled: parseBool(process.env.WEB_DASHBOARD_ENABLED, true),
    port: parseInt(process.env.WEB_PORT, 3000),
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // NOTIFICATIONS
  // ═══════════════════════════════════════════════════════════════════════════
  notifications: {
    ntfyUrl: process.env.NTFY_URL || '',
    enabled: !!process.env.NTFY_URL,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // LINKEDIN URLs & SELECTORS
  // ═══════════════════════════════════════════════════════════════════════════
  linkedin: {
    baseUrl: 'https://www.linkedin.com',
    loginUrl: 'https://www.linkedin.com/login',
    jobsUrl: 'https://www.linkedin.com/jobs',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // TIMING & DELAYS (for anti-detection & API rate limiting)
  // ═══════════════════════════════════════════════════════════════════════════
  // In PRODUCTION: 2-3 minute delay between applications to avoid Gemini API rate limits
  // In DEVELOPMENT: Quick delays for faster testing
  delays: {
    betweenActions: { min: 1000, max: 3000 },
    // Production: 120-180 seconds (2-3 min) to stay under 5 RPM and 20 RPD
    // Development: 5-15 seconds for quick testing
    betweenApplications: isProduction 
      ? { min: 120000, max: 180000 }  // 2-3 minutes in production
      : { min: 5000, max: 15000 },     // 5-15 seconds in development
    typing: { min: 50, max: 150 },
    pageLoad: 5000,
    sessionBreak: { after: 10, duration: { min: 30000, max: 60000 } },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // CSS SELECTORS
  // ═══════════════════════════════════════════════════════════════════════════
  selectors: {
    login: {
      emailInput: '#username',
      passwordInput: '#password',
      submitButton: 'button[type="submit"]',
      verificationCheck: '.challenge-dialog, #captcha-internal, [class*="verification"], [class*="checkpoint"]',
    },
    jobs: {
      list: '.scaffold-layout__list-item, .jobs-search-results__list-item',
      card: '.job-card-container, .jobs-search-results__list-item',
      title: '.job-card-list__title, .artdeco-entity-lockup__title',
      company: '.job-card-container__company-name, .artdeco-entity-lockup__subtitle',
      location: '.job-card-container__metadata-item, .artdeco-entity-lockup__caption',
      easyApplyBadge: '.job-card-container__apply-method, [class*="easy-apply"]',
    },
    easyApply: {
      button: '.jobs-apply-button, button[aria-label*="Easy Apply"], button.jobs-apply-button--top-card',
      modal: '.jobs-easy-apply-modal, [class*="easy-apply-modal"], .artdeco-modal',
      nextButton: 'button[aria-label="Continue to next step"], button[data-easy-apply-next-button]',
      reviewButton: 'button[aria-label="Review your application"]',
      submitButton: 'button[aria-label="Submit application"]',
      closeButton: 'button[aria-label="Dismiss"], button[data-test-modal-close-btn]',
      discardButton: 'button[data-test-dialog-secondary-btn], button[data-control-name="discard_application_confirm_btn"]',
      errorMessage: '.artdeco-inline-feedback--error',
      successMessage: '.artdeco-modal__content, [class*="success"]',
    },
    form: {
      textInput: 'input[type="text"], input[type="tel"], input[type="email"], input[type="number"]',
      textarea: 'textarea',
      select: 'select',
      radio: 'input[type="radio"]',
      checkbox: 'input[type="checkbox"]',
      fileInput: 'input[type="file"]',
      requiredField: '[required], [aria-required="true"]',
      fieldLabel: 'label, .fb-form-element-label, [class*="label"]',
    },
  },
};

/**
 * Validate required configuration
 */
export function validateConfig() {
  const errors = [];

  if (!config.auth.email) {
    errors.push('USER_ID (email) is required');
  }
  if (!config.auth.password) {
    errors.push('USER_PASSWORD is required');
  }
  if (config.search.terms.length === 0) {
    errors.push('At least one search term is required in SEARCH_TERMS');
  }

  if (errors.length > 0) {
    console.error('❌ Configuration errors:');
    errors.forEach(err => console.error(`   - ${err}`));
    return false;
  }

  return true;
}

/**
 * Get full user profile for AI context
 */
export function getUserProfile() {
  const { personal, application, resume, jobFilter } = config;
  
  return `
Name: ${personal.firstName} ${personal.middleName} ${personal.lastName}
Phone: ${personal.phoneNumber}
Location: ${personal.currentCity}, ${personal.state}, ${personal.country}
Years of Experience: ${application.yearsOfExperience}
Current Experience Level: ${jobFilter.currentExperience} years
Education: ${jobFilter.hasMasters ? 'Masters Degree' : 'Bachelors Degree'}
Visa Sponsorship Required: ${application.requireVisa}
Citizenship Status: ${application.citizenshipStatus}
Notice Period: ${application.noticePeriod} days
Desired Salary: $${application.desiredSalary}
Website: ${application.website}
LinkedIn: ${application.linkedInUrl}

Professional Headline: ${resume.headline}

Summary: ${resume.summary}

Additional Information:
${resume.userInfo}
`.trim();
}

/**
 * Build LinkedIn job search URL with filters
 */
export function buildSearchUrl(keyword, page = 0) {
  const params = new URLSearchParams();
  
  params.set('keywords', keyword);
  params.set('f_AL', 'true'); // Easy Apply only
  params.set('start', (page * 25).toString());
  
  // Location
  if (config.search.location) {
    params.set('location', config.search.location);
  }
  
  // Sort by
  if (config.filters.sortBy === 'Most recent') {
    params.set('sortBy', 'DD');
  }
  
  // Date posted
  const dateMap = {
    'Past 24 hours': 'r86400',
    'Past week': 'r604800',
    'Past month': 'r2592000',
  };
  if (dateMap[config.filters.datePosted]) {
    params.set('f_TPR', dateMap[config.filters.datePosted]);
  }
  
  // Experience level
  const expMap = {
    'Internship': '1',
    'Entry level': '2',
    'Associate': '3',
    'Mid-Senior level': '4',
    'Director': '5',
    'Executive': '6',
  };
  const expLevels = config.filters.experienceLevel
    .map(e => expMap[e])
    .filter(Boolean);
  if (expLevels.length > 0) {
    params.set('f_E', expLevels.join(','));
  }
  
  // Job type
  const typeMap = {
    'Full-time': 'F',
    'Part-time': 'P',
    'Contract': 'C',
    'Temporary': 'T',
    'Internship': 'I',
    'Volunteer': 'V',
    'Other': 'O',
  };
  const jobTypes = config.filters.jobType
    .map(t => typeMap[t])
    .filter(Boolean);
  if (jobTypes.length > 0) {
    params.set('f_JT', jobTypes.join(','));
  }
  
  // Remote/On-site/Hybrid
  const siteMap = {
    'On-site': '1',
    'Remote': '2',
    'Hybrid': '3',
  };
  const workTypes = config.filters.onSite
    .map(s => siteMap[s])
    .filter(Boolean);
  if (workTypes.length > 0) {
    params.set('f_WT', workTypes.join(','));
  }
  
  return `${config.linkedin.jobsUrl}/search/?${params.toString()}`;
}

export default config;
