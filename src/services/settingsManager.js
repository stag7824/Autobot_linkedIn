/**
 * Settings Manager - Persists bot configuration to JSON
 * Allows runtime updates from web dashboard
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import config from '../config/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SETTINGS_FILE = join(__dirname, '..', '..', 'data', 'settings.json');

/**
 * Get settings pre-filled from config/env vars
 */
function getEnvBasedDefaults() {
  return {
    // Bot settings
    dailyLimit: config.bot?.dailyLimit || 20,
    headless: config.bot?.headless || false,
    
    // Search
    searchTerms: config.search?.terms || ['Software Engineer'],
    searchLocation: config.search?.location || '',
    switchAfter: config.search?.switchAfter || 30,
    
    // Filters
    sortBy: config.filters?.sortBy || 'Most recent',
    datePosted: config.filters?.datePosted || 'Any time',
    easyApplyOnly: config.filters?.easyApplyOnly !== false,
    experienceLevel: config.filters?.experienceLevel || ['Entry level', 'Associate', 'Mid-Senior level'],
    jobType: config.filters?.jobType || ['Full-time'],
    onSite: config.filters?.onSite || ['Remote', 'Hybrid', 'On-site'],
    
    // Job filtering
    badWords: config.jobFilter?.badWords || [],
    badJobTitles: config.jobFilter?.badJobTitles || [],
    companyBadWords: config.jobFilter?.companyBadWords || [],
    hasSecurityClearance: config.jobFilter?.hasSecurityClearance || false,
    hasMasters: config.jobFilter?.hasMasters || false,
    currentExperience: config.jobFilter?.currentExperience || 0,
    completeRequirements: config.jobFilter?.completeRequirements || false,
    
    // Personal info (from env)
    firstName: config.personal?.firstName || '',
    middleName: config.personal?.middleName || '',
    lastName: config.personal?.lastName || '',
    phoneNumber: config.personal?.phoneNumber || '',
    currentCity: config.personal?.currentCity || '',
    state: config.personal?.state || '',
    zipcode: config.personal?.zipcode || '',
    country: config.personal?.country || '',
    ethnicity: config.personal?.ethnicity || '',
    gender: config.personal?.gender || '',
    disabilityStatus: config.personal?.disabilityStatus || 'Decline',
    veteranStatus: config.personal?.veteranStatus || 'Decline',
    
    // Application
    yearsOfExperience: config.application?.yearsOfExperience || '0',
    requireVisa: config.application?.requireVisa || 'No',
    website: config.application?.website || '',
    linkedInUrl: config.application?.linkedInUrl || '',
    citizenshipStatus: config.application?.citizenshipStatus || '',
    desiredSalary: config.application?.desiredSalary || 0,
    maxSalary: config.application?.maxSalary || 0,
    salaryCurrency: config.application?.salaryCurrency || 'USD',
    currentSalary: config.application?.currentSalary || 0,
    noticePeriod: config.application?.noticePeriod || 0,
    recentEmployer: config.application?.recentEmployer || '',
    
    // Resume
    skipResumeUpload: config.bot?.skipResumeUpload !== false,
    linkedInHeadline: config.resume?.headline || '',
    linkedInSummary: config.resume?.summary || '',
    userInfo: config.resume?.userInfo || '',
    
    // Advanced
    followCompanies: config.bot?.followCompanies || false,
    pauseBeforeSubmit: config.bot?.pauseBeforeSubmit || false,
    stealthMode: config.bot?.stealthMode !== false,
  };
}

// Default settings (will be merged with env vars)
const defaultSettings = {
  // Bot settings
  dailyLimit: 20,
  headless: false,
  
  // Search
  searchTerms: ['Java Developer'],
  searchLocation: 'Hungary',
  switchAfter: 30,
  
  // Filters
  sortBy: 'Most recent',
  datePosted: 'Any time',
  easyApplyOnly: true,
  experienceLevel: ['Entry level', 'Associate', 'Mid-Senior level'],
  jobType: ['Full-time'],
  onSite: ['Remote', 'Hybrid', 'On-site'],
  
  // Job filtering
  badWords: ['US Citizen', 'USA Citizen', 'Security Clearance', 'No Sponsorship'],
  badJobTitles: ['DevOps', 'Computer Vision', 'AI Engineer', 'Machine Learning', 'Data Scientist'],
  companyBadWords: [],
  hasSecurityClearance: false,
  hasMasters: true,
  currentExperience: 3,
  completeRequirements: false,
  
  // Personal info
  firstName: '',
  middleName: '',
  lastName: '',
  phoneNumber: '',
  currentCity: '',
  state: '',
  zipcode: '',
  country: 'Hungary',
  ethnicity: '',
  gender: '',
  disabilityStatus: 'Decline',
  veteranStatus: 'Decline',
  
  // Application
  yearsOfExperience: '3',
  requireVisa: 'Yes',
  website: '',
  linkedInUrl: '',
  citizenshipStatus: '',
  desiredSalary: 950000,
  maxSalary: 1200000,
  salaryCurrency: 'HUF',
  currentSalary: 0,
  noticePeriod: 0,
  recentEmployer: '',
  
  // Resume
  skipResumeUpload: true,
  linkedInHeadline: '',
  linkedInSummary: '',
  userInfo: '',
  
  // Advanced
  followCompanies: false,
  pauseBeforeSubmit: false,
  stealthMode: true,
};

let settings = { ...defaultSettings };

/**
 * Load settings from file and merge with env vars
 * Priority: settings.json > env vars > hardcoded defaults
 */
export function loadSettings() {
  // Start with env-based defaults (reads from .env file)
  const envDefaults = getEnvBasedDefaults();
  
  try {
    if (existsSync(SETTINGS_FILE)) {
      const fileContent = readFileSync(SETTINGS_FILE, 'utf8');
      const savedSettings = JSON.parse(fileContent);
      // Merge: hardcoded defaults < env defaults < saved settings
      settings = { ...defaultSettings, ...envDefaults, ...savedSettings };
      console.log('📁 Loaded settings from settings.json');
    } else {
      // No settings file - use env defaults
      settings = { ...defaultSettings, ...envDefaults };
      console.log('📁 No settings.json found, using env/defaults');
    }
  } catch (error) {
    console.error('⚠️ Failed to load settings:', error.message);
    settings = { ...defaultSettings, ...envDefaults };
  }
  return settings;
}

/**
 * Save settings to file
 */
export function saveSettings() {
  try {
    writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
    console.log('💾 Settings saved to settings.json');
    return true;
  } catch (error) {
    console.error('❌ Failed to save settings:', error.message);
    return false;
  }
}

/**
 * Get all settings
 */
export function getSettings() {
  return { ...settings };
}

/**
 * Update settings (partial update)
 */
export function updateSettings(updates) {
  settings = { ...settings, ...updates };
  return saveSettings();
}

/**
 * Get a single setting
 */
export function getSetting(key) {
  return settings[key];
}

/**
 * Set a single setting
 */
export function setSetting(key, value) {
  settings[key] = value;
  return saveSettings();
}

/**
 * Reset to defaults
 */
export function resetSettings() {
  settings = { ...defaultSettings };
  return saveSettings();
}

/**
 * Apply settings to config object (call this after loading)
 */
export function applySettingsToConfig(config) {
  // Bot settings
  if (settings.dailyLimit) config.bot.dailyLimit = settings.dailyLimit;
  if (settings.headless !== undefined) config.bot.headless = settings.headless;
  
  // Search
  if (settings.searchTerms?.length) config.search.terms = settings.searchTerms;
  if (settings.searchLocation) config.search.location = settings.searchLocation;
  if (settings.switchAfter) config.search.switchAfter = settings.switchAfter;
  
  // Filters
  if (settings.sortBy) config.filters.sortBy = settings.sortBy;
  if (settings.datePosted) config.filters.datePosted = settings.datePosted;
  if (settings.easyApplyOnly !== undefined) config.filters.easyApplyOnly = settings.easyApplyOnly;
  if (settings.experienceLevel?.length) config.filters.experienceLevel = settings.experienceLevel;
  if (settings.jobType?.length) config.filters.jobType = settings.jobType;
  if (settings.onSite?.length) config.filters.onSite = settings.onSite;
  
  // Job filtering
  if (settings.badWords?.length) config.jobFilter.badWords = settings.badWords;
  if (settings.badJobTitles?.length) config.jobFilter.badJobTitles = settings.badJobTitles;
  if (settings.companyBadWords?.length) config.jobFilter.companyBadWords = settings.companyBadWords;
  if (settings.hasSecurityClearance !== undefined) config.jobFilter.hasSecurityClearance = settings.hasSecurityClearance;
  if (settings.hasMasters !== undefined) config.jobFilter.hasMasters = settings.hasMasters;
  if (settings.currentExperience !== undefined) config.jobFilter.currentExperience = settings.currentExperience;
  if (settings.completeRequirements !== undefined) config.jobFilter.completeRequirements = settings.completeRequirements;
  
  // Personal
  if (settings.firstName) config.personal.firstName = settings.firstName;
  if (settings.middleName) config.personal.middleName = settings.middleName;
  if (settings.lastName) config.personal.lastName = settings.lastName;
  if (settings.phoneNumber) config.personal.phoneNumber = settings.phoneNumber;
  if (settings.currentCity) config.personal.currentCity = settings.currentCity;
  if (settings.state) config.personal.state = settings.state;
  if (settings.zipcode) config.personal.zipcode = settings.zipcode;
  if (settings.country) config.personal.country = settings.country;
  if (settings.ethnicity) config.personal.ethnicity = settings.ethnicity;
  if (settings.gender) config.personal.gender = settings.gender;
  if (settings.disabilityStatus) config.personal.disabilityStatus = settings.disabilityStatus;
  if (settings.veteranStatus) config.personal.veteranStatus = settings.veteranStatus;
  
  // Application
  if (settings.yearsOfExperience) config.application.yearsOfExperience = settings.yearsOfExperience;
  if (settings.requireVisa) config.application.requireVisa = settings.requireVisa;
  if (settings.website) config.application.website = settings.website;
  if (settings.linkedInUrl) config.application.linkedInUrl = settings.linkedInUrl;
  if (settings.citizenshipStatus) config.application.citizenshipStatus = settings.citizenshipStatus;
  if (settings.desiredSalary) config.application.desiredSalary = settings.desiredSalary;
  if (settings.maxSalary) config.application.maxSalary = settings.maxSalary;
  if (settings.salaryCurrency) config.application.salaryCurrency = settings.salaryCurrency;
  if (settings.currentSalary !== undefined) config.application.currentSalary = settings.currentSalary;
  if (settings.noticePeriod !== undefined) config.application.noticePeriod = settings.noticePeriod;
  if (settings.recentEmployer) config.application.recentEmployer = settings.recentEmployer;
  
  // Resume
  if (settings.skipResumeUpload !== undefined) config.bot.skipResumeUpload = settings.skipResumeUpload;
  if (settings.linkedInHeadline) config.resume.headline = settings.linkedInHeadline;
  if (settings.linkedInSummary) config.resume.summary = settings.linkedInSummary;
  if (settings.userInfo) config.resume.userInfo = settings.userInfo;
  
  // Advanced
  if (settings.followCompanies !== undefined) config.bot.followCompanies = settings.followCompanies;
  if (settings.stealthMode !== undefined) config.bot.stealthMode = settings.stealthMode;
  
  return config;
}

export default {
  loadSettings,
  saveSettings,
  getSettings,
  updateSettings,
  getSetting,
  setSetting,
  resetSettings,
  applySettingsToConfig,
};
