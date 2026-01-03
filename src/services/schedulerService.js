/**
 * Scheduler Service - Auto-apply scheduling
 * 
 * Handles automatic bot triggering between configured hours.
 * Randomly triggers once within the active window each day.
 * 
 * @license MIT
 */

import { getSettings, updateSettings } from './settingsManager.js';
import stateManager from './stateManager.js';

let schedulerTimeout = null;
let scheduledTime = null;
let startBotCallback = null;
let lastScheduledDate = null;

/**
 * Default scheduler settings
 */
export const defaultSchedulerSettings = {
  autoApplyEnabled: false,
  autoApplyStartHour: 6,   // 6 AM
  autoApplyEndHour: 21,    // 9 PM
};

/**
 * Set the callback function to start the bot
 */
export function setSchedulerBotCallback(callback) {
  startBotCallback = callback;
}

/**
 * Get a random time between start and end hours for today
 */
function getRandomTimeToday(startHour, endHour) {
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  
  // Random hour between start and end
  const randomHour = startHour + Math.floor(Math.random() * (endHour - startHour));
  // Random minute
  const randomMinute = Math.floor(Math.random() * 60);
  // Random second
  const randomSecond = Math.floor(Math.random() * 60);
  
  const scheduledDate = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    randomHour,
    randomMinute,
    randomSecond
  );
  
  return scheduledDate;
}

/**
 * Get next scheduled run time
 * If within window, schedule for today; otherwise schedule for tomorrow
 */
function getNextScheduledTime(startHour, endHour) {
  const now = new Date();
  const currentHour = now.getHours();
  const today = now.toISOString().split('T')[0];
  
  // Check if we already scheduled for today
  if (lastScheduledDate === today && scheduledTime) {
    // If already past scheduled time today, schedule for tomorrow
    if (now >= scheduledTime) {
      return getNextScheduledTimeTomorrow(startHour, endHour);
    }
    return scheduledTime;
  }
  
  // If before the window, schedule for later today
  if (currentHour < startHour) {
    const scheduled = getRandomTimeToday(startHour, endHour);
    lastScheduledDate = today;
    return scheduled;
  }
  
  // If within the window, schedule for a random time in remaining window
  if (currentHour >= startHour && currentHour < endHour) {
    // Schedule between now and end of window
    const remainingStart = currentHour + 1; // Start from next hour
    if (remainingStart < endHour) {
      const scheduled = getRandomTimeToday(remainingStart, endHour);
      lastScheduledDate = today;
      return scheduled;
    }
    // If less than an hour left, schedule in next few minutes
    const scheduled = new Date(now.getTime() + (Math.random() * 30 + 5) * 60 * 1000);
    lastScheduledDate = today;
    return scheduled;
  }
  
  // If after the window, schedule for tomorrow
  return getNextScheduledTimeTomorrow(startHour, endHour);
}

/**
 * Get scheduled time for tomorrow
 */
function getNextScheduledTimeTomorrow(startHour, endHour) {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  
  const tomorrowDateStr = tomorrow.toISOString().split('T')[0];
  
  // Random hour between start and end
  const randomHour = startHour + Math.floor(Math.random() * (endHour - startHour));
  const randomMinute = Math.floor(Math.random() * 60);
  const randomSecond = Math.floor(Math.random() * 60);
  
  const scheduled = new Date(
    tomorrow.getFullYear(),
    tomorrow.getMonth(),
    tomorrow.getDate(),
    randomHour,
    randomMinute,
    randomSecond
  );
  
  lastScheduledDate = tomorrowDateStr;
  return scheduled;
}

/**
 * Schedule the next bot run
 */
function scheduleNextRun() {
  const settings = getSettings();
  
  if (!settings.autoApplyEnabled) {
    console.log('⏰ Auto-apply is disabled');
    return null;
  }
  
  const startHour = settings.autoApplyStartHour ?? defaultSchedulerSettings.autoApplyStartHour;
  const endHour = settings.autoApplyEndHour ?? defaultSchedulerSettings.autoApplyEndHour;
  
  // Clear any existing timeout
  if (schedulerTimeout) {
    clearTimeout(schedulerTimeout);
    schedulerTimeout = null;
  }
  
  scheduledTime = getNextScheduledTime(startHour, endHour);
  const now = new Date();
  const delay = scheduledTime.getTime() - now.getTime();
  
  if (delay <= 0) {
    console.log('⏰ Scheduled time is in the past, rescheduling...');
    lastScheduledDate = null; // Reset to allow fresh scheduling
    return scheduleNextRun();
  }
  
  console.log(`⏰ Auto-apply scheduled for: ${scheduledTime.toLocaleString()}`);
  console.log(`   (in ${Math.round(delay / 1000 / 60)} minutes)`);
  
  schedulerTimeout = setTimeout(async () => {
    console.log('⏰ Auto-apply triggered!');
    
    // Check if daily limit is already reached
    if (stateManager.isLimitReached()) {
      console.log('📊 Daily limit already reached. Skipping auto-apply.');
      // Schedule for tomorrow
      lastScheduledDate = null;
      scheduleNextRun();
      return;
    }
    
    if (startBotCallback) {
      try {
        await startBotCallback();
      } catch (error) {
        console.error('❌ Auto-apply error:', error.message);
      }
    } else {
      console.error('❌ No bot start callback configured for scheduler');
    }
    
    // Schedule the next run (for tomorrow)
    lastScheduledDate = null;
    scheduleNextRun();
  }, delay);
  
  return scheduledTime;
}

/**
 * Start the scheduler
 */
export function startScheduler() {
  const settings = getSettings();
  
  if (!settings.autoApplyEnabled) {
    console.log('⏰ Auto-apply is disabled. Enable it in settings to start scheduling.');
    return null;
  }
  
  return scheduleNextRun();
}

/**
 * Stop the scheduler
 */
export function stopScheduler() {
  if (schedulerTimeout) {
    clearTimeout(schedulerTimeout);
    schedulerTimeout = null;
    scheduledTime = null;
    lastScheduledDate = null;
    console.log('⏰ Scheduler stopped');
  }
}

/**
 * Get scheduler status
 */
export function getSchedulerStatus() {
  const settings = getSettings();
  
  return {
    enabled: settings.autoApplyEnabled ?? false,
    startHour: settings.autoApplyStartHour ?? defaultSchedulerSettings.autoApplyStartHour,
    endHour: settings.autoApplyEndHour ?? defaultSchedulerSettings.autoApplyEndHour,
    nextRunTime: scheduledTime ? scheduledTime.toISOString() : null,
    nextRunFormatted: scheduledTime ? scheduledTime.toLocaleString() : null,
    isScheduled: !!schedulerTimeout,
  };
}

/**
 * Toggle auto-apply on/off
 */
export function toggleAutoApply(enabled) {
  const settings = getSettings();
  settings.autoApplyEnabled = enabled;
  updateSettings(settings);
  
  if (enabled) {
    return startScheduler();
  } else {
    stopScheduler();
    return null;
  }
}

/**
 * Update scheduler settings
 */
export function updateSchedulerSettings(newSettings) {
  const settings = getSettings();
  
  if (newSettings.autoApplyStartHour !== undefined) {
    settings.autoApplyStartHour = Math.max(0, Math.min(23, newSettings.autoApplyStartHour));
  }
  if (newSettings.autoApplyEndHour !== undefined) {
    settings.autoApplyEndHour = Math.max(1, Math.min(24, newSettings.autoApplyEndHour));
  }
  if (newSettings.autoApplyEnabled !== undefined) {
    settings.autoApplyEnabled = newSettings.autoApplyEnabled;
  }
  
  updateSettings(settings);
  
  // Restart scheduler with new settings if enabled
  if (settings.autoApplyEnabled) {
    lastScheduledDate = null;
    return scheduleNextRun();
  } else {
    stopScheduler();
    return null;
  }
}

export default {
  startScheduler,
  stopScheduler,
  getSchedulerStatus,
  toggleAutoApply,
  updateSchedulerSettings,
  setSchedulerBotCallback,
  defaultSchedulerSettings,
};
