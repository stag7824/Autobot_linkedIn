/**
 * LinkedIn Easy Apply Bot - AI Service
 * 
 * Uses Google Gemini as primary, OpenRouter (Mimo) as backup.
 * Answer Cache for learning from past answers.
 * 
 * @license MIT
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { OpenRouter } from '@openrouter/sdk';
import config, { getUserProfile } from '../config/index.js';
import * as jobLogger from './jobLogger.js';
import * as answerCache from './answerCache.js';

// AI providers
let geminiModel = null;
let openrouterClient = null;

// Track which provider is active
let activeProvider = null;
let geminiAvailable = false;
let openrouterAvailable = false;

// Current job ID for logging
let currentJobId = null;

/**
 * Set the current job ID for logging purposes
 */
export function setCurrentJobId(jobId) {
  currentJobId = jobId;
}

/**
 * Initialize AI providers (Gemini primary, OpenRouter backup)
 */
export async function initializeAI() {
  console.log('🤖 Initializing AI providers...');
  
  // Try Gemini first
  if (config.ai.geminiApiKey) {
    try {
      const genAI = new GoogleGenerativeAI(config.ai.geminiApiKey);
      geminiModel = genAI.getGenerativeModel({ model: config.ai.geminiModel });
      
      // Test connection
      const result = await geminiModel.generateContent('Say "ready" if you can hear me.');
      if (result.response.text()) {
        console.log(`✅ Gemini AI initialized (${config.ai.geminiModel})`);
        geminiAvailable = true;
        activeProvider = 'gemini';
      }
    } catch (error) {
      if (error.message?.includes('429') || error.message?.includes('quota')) {
        console.log('⚠️ Gemini rate limit hit - will use backup provider');
        // Still set up model for later
        const genAI = new GoogleGenerativeAI(config.ai.geminiApiKey);
        geminiModel = genAI.getGenerativeModel({ model: config.ai.geminiModel });
      } else {
        console.error('❌ Gemini initialization failed:', error.message);
      }
    }
  }

  // Initialize OpenRouter as backup
  if (config.ai.openrouterApiKey) {
    try {
      openrouterClient = new OpenRouter({
        apiKey: config.ai.openrouterApiKey,
      });
      
      // Test connection with a simple request
      const stream = await openrouterClient.chat.send({
        model: 'xiaomi/mimo-v2-flash:free',
        messages: [{ role: 'user', content: 'Say "ready"' }],
        stream: true,
        provider: { sort: 'throughput' },
      });
      
      let response = '';
      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content;
        if (content) response += content;
      }
      
      if (response) {
        console.log('✅ OpenRouter AI initialized (mimo-v2-flash:free)');
        openrouterAvailable = true;
        if (!activeProvider) activeProvider = 'openrouter';
      }
    } catch (error) {
      console.error('❌ OpenRouter initialization failed:', error.message);
    }
  }

  if (!geminiAvailable && !openrouterAvailable) {
    console.log('⚠️ No AI providers available - using preset answers only');
    return false;
  }

  console.log(`🎯 Active AI provider: ${activeProvider}`);
  return true;
}

/**
 * Get current AI provider status
 */
export function getAIStatus() {
  return {
    gemini: { available: geminiAvailable, active: activeProvider === 'gemini' },
    openrouter: { available: openrouterAvailable, active: activeProvider === 'openrouter' },
    activeProvider,
  };
}

/**
 * Switch to backup provider
 */
function switchToBackup() {
  if (activeProvider === 'gemini' && openrouterAvailable) {
    console.log('🔄 Switching to OpenRouter backup...');
    activeProvider = 'openrouter';
    return true;
  }
  if (activeProvider === 'openrouter' && geminiAvailable) {
    console.log('🔄 Switching back to Gemini...');
    activeProvider = 'gemini';
    return true;
  }
  return false;
}

/**
 * Safety settings for Gemini
 */
const safetySettings = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
];

/**
 * Call Gemini API
 */
async function callGemini(prompt) {
  if (!geminiModel) return null;
  
  try {
    const result = await geminiModel.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      safetySettings,
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 500,
      },
    });
    return result.response.text().trim();
  } catch (error) {
    if (error.message?.includes('429') || error.message?.includes('quota')) {
      console.log('⚠️ Gemini rate limited');
      geminiAvailable = false;
      switchToBackup();
    }
    throw error;
  }
}

/**
 * Call OpenRouter API (Mimo model)
 */
async function callOpenRouter(prompt) {
  if (!openrouterClient) return null;
  
  try {
    const stream = await openrouterClient.chat.send({
      model: 'xiaomi/mimo-v2-flash:free',
      messages: [{ role: 'user', content: prompt }],
      stream: true,
      streamOptions: { includeUsage: true },
      provider: { sort: 'throughput' },
    });
    
    let response = '';
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) response += content;
    }
    
    return response.trim();
  } catch (error) {
    console.log('⚠️ OpenRouter error:', error.message);
    throw error;
  }
}

/**
 * Call the active AI provider with automatic fallback
 */
async function callAI(prompt, retryCount = 0) {
  if (!activeProvider) return null;
  
  try {
    if (activeProvider === 'gemini') {
      return await callGemini(prompt);
    } else {
      return await callOpenRouter(prompt);
    }
  } catch (error) {
    // Try backup provider
    if (retryCount === 0 && switchToBackup()) {
      console.log(`🔄 Retrying with ${activeProvider}...`);
      return await callAI(prompt, retryCount + 1);
    }
    console.error('❌ All AI providers failed:', error.message);
    return null;
  }
}

/**
 * Answer a question using AI based on user profile and job context
 * Priority: 1) Cached/Verified answer 2) AI generated answer
 * @param {string} question - The question to answer
 * @param {string[]|null} options - Optional list of answer choices
 * @param {object} jobContext - Optional job context (title, company, description)
 */
export async function answerQuestion(question, options = null, jobContext = null) {
  // FIRST: Check answer cache for verified or previously used answers
  const cached = answerCache.getCachedAnswer(question, options);
  if (cached) {
    // Log cache hit
    if (currentJobId) {
      jobLogger.logAIRequest(currentJobId, {
        question,
        questionType: options ? 'multiple_choice' : 'text',
        options,
        provider: `cache (${cached.source})`,
        response: cached.answer,
        cached: true,
      });
    }
    return cached.answer;
  }

  if (!activeProvider) return null;

  const userProfile = getUserProfile();
  
  // Build job context section if available
  let jobContextSection = '';
  if (jobContext && (jobContext.description || jobContext.title)) {
    jobContextSection = `
JOB CONTEXT:
- Job Title: ${jobContext.title || 'Unknown'}
- Company: ${jobContext.company || 'Unknown'}
- Job Description (excerpt): ${(jobContext.description || '').substring(0, 1500)}
`;
  }
  
  let prompt;
  
  if (options && options.length > 0) {
    prompt = `You are an intelligent AI assistant helping fill out a job application form.
Based on the candidate's profile and the job they are applying for, select the BEST answer from the given options.

CANDIDATE PROFILE:
${userProfile}
${jobContextSection}
QUESTION: ${question}

OPTIONS:
${options.map((opt, i) => `${i + 1}. ${opt}`).join('\n')}

CRITICAL RULES - FOLLOW EXACTLY:
- ALWAYS respond in ENGLISH regardless of what language the question is in.
- Return ONLY the exact text of the best option, nothing else.

IMPORTANT FACTS ABOUT THE CANDIDATE:
- NO non-compete agreement exists - answer "No" to any non-compete questions
- NEVER worked at Hero, Wolt, foodora, Delivery Hero, Glovo, or ANY food delivery company
- NEVER worked at the company they are applying to before
- If asked "Have you worked at [company]?" → Select "No"
- If asked "Do you have a non-compete?" → Select "No"
- If asked about previous competitors → The candidate has NOT worked for any competitors

Choose the option that best represents the candidate. Do NOT add any explanation.`;
  } else {
    prompt = `You are an intelligent AI assistant helping fill out a job application form.
Answer the question concisely based on the candidate's profile and the job they are applying for.

CANDIDATE PROFILE:
${userProfile}
${jobContextSection}
QUESTION: ${question}

CRITICAL RULES - FOLLOW EXACTLY:
- ALWAYS respond in ENGLISH regardless of what language the question is in.

IMPORTANT FACTS ABOUT THE CANDIDATE (USE THESE FOR ANSWERS):
- NO non-compete agreement - if asked "Do you have a non-compete?", answer "No"
- NEVER worked at Hero, Wolt, foodora, Delivery Hero, Glovo, or ANY food delivery company
- NEVER worked at the company they are applying to before
- If asked "Have you previously worked at [company]?" → Answer "No"
- If asked about non-compete agreements → Answer "No" or "None" or "N/A"
- If asked about previous work at competitors → Answer "No"

INSTRUCTIONS:
1. If the question asks for **years of experience or a number**, return **only the number** (e.g., "3", "5").
2. If it's a **Yes/No question**, return **only "Yes" or "No"**.
3. If it requires a **short answer**, give a **single sentence** relevant to the job.
4. If it requires a **detailed response** (cover letter, message), keep it under 350 characters and make it relevant to the job.
5. Do NOT repeat the question in your answer.
6. Be professional and positive about the candidate's abilities.`;
  }

  let answer = null;
  let error = null;
  
  try {
    answer = await callAI(prompt);
  } catch (e) {
    error = e.message;
  }
  
  // Log the AI request to job logger
  if (currentJobId) {
    jobLogger.logAIRequest(currentJobId, {
      question,
      questionType: options ? 'multiple_choice' : 'text',
      options,
      provider: activeProvider,
      prompt,
      response: answer,
      error,
    });
  }
  
  if (answer) {
    // Cache the AI answer for future similar questions
    answerCache.cacheAnswer(question, answer, 'ai', options ? 'choice' : 'text');
    console.log(`🤖 AI answered (${activeProvider}): "${question.substring(0, 40)}..." → "${answer.substring(0, 40)}..."`);
  }
  return answer;
}

/**
 * Answer a checkbox question with a simple true/false
 * @param {string} checkboxLabel - The label text of the checkbox
 * @param {object} jobContext - Job context (title, company, description)
 * @returns {Promise<string>} - "true" or "false"
 */
export async function answerCheckboxQuestion(checkboxLabel, jobContext = null) {
  const userInfo = config.ai.userInfo || '';
  
  let prompt = `You are helping a job applicant decide whether to check a checkbox on a job application form.

APPLICANT PROFILE:
${userInfo.substring(0, 1000)}

`;

  if (jobContext) {
    prompt += `JOB CONTEXT:
- Position: ${jobContext.title || 'Unknown'}
- Company: ${jobContext.company || 'Unknown'}

`;
  }

  prompt += `CHECKBOX QUESTION/STATEMENT:
"${checkboxLabel}"

Based on the applicant's profile and the checkbox statement, should this checkbox be checked?

IMPORTANT RULES - FOLLOW STRICTLY:
- If it's about agreeing to terms/conditions/privacy/consent, ALWAYS answer "true"
- If it's about data processing or GDPR consent, ALWAYS answer "true"
- If it mentions "I consent", "I agree", "I acknowledge", ALWAYS answer "true"
- If it's a required consent checkbox, ALWAYS answer "true"
- If it asks about legal work authorization and the applicant has it, answer "true"
- If it asks about visa sponsorship need and the applicant DOES need sponsorship, answer "true"
- If it says "I do NOT require sponsorship" and the applicant DOES require sponsorship, answer "false"
- If it's about following the company on LinkedIn, answer "false"
- If it asks about non-compete agreements, the applicant has NONE, so answer accordingly
- If it asks about previous work at Hero/Wolt/foodora/Delivery Hero, answer "false" (never worked there)
- For work eligibility questions, be honest based on the profile

Respond with ONLY one word: "true" or "false"`;

  const answer = await callAI(prompt);
  const result = answer?.toLowerCase().trim() || 'false';
  console.log(`🤖 Checkbox AI (${activeProvider}): "${checkboxLabel.substring(0, 40)}..." → ${result}`);
  return result;
}

/**
 * Extract skills from job description for matching
 */
export async function extractSkillsFromJob(jobDescription) {
  const prompt = `Extract skills from this job description and classify them.
Return ONLY a valid JSON object in this exact format:
{
  "tech_stack": ["skill1", "skill2"],
  "technical_skills": ["skill1", "skill2"],
  "required_skills": ["skill1", "skill2"],
  "nice_to_have": ["skill1", "skill2"],
  "years_required": 0
}

JOB DESCRIPTION:
${jobDescription}`;

  try {
    const text = await callAI(prompt);
    if (!text) return null;
    
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return null;
  } catch (error) {
    console.error('❌ Failed to extract skills:', error.message);
    return null;
  }
}

/**
 * Check if candidate meets job requirements
 */
export async function checkJobMatch(jobDescription) {
  const skills = await extractSkillsFromJob(jobDescription);
  if (!skills) return { match: true, score: 50, reason: 'Could not analyze job' };

  const { currentExperience, completeRequirements, badWords } = config.jobFilter;
  
  // Check experience requirement
  if (currentExperience !== -1 && skills.years_required > 0) {
    if (skills.years_required > currentExperience + 2) {
      if (completeRequirements) {
        return {
          match: false,
          score: 20,
          reason: `Requires ${skills.years_required} years, you have ${currentExperience}`,
        };
      }
    }
  }

  // Check for bad words
  const jobLower = jobDescription.toLowerCase();
  for (const word of badWords) {
    if (jobLower.includes(word.toLowerCase())) {
      return {
        match: false,
        score: 0,
        reason: `Contains excluded term: "${word}"`,
      };
    }
  }

  return {
    match: true,
    score: 80,
    reason: 'Job matches your profile',
    skills,
  };
}

/**
 * Generate a tailored cover letter
 */
export async function generateCoverLetter(jobTitle, companyName, jobDescription) {
  const userProfile = getUserProfile();

  const prompt = `Write a brief, professional cover letter for this job application.

CANDIDATE PROFILE:
${userProfile}

JOB TITLE: ${jobTitle}
COMPANY: ${companyName}
JOB DESCRIPTION: ${jobDescription}

INSTRUCTIONS:
- Keep it under 250 words
- Be professional but personable
- Highlight relevant skills from the candidate's profile
- Show enthusiasm for the role
- Do NOT include addresses or dates
- Start with a greeting, end with a professional closing`;

  const result = await callAI(prompt);
  return result || config.resume.coverLetter || '';
}

/**
 * Currency conversion rates (approximate)
 */
const CURRENCY_RATES = {
  HUF_TO_EUR: 0.0025,  // 1 HUF ≈ 0.0025 EUR (400 HUF = 1 EUR)
  HUF_TO_USD: 0.0027,  // 1 HUF ≈ 0.0027 USD (370 HUF = 1 USD)
  EUR_TO_USD: 1.08,
  EUR_TO_HUF: 400,
  USD_TO_EUR: 0.93,
  USD_TO_HUF: 370,
};

/**
 * Convert salary to target currency and period
 */
function convertSalary(amount, fromCurrency, toCurrency, fromPeriod = 'monthly', toPeriod = 'annual') {
  let converted = amount;
  
  // Step 1: Convert period
  if (fromPeriod === 'monthly' && toPeriod === 'annual') {
    converted = converted * 12;
  } else if (fromPeriod === 'annual' && toPeriod === 'monthly') {
    converted = converted / 12;
  }
  
  // Step 2: Convert currency
  const from = fromCurrency.toUpperCase();
  const to = toCurrency.toUpperCase();
  
  if (from === to) return Math.round(converted);
  
  const rateKey = `${from}_TO_${to}`;
  if (CURRENCY_RATES[rateKey]) {
    converted = converted * CURRENCY_RATES[rateKey];
  }
  
  return Math.round(converted);
}

/**
 * Parse salary question to determine target currency and period
 */
function parseSalaryQuestion(question) {
  const q = question.toLowerCase();
  
  // Detect target currency
  let currency = null; // null means use source currency
  if (q.includes('euro') || q.includes('eur') || q.includes('€')) {
    currency = 'EUR';
  } else if (q.includes('huf') || q.includes('forint') || q.includes('ft')) {
    currency = 'HUF';
  } else if (q.includes('usd') || q.includes('dollar') || q.includes('$')) {
    currency = 'USD';
  } else if (q.includes('gbp') || q.includes('pound') || q.includes('£')) {
    currency = 'GBP';
  }
  
  // Detect target period
  let period = 'annual'; // default for job applications
  if (q.includes('month') || q.includes('per month') || q.includes('/month') || q.includes('monthly')) {
    period = 'monthly';
  } else if (q.includes('annual') || q.includes('year') || q.includes('per annum') || q.includes('/year') || q.includes('yearly')) {
    period = 'annual';
  }
  
  return { currency, period };
}

/**
 * Smart answer for common application questions (no AI needed)
 */
export function getPresetAnswer(question) {
  const q = question.toLowerCase();
  const { personal, application } = config;

  // Name questions
  if (q.includes('first name')) return personal.firstName;
  if (q.includes('last name')) return personal.lastName;
  if (q.includes('middle name')) return personal.middleName;
  if (q.includes('full name')) return `${personal.firstName} ${personal.lastName}`;

  // Contact questions
  if (q.includes('phone') || q.includes('mobile')) return personal.phoneNumber;
  
  // Email - but NOT for recommender/referral questions
  if (q.includes('email')) {
    if (q.includes('recommend') || q.includes('referr') || q.includes('employee') || q.includes('refer')) {
      return '';
    }
    return config.auth.email;
  }
  
  // Recommender/Referral questions - leave empty
  if (q.includes('recommend') || q.includes('referr') || q.includes('referred by')) {
    return '';
  }

  // Location questions
  if (q.includes('city')) return personal.currentCity;
  if (q.includes('state') || q.includes('province')) return personal.state;
  if (q.includes('zip') || q.includes('postal')) return personal.zipcode;
  if (q.includes('country')) return personal.country;
  if (q.includes('street') || q.includes('address')) return personal.street;

  // Experience questions - ONLY match general experience, not technology-specific
  // Technology-specific questions like "years with React.js" should go to AI
  if (q.includes('years of experience') || q.includes('how many years')) {
    // Check if it's asking about a specific technology/skill
    const techKeywords = [
      'react', 'angular', 'vue', 'node', 'python', 'java', 'javascript', 'typescript',
      'three.js', 'next.js', 'express', 'spring', 'django', 'flask', 'docker', 'kubernetes',
      'aws', 'azure', 'gcp', 'sql', 'mongodb', 'postgres', 'redis', 'graphql', 'rest',
      'aec', 'cad', 'bim', 'revit', 'unity', 'unreal', 'webgl', 'opengl', 'c++', 'c#',
      'rust', 'go', 'swift', 'kotlin', 'flutter', 'mobile', 'ios', 'android', 'ml',
      'ai', 'machine learning', 'deep learning', 'tensorflow', 'pytorch', 'data science',
      'devops', 'ci/cd', 'jenkins', 'terraform', 'ansible', 'linux', 'agile', 'scrum'
    ];
    
    const isTechSpecific = techKeywords.some(tech => q.includes(tech));
    
    // Only return preset for general experience questions
    if (!isTechSpecific) {
      return application.yearsOfExperience;
    }
    // Tech-specific questions will fall through to AI
  }

  // Visa questions
  if (q.includes('visa') || q.includes('sponsorship') || q.includes('authorized to work')) {
    if (q.includes('require') || q.includes('need')) {
      return application.requireVisa;
    }
  }

  // SMART SALARY HANDLING with currency and period conversion
  if (q.includes('salary') || q.includes('compensation') || q.includes('pay') || q.includes('earning') || q.includes('bérigény')) {
    const { currency: targetCurrency, period: targetPeriod } = parseSalaryQuestion(question);
    const sourceCurrency = application.salaryCurrency || 'HUF';
    const sourcePeriod = 'monthly'; // User's salary is monthly
    
    let baseSalary;
    let isMaxSalary = false;
    
    // Determine which salary to use
    if (q.includes('current')) {
      baseSalary = application.currentSalary || 0;
    } else if (q.includes('max') || q.includes('maximum') || q.includes('upper')) {
      baseSalary = application.maxSalary || Math.round(application.desiredSalary * 1.25);
      isMaxSalary = true;
    } else {
      baseSalary = application.desiredSalary || 0;
    }
    
    // If target currency detected, convert
    if (targetCurrency && targetCurrency !== sourceCurrency) {
      const convertedSalary = convertSalary(
        baseSalary,
        sourceCurrency,
        targetCurrency,
        sourcePeriod,
        targetPeriod
      );
      console.log(`   💰 Salary conversion: ${baseSalary} ${sourceCurrency}/${sourcePeriod} → ${convertedSalary} ${targetCurrency}/${targetPeriod}`);
      return convertedSalary.toString();
    }
    
    // No currency conversion needed, but may need period conversion
    if (targetPeriod === 'annual' && sourcePeriod === 'monthly') {
      const annualSalary = baseSalary * 12;
      console.log(`   💰 Salary (annual): ${baseSalary} ${sourceCurrency}/month → ${annualSalary} ${sourceCurrency}/year`);
      return annualSalary.toString();
    }
    
    // Return as-is
    return baseSalary.toString();
  }

  // Notice period
  if (q.includes('notice') || q.includes('start date') || q.includes('when can you')) {
    if (application.noticePeriod === 0) return 'Immediately';
    return `${application.noticePeriod} days`;
  }

  // LinkedIn/Website
  if (q.includes('linkedin')) return application.linkedInUrl;
  if (q.includes('website') || q.includes('portfolio') || q.includes('github')) {
    return application.website;
  }

  // Disability/Veteran
  if (q.includes('disability') || q.includes('disabled')) return personal.disabilityStatus;
  if (q.includes('veteran')) return personal.veteranStatus;
  if (q.includes('gender')) return personal.gender;
  if (q.includes('ethnicity') || q.includes('race')) return personal.ethnicity;

  // Citizenship
  if (q.includes('citizen') || q.includes('authorization') || q.includes('work status')) {
    return application.citizenshipStatus;
  }

  // Education
  if (q.includes('highest') && (q.includes('degree') || q.includes('education'))) {
    return config.jobFilter.hasMasters ? "Master's Degree" : "Bachelor's Degree";
  }

  // Yes/No patterns
  if (q.includes('are you') || q.includes('do you') || q.includes('have you') || q.includes('can you')) {
    if (q.includes('relocate') || q.includes('travel')) return 'Yes';
    if (q.includes('currently employed')) return application.recentEmployer ? 'Yes' : 'No';
    if (q.includes('legally authorized')) {
      return application.requireVisa === 'No' ? 'Yes' : 'No';
    }
  }

  return null; // No preset answer, use AI
}

// Re-export for backwards compatibility
export { initializeAI as initializeGemini };

export default {
  initializeAI,
  initializeGemini: initializeAI,
  getAIStatus,
  setCurrentJobId,
  answerQuestion,
  extractSkillsFromJob,
  checkJobMatch,
  generateCoverLetter,
  getPresetAnswer,
};
