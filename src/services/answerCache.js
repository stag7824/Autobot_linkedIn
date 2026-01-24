/**
 * Answer Cache / Learning System
 * 
 * Stores Q&A from applications, allows user corrections,
 * and uses cached answers for future similar questions.
 * 
 * Priority:
 * 1. User-verified answers (manually corrected)
 * 2. Previously cached answers (from past applications)
 * 3. AI-generated answers (new questions)
 * 
 * @license MIT
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const CACHE_FILE = path.join(DATA_DIR, 'answer_cache.json');
const HISTORY_FILE = path.join(DATA_DIR, 'questions_history.json');

// In-memory cache for fast lookups
let answerCache = {
  // Normalized question -> answer mapping
  // Key: normalized question text
  // Value: { answer, verified, source, usageCount, lastUsed, fieldType }
  answers: {},
  
  // Stats
  stats: {
    totalQuestions: 0,
    verifiedAnswers: 0,
    aiAnswers: 0,
    cacheHits: 0,
    cacheMisses: 0,
  }
};

// Question history (for reviewing what was answered in each application)
let questionHistory = [];

/**
 * Initialize - load from disk
 */
export function initAnswerCache() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    
    if (fs.existsSync(CACHE_FILE)) {
      const data = fs.readFileSync(CACHE_FILE, 'utf8');
      answerCache = JSON.parse(data);
      console.log(`📚 Loaded answer cache: ${Object.keys(answerCache.answers).length} cached answers`);
    }
    
    if (fs.existsSync(HISTORY_FILE)) {
      const data = fs.readFileSync(HISTORY_FILE, 'utf8');
      questionHistory = JSON.parse(data);
    }
  } catch (error) {
    console.error('Failed to load answer cache:', error.message);
  }
}

/**
 * Save cache to disk
 */
function saveCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(answerCache, null, 2));
  } catch (error) {
    console.error('Failed to save answer cache:', error.message);
  }
}

/**
 * Save history to disk
 */
function saveHistory() {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(questionHistory, null, 2));
  } catch (error) {
    console.error('Failed to save question history:', error.message);
  }
}

/**
 * Normalize question text for matching
 * Removes extra whitespace, lowercases, removes punctuation variations
 */
function normalizeQuestion(question) {
  return question
    .toLowerCase()
    .replace(/[*?:]/g, '') // Remove asterisks, question marks, colons
    .replace(/\s+/g, ' ')  // Normalize whitespace
    .replace(/^\s+|\s+$/g, '') // Trim
    .replace(/how many years of (work )?experience do you have (with|in|using|working with)?/gi, 'experience years ')
    .replace(/years? of experience/gi, 'experience years')
    .replace(/do you have experience (with|in|using)?/gi, 'experience ')
    .replace(/are you (willing|able) to/gi, 'willing to ')
    .replace(/\?/g, '');
}

/**
 * Find similar question in cache
 * Returns cached answer if found, null otherwise
 */
function findSimilarQuestion(question) {
  const normalized = normalizeQuestion(question);
  
  // Direct match
  if (answerCache.answers[normalized]) {
    return { key: normalized, entry: answerCache.answers[normalized], matchType: 'exact' };
  }
  
  // Fuzzy matching - check for similar questions
  const words = normalized.split(' ').filter(w => w.length > 2);
  let bestMatch = null;
  let bestScore = 0;
  
  for (const [key, entry] of Object.entries(answerCache.answers)) {
    const keyWords = key.split(' ').filter(w => w.length > 2);
    
    // Count matching words
    let matchingWords = 0;
    for (const word of words) {
      if (keyWords.includes(word) || key.includes(word)) {
        matchingWords++;
      }
    }
    
    // Special handling for technology-specific questions
    const techKeywords = ['react', 'angular', 'vue', 'node', 'python', 'java', 'typescript', 
      'javascript', 'three.js', 'threejs', 'next.js', 'nextjs', 'aec', 'sql', 'docker',
      'kubernetes', 'aws', 'azure', 'gcp', 'mongodb', 'postgresql', 'redis'];
    
    const questionTech = techKeywords.find(t => normalized.includes(t));
    const keyTech = techKeywords.find(t => key.includes(t));
    
    // If both mention same tech, high priority match
    if (questionTech && keyTech && questionTech === keyTech) {
      const score = matchingWords / Math.max(words.length, 1) + 0.5; // Boost for tech match
      if (score > bestScore) {
        bestScore = score;
        bestMatch = { key, entry, matchType: 'tech_match', tech: questionTech };
      }
    } else if (!questionTech && !keyTech) {
      // Neither mentions tech - general matching
      const score = matchingWords / Math.max(words.length, 1);
      if (score > 0.6 && score > bestScore) {
        bestScore = score;
        bestMatch = { key, entry, matchType: 'fuzzy', score };
      }
    }
  }
  
  return bestMatch;
}

/**
 * Get cached answer for a question
 * Returns { answer, source, cached: true } if found, null otherwise
 */
export function getCachedAnswer(question, options = null) {
  const match = findSimilarQuestion(question);
  
  if (match) {
    const entry = match.entry;
    
    // Update usage stats
    entry.usageCount = (entry.usageCount || 0) + 1;
    entry.lastUsed = new Date().toISOString();
    answerCache.stats.cacheHits++;
    saveCache();
    
    console.log(`   📚 Cache hit (${match.matchType}): "${question.substring(0, 40)}..." → "${entry.answer}"`);
    
    // For multiple choice, verify answer is in options
    if (options && Array.isArray(options) && options.length > 0) {
      const optionMatch = options.find(opt => 
        opt.toLowerCase().includes(entry.answer.toLowerCase()) ||
        entry.answer.toLowerCase().includes(opt.toLowerCase())
      );
      if (!optionMatch) {
        console.log(`   ⚠️ Cached answer "${entry.answer}" not in options, will use AI`);
        return null;
      }
    }
    
    return {
      answer: entry.answer,
      source: entry.verified ? 'verified' : 'cached',
      cached: true,
      matchType: match.matchType,
    };
  }
  
  answerCache.stats.cacheMisses++;
  return null;
}

/**
 * Store answer in cache (from AI or preset)
 */
export function cacheAnswer(question, answer, source = 'ai', fieldType = 'text') {
  const normalized = normalizeQuestion(question);
  
  // Don't overwrite verified answers
  if (answerCache.answers[normalized]?.verified) {
    console.log(`   🔒 Keeping verified answer for: "${question.substring(0, 40)}..."`);
    return;
  }
  
  answerCache.answers[normalized] = {
    originalQuestion: question,
    answer: String(answer),
    source,
    verified: false,
    fieldType,
    usageCount: 1,
    createdAt: new Date().toISOString(),
    lastUsed: new Date().toISOString(),
  };
  
  answerCache.stats.totalQuestions = Object.keys(answerCache.answers).length;
  if (source === 'ai') answerCache.stats.aiAnswers++;
  
  saveCache();
}

/**
 * Record question to history (for reviewing applications)
 */
export function recordToHistory(data) {
  const { question, answer, source, fieldType, jobId, company, jobTitle, options } = data;
  
  questionHistory.unshift({
    question,
    answer,
    source,
    fieldType,
    jobId,
    company,
    jobTitle,
    options,
    timestamp: new Date().toISOString(),
  });
  
  // Keep last 1000 entries
  if (questionHistory.length > 1000) {
    questionHistory = questionHistory.slice(0, 1000);
  }
  
  saveHistory();
}

/**
 * Update/correct an answer (user verification)
 */
export function updateAnswer(question, newAnswer) {
  const normalized = normalizeQuestion(question);
  
  if (answerCache.answers[normalized]) {
    answerCache.answers[normalized].answer = String(newAnswer);
    answerCache.answers[normalized].verified = true;
    answerCache.answers[normalized].verifiedAt = new Date().toISOString();
    answerCache.stats.verifiedAnswers++;
  } else {
    // Create new verified entry
    answerCache.answers[normalized] = {
      originalQuestion: question,
      answer: String(newAnswer),
      source: 'user',
      verified: true,
      fieldType: 'text',
      usageCount: 0,
      createdAt: new Date().toISOString(),
      verifiedAt: new Date().toISOString(),
    };
  }
  
  saveCache();
  console.log(`✅ Answer updated & verified: "${question.substring(0, 40)}..." → "${newAnswer}"`);
  return true;
}

/**
 * Delete an answer from cache
 */
export function deleteAnswer(question) {
  const normalized = normalizeQuestion(question);
  if (answerCache.answers[normalized]) {
    delete answerCache.answers[normalized];
    saveCache();
    return true;
  }
  return false;
}

/**
 * Clear a bad cached answer (e.g., placeholder values)
 */
export function clearCachedAnswer(question) {
  const normalized = normalizeQuestion(question);
  if (answerCache.answers[normalized]) {
    const oldAnswer = answerCache.answers[normalized].answer;
    delete answerCache.answers[normalized];
    saveCache();
    console.log(`   🗑️ Cleared bad cache entry: "${question.substring(0, 40)}..." (was: "${oldAnswer}")`);
    return true;
  }
  return false;
}

/**
 * Get all cached answers for dashboard
 */
export function getAllCachedAnswers() {
  return Object.entries(answerCache.answers).map(([key, entry]) => ({
    normalizedQuestion: key,
    ...entry,
  }));
}

/**
 * Get cache stats
 */
export function getCacheStats() {
  return {
    ...answerCache.stats,
    totalCached: Object.keys(answerCache.answers).length,
    hitRate: answerCache.stats.cacheHits / 
      (answerCache.stats.cacheHits + answerCache.stats.cacheMisses || 1) * 100,
  };
}

/**
 * Get question history
 */
export function getQuestionHistory(limit = 100) {
  return questionHistory.slice(0, limit);
}

/**
 * Get unique questions from history grouped by question
 */
export function getUniqueQuestions() {
  const grouped = {};
  
  for (const entry of questionHistory) {
    const normalized = normalizeQuestion(entry.question);
    if (!grouped[normalized]) {
      grouped[normalized] = {
        question: entry.question,
        answers: [],
        companies: new Set(),
        count: 0,
      };
    }
    grouped[normalized].answers.push(entry.answer);
    grouped[normalized].companies.add(entry.company);
    grouped[normalized].count++;
  }
  
  return Object.values(grouped).map(g => ({
    question: g.question,
    lastAnswer: g.answers[0],
    allAnswers: [...new Set(g.answers)],
    companies: [...g.companies],
    timesAsked: g.count,
  })).sort((a, b) => b.timesAsked - a.timesAsked);
}

/**
 * Bulk import answers (for initial setup)
 */
export function importAnswers(answersArray) {
  for (const { question, answer } of answersArray) {
    updateAnswer(question, answer);
  }
  console.log(`📥 Imported ${answersArray.length} answers`);
}

/**
 * Export all answers (for backup)
 */
export function exportAnswers() {
  return getAllCachedAnswers();
}

// Initialize on module load
initAnswerCache();
