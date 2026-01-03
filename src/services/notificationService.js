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
  console.log(`📢 Notification: ${title} - ${message}`);
  
  if (!config.notifications.enabled || !config.notifications.ntfyUrl) {
    console.log(`   ⚠️ Notifications disabled (enabled: ${config.notifications.enabled}, url: ${config.notifications.ntfyUrl ? 'set' : 'not set'})`);
    return;
  }

  try {
    // Remove emojis from title (headers must be ASCII)
    const asciiTitle = title.replace(/[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu, '').trim();
    
    const response = await fetch(config.notifications.ntfyUrl, {
      method: 'POST',
      headers: {
        'Title': asciiTitle || 'LinkedIn Bot',
        'Priority': priority,
        'Tags': tags.join(','),
      },
      body: message,
    });
    
    if (response.ok) {
      console.log(`   ✅ Notification sent to ntfy`);
    } else {
      console.log(`   ❌ Notification failed: ${response.status}`);
    }
  } catch (error) {
    console.log(`   ❌ Notification error: ${error.message}`);
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
