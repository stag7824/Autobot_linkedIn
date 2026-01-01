/**
 * LinkedIn Easy Apply Bot - Gemini AI Service
 * 
 * Uses Google's Gemini API to answer application questions intelligently.
 * 
 * @license MIT
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import config, { getUserProfile } from '../config/index.js';

let genAI = null;
let model = null;

/**
 * Initialize Gemini AI client
 */
export async function initializeGemini() {
  if (!config.ai.geminiApiKey) {
    console.log('⚠️ Gemini API key not configured - AI answering disabled');
    return false;
  }

  try {
    genAI = new GoogleGenerativeAI(config.ai.geminiApiKey);
    model = genAI.getGenerativeModel({ model: config.ai.geminiModel });
    
    // Test the connection with a simple prompt
    const result = await model.generateContent('Say "ready" if you can hear me.');
    if (result.response.text()) {
      console.log(`✅ Gemini AI initialized (${config.ai.geminiModel})`);
      return true;
    }
  } catch (error) {
    // Handle rate limiting gracefully
    if (error.message && (error.message.includes('429') || error.message.includes('quota'))) {
      console.log('⚠️ Gemini rate limit hit - AI will retry later');
      // Still set up the model, it will work when quota resets
      genAI = new GoogleGenerativeAI(config.ai.geminiApiKey);
      model = genAI.getGenerativeModel({ model: config.ai.geminiModel });
      return true; // Consider initialized, will work after rate limit resets
    }
    console.error('❌ Failed to initialize Gemini:', error.message);
    return false;
  }
}

/**
 * Safety settings for Gemini (less restrictive for job application content)
 */
const safetySettings = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
];

/**
 * Answer a question using AI based on user profile
 */
export async function answerQuestion(question, options = null) {
  if (!model) {
    return null;
  }

  const userProfile = getUserProfile();
  
  let prompt;
  
  if (options && options.length > 0) {
    // Multiple choice question
    prompt = `You are an intelligent AI assistant helping fill out a job application form.
Based on the candidate's profile below, select the BEST answer from the given options.

CANDIDATE PROFILE:
${userProfile}

QUESTION: ${question}

OPTIONS:
${options.map((opt, i) => `${i + 1}. ${opt}`).join('\n')}

INSTRUCTIONS:
- Return ONLY the exact text of the best option, nothing else.
- Choose the option that best represents the candidate's qualifications.
- If unsure, choose the most positive/favorable option for the candidate.
- Do NOT add any explanation or additional text.`;
  } else {
    // Free text question
    prompt = `You are an intelligent AI assistant helping fill out a job application form.
Answer the question concisely based on the candidate's profile.

CANDIDATE PROFILE:
${userProfile}

QUESTION: ${question}

INSTRUCTIONS:
1. If the question asks for **years of experience or a number**, return **only the number** (e.g., "3", "5").
2. If it's a **Yes/No question**, return **only "Yes" or "No"**.
3. If it requires a **short answer**, give a **single sentence**.
4. If it requires a **detailed response**, keep it under 350 characters.
5. Do NOT repeat the question in your answer.
6. Be professional and positive about the candidate's abilities.
7. For visa/authorization questions, answer honestly based on the profile.`;
  }

  try {
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      safetySettings,
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 500,
      },
    });

    const answer = result.response.text().trim();
    console.log(`🤖 AI answered: "${question.substring(0, 50)}..." → "${answer.substring(0, 50)}..."`);
    return answer;
  } catch (error) {
    console.error('❌ AI error:', error.message);
    return null;
  }
}

/**
 * Extract skills from job description for matching
 */
export async function extractSkillsFromJob(jobDescription) {
  if (!model) {
    return null;
  }

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
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      safetySettings,
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 1000,
      },
    });

    const text = result.response.text().trim();
    // Extract JSON from response
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

  const { currentExperience, completeRequirements } = config.jobFilter;
  
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
  const badWords = config.jobFilter.badWords;
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
  if (!model) {
    return config.resume.coverLetter || '';
  }

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

  try {
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      safetySettings,
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 500,
      },
    });

    return result.response.text().trim();
  } catch (error) {
    console.error('❌ Failed to generate cover letter:', error.message);
    return config.resume.coverLetter || '';
  }
}

/**
 * Smart answer for common application questions
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
  if (q.includes('email')) return config.auth.email;

  // Location questions
  if (q.includes('city')) return personal.currentCity;
  if (q.includes('state') || q.includes('province')) return personal.state;
  if (q.includes('zip') || q.includes('postal')) return personal.zipcode;
  if (q.includes('country')) return personal.country;
  if (q.includes('street') || q.includes('address')) return personal.street;

  // Experience questions
  if (q.includes('years of experience') || q.includes('how many years')) {
    return application.yearsOfExperience;
  }

  // Visa questions
  if (q.includes('visa') || q.includes('sponsorship') || q.includes('authorized to work')) {
    if (q.includes('require') || q.includes('need')) {
      return application.requireVisa;
    }
  }

  // Salary questions
  if (q.includes('salary') || q.includes('compensation') || q.includes('pay')) {
    if (q.includes('expected') || q.includes('desired') || q.includes('requirement')) {
      // Return salary with currency if specified (e.g., "950000 HUF")
      if (application.salaryCurrency && application.salaryCurrency !== 'USD') {
        return `${application.desiredSalary} ${application.salaryCurrency}`;
      }
      return application.desiredSalary.toString();
    }
    if (q.includes('current')) {
      return application.currentSalary.toString();
    }
  }

  // Notice period
  if (q.includes('notice') || q.includes('start date') || q.includes('when can you')) {
    if (application.noticePeriod === 0) {
      return 'Immediately';
    }
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

export default {
  initializeGemini,
  answerQuestion,
  extractSkillsFromJob,
  checkJobMatch,
  generateCoverLetter,
  getPresetAnswer,
};
