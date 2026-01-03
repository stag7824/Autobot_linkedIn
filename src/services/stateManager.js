/**
 * LinkedIn Easy Apply Bot - State Manager
 * 
 * Handles persistence for applied jobs, bot state, and logs.
 * 
 * @license MIT
 */

import fs from 'fs';
import path from 'path';
import config from '../config/index.js';
import { saveJobApplication } from './pocketbaseService.js';

const DATA_DIR = config.bot.savePath;
const APPLIED_JOBS_FILE = path.join(DATA_DIR, 'applied_jobs.json');
const BOT_STATE_FILE = path.join(DATA_DIR, 'bot_state.json');
const ERROR_LOG_FILE = path.join(DATA_DIR, 'error_log.json');
const DAILY_STATS_FILE = path.join(DATA_DIR, 'daily_stats.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * Load JSON file with fallback
 */
function loadJSON(filePath, defaultValue = {}) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch (error) {
    console.error(`Error loading ${filePath}:`, error.message);
  }
  return defaultValue;
}

/**
 * Save JSON file atomically
 */
function saveJSON(filePath, data) {
  try {
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    console.error(`Error saving ${filePath}:`, error.message);
  }
}

/**
 * State Manager Class
 */
class StateManager {
  constructor() {
    this.appliedJobs = loadJSON(APPLIED_JOBS_FILE, { jobs: {}, count: 0 });
    // Ensure jobs object exists
    if (!this.appliedJobs.jobs) {
      this.appliedJobs.jobs = {};
    }
    if (typeof this.appliedJobs.count !== 'number') {
      this.appliedJobs.count = Object.keys(this.appliedJobs.jobs).length;
    }
    
    this.botState = loadJSON(BOT_STATE_FILE, { 
      lastRun: null, 
      currentTopic: null, 
      currentPage: 0 
    });
    this.dailyStats = this.loadDailyStats();
    this.errorLog = loadJSON(ERROR_LOG_FILE, { errors: [] });
    // Ensure errors array exists
    if (!Array.isArray(this.errorLog.errors)) {
      this.errorLog.errors = [];
    }
  }

  /**
   * Load or reset daily stats
   */
  loadDailyStats() {
    const stats = loadJSON(DAILY_STATS_FILE, { 
      date: null, 
      applied: 0, 
      skipped: 0, 
      failed: 0 
    });
    
    const today = new Date().toISOString().split('T')[0];
    if (stats.date !== today) {
      console.log(`📅 New day detected (${today}). Resetting daily stats from ${stats.date || 'none'}.`);
      const newStats = { date: today, applied: 0, skipped: 0, failed: 0 };
      // Save immediately so file reflects the reset
      saveJSON(DAILY_STATS_FILE, newStats);
      return newStats;
    }
    return stats;
  }

  /**
   * Check and reset daily stats if date has changed
   * Call this before any operation that depends on daily stats
   */
  checkAndResetDailyStats() {
    const today = new Date().toISOString().split('T')[0];
    if (this.dailyStats.date !== today) {
      console.log(`📅 New day detected (${today}). Resetting daily stats.`);
      this.dailyStats = { date: today, applied: 0, skipped: 0, failed: 0 };
      this.save();
    }
  }

  /**
   * Check if job was already applied
   */
  hasApplied(jobId) {
    if (!this.appliedJobs?.jobs) return false;
    return !!this.appliedJobs.jobs[jobId];
  }

  /**
   * Add applied job to records
   */
  addAppliedJob(jobId, details) {
    this.appliedJobs.jobs[jobId] = {
      ...details,
      appliedAt: new Date().toISOString(),
    };
    this.appliedJobs.count++;
    this.dailyStats.applied++;
    
    this.save();
    
    // Also save to Pocketbase (async, non-blocking)
    saveJobApplication({
      jobId,
      title: details.title,
      company: details.company,
      url: details.url,
      status: 'applied',
      applicationData: details.applicationData || {},
    }).catch(err => {
      console.log('⚠️ Failed to save to Pocketbase:', err.message);
    });
  }

  /**
   * Get today's application count
   */
  getTodayCount() {
    this.checkAndResetDailyStats();
    return this.dailyStats.applied;
  }

  /**
   * Check if daily limit reached
   */
  isLimitReached() {
    this.checkAndResetDailyStats();
    return this.dailyStats.applied >= config.bot.dailyLimit;
  }

  /**
   * Get remaining applications for today
   */
  getRemainingToday() {
    this.checkAndResetDailyStats();
    return Math.max(0, config.bot.dailyLimit - this.dailyStats.applied);
  }

  /**
   * Increment skipped count
   */
  incrementSkipped() {
    this.dailyStats.skipped++;
    this.save();
  }

  /**
   * Increment failed count
   */
  incrementFailed() {
    this.dailyStats.failed++;
    this.save();
  }

  /**
   * Update bot state
   */
  updateState(state) {
    this.botState = {
      ...this.botState,
      ...state,
      lastRun: new Date().toISOString(),
    };
    this.save();
  }

  /**
   * Get bot state
   */
  getState() {
    return this.botState;
  }

  /**
   * Log error
   */
  logError(error, context = {}) {
    this.errorLog.errors.push({
      timestamp: new Date().toISOString(),
      message: error.message,
      stack: error.stack,
      context,
    });
    
    // Keep only last 100 errors
    if (this.errorLog.errors.length > 100) {
      this.errorLog.errors = this.errorLog.errors.slice(-100);
    }
    
    saveJSON(ERROR_LOG_FILE, this.errorLog);
  }

  /**
   * Save all state files
   */
  save() {
    saveJSON(APPLIED_JOBS_FILE, this.appliedJobs);
    saveJSON(BOT_STATE_FILE, this.botState);
    saveJSON(DAILY_STATS_FILE, this.dailyStats);
  }

  /**
   * Get statistics summary
   */
  getStats() {
    this.checkAndResetDailyStats();
    return {
      totalApplied: this.appliedJobs.count,
      todayApplied: this.dailyStats.applied,
      todaySkipped: this.dailyStats.skipped,
      todayFailed: this.dailyStats.failed,
      remaining: this.getRemainingToday(),
      lastRun: this.botState.lastRun,
    };
  }

  /**
   * Get all applied jobs
   */
  getAppliedJobs() {
    return this.appliedJobs.jobs;
  }

  /**
   * Get error logs
   */
  getLogs() {
    return this.errorLog.errors;
  }

  /**
   * Export applied jobs to CSV
   */
  exportToCSV(filePath = path.join(DATA_DIR, 'applied_jobs.csv')) {
    const jobs = Object.entries(this.appliedJobs.jobs);
    if (jobs.length === 0) return;

    const headers = ['Job ID', 'Title', 'Company', 'Applied At', 'URL'];
    const rows = jobs.map(([id, job]) => [
      id,
      `"${(job.title || '').replace(/"/g, '""')}"`,
      `"${(job.company || '').replace(/"/g, '""')}"`,
      job.appliedAt || '',
      job.url || '',
    ]);

    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    fs.writeFileSync(filePath, csv);
    console.log(`📊 Exported ${jobs.length} jobs to ${filePath}`);
  }
}

// Export singleton instance
const stateManager = new StateManager();
export default stateManager;
