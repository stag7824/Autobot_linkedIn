/**
 * LinkedIn Easy Apply Bot - Notification Service
 * 
 * Push notifications via ntfy.sh
 * 
 * @license MIT
 */

import config from '../config/index.js';

/**
 * Send notification to ntfy.sh
 */
async function sendNotification(title, message, priority = 'default', tags = []) {
  if (!config.notifications.enabled || !config.notifications.ntfyUrl) {
    return;
  }

  try {
    await fetch(config.notifications.ntfyUrl, {
      method: 'POST',
      headers: {
        'Title': title,
        'Priority': priority,
        'Tags': tags.join(','),
      },
      body: message,
    });
  } catch (error) {
    // Silently fail - don't interrupt the bot for notification errors
  }
}

/**
 * Notify successful application
 */
export async function notifyApplicationSuccess(title, company) {
  await sendNotification(
    '✅ Application Submitted',
    `Applied to ${title} at ${company}`,
    'default',
    ['white_check_mark', 'briefcase']
  );
}

/**
 * Notify failed application
 */
export async function notifyApplicationError(title, company, error) {
  await sendNotification(
    '❌ Application Failed',
    `Failed to apply to ${title} at ${company}\nError: ${error}`,
    'high',
    ['x', 'warning']
  );
}

/**
 * Notify bot status
 */
export async function notifyBotStatus(status, details = '') {
  await sendNotification(
    `🤖 Bot ${status}`,
    details,
    'default',
    ['robot']
  );
}

/**
 * Notify daily summary
 */
export async function notifyDailySummary(stats) {
  const { todayApplied, todaySkipped, todayFailed, totalApplied } = stats;
  await sendNotification(
    '📊 Daily Summary',
    `Today: ${todayApplied} applied, ${todaySkipped} skipped, ${todayFailed} failed\nTotal: ${totalApplied} applications`,
    'default',
    ['chart_with_upwards_trend']
  );
}

/**
 * Notify critical error
 */
export async function notifyCriticalError(error) {
  await sendNotification(
    '🚨 Critical Error',
    `Bot encountered a critical error:\n${error}`,
    'urgent',
    ['rotating_light', 'skull']
  );
}

/**
 * Notify manual intervention required
 */
export async function notifyManualIntervention(reason) {
  await sendNotification(
    '⚠️ Manual Intervention Required',
    reason,
    'high',
    ['warning', 'hand']
  );
}

export default {
  notifyApplicationSuccess,
  notifyApplicationError,
  notifyBotStatus,
  notifyDailySummary,
  notifyCriticalError,
  notifyManualIntervention,
};
