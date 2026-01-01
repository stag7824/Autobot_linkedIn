/**
 * LinkedIn Easy Apply Bot - Entry Point
 * 
 * Main entry point with error recovery and graceful shutdown.
 * 
 * @license MIT
 */

import { LinkedInBot } from './bot/LinkedInBot.js';
import config, { validateConfig } from './config/index.js';
import stateManager from './services/stateManager.js';
import { 
  notifyBotStatus, 
  notifyDailySummary, 
  notifyCriticalError 
} from './services/notificationService.js';
import { 
  startWebServer, 
  setBotInstance, 
  setBotRunning,
  shouldBotRun,
  setStartBotCallback,
} from './web/dashboard.js';

const MAX_RETRIES = 5;
const RETRY_DELAYS = [30000, 60000, 120000, 300000, 600000]; // 30s, 1m, 2m, 5m, 10m

let bot = null;
let isShuttingDown = false;
let webServer = null; // Keep server reference to prevent process from exiting

/**
 * Print banner
 */
function printBanner() {
  const mode = config.env.isProduction ? 'PRODUCTION' : 'DEVELOPMENT';
  const modeEmoji = config.env.isProduction ? '🚀' : '🔧';
  console.log(`
═══════════════════════════════════════════════════
    LinkedIn Easy Apply Bot v2.0.0
═══════════════════════════════════════════════════
${modeEmoji} Mode: ${mode}
Started at: ${new Date().toISOString()}
`);
}

/**
 * Print configuration summary
 */
function printConfig() {
  console.log('📊 Configuration:');
  console.log(`   Daily limit: ${config.bot.dailyLimit}`);
  console.log(`   Search terms: ${config.search.terms.join(', ')}`);
  console.log(`   Location: ${config.search.location || 'Worldwide'}`);
  console.log(`   Easy Apply only: ${config.filters.easyApplyOnly}`);
  console.log(`   Complete requirements: ${config.jobFilter.completeRequirements}`);
  console.log(`   Headless mode: ${config.bot.headless}`);
  console.log(`   AI enabled: ${config.ai.enabled}`);
  console.log(`   Notifications: ${config.notifications.enabled}`);
  console.log(`   Skip resume upload: ${config.bot.skipResumeUpload}`);
  if (config.env.isProduction) {
    console.log(`   ⏱️  Application delay: 2-3 min (Gemini rate limit protection)`);
  } else {
    console.log(`   ⏱️  Application delay: 5-15 sec (development mode)`);
  }
  console.log('');
}

/**
 * Graceful shutdown handler
 */
async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n⚠️ Received ${signal} - shutting down gracefully...`);

  try {
    if (bot) {
      const stats = bot.getStats();
      console.log('\n📊 Session Statistics:');
      console.log(`   Applied: ${stats.applied}`);
      console.log(`   Skipped: ${stats.skipped}`);
      console.log(`   Failed: ${stats.failed}`);
      console.log(`   Runtime: ${stats.runtime}`);

      await bot.close();
      await notifyDailySummary(stats);
    }

    // Export to CSV
    stateManager.exportToCSV();
  } catch (error) {
    console.error('Error during shutdown:', error.message);
  }

  process.exit(0);
}

/**
 * Main function with retry logic
 */
async function main() {
  printBanner();
  
  // Validate configuration
  if (!validateConfig()) {
    console.error('\n❌ Invalid configuration. Please check your .env file.');
    console.log('   See .env.example for reference.');
    process.exit(1);
  }

  printConfig();

  // Start web dashboard
  if (config.web.enabled) {
    webServer = await startWebServer();
    
    // Set up the bot start callback
    setStartBotCallback(() => {
      runBot();
    });
    
    console.log('\n✅ Dashboard ready! Click "Start Bot" to begin applying.');
    console.log(`   Open http://localhost:${config.web.port} in your browser.\n`);
    
    // Keep the process alive - server is stored in webServer variable
    return;
  }
  
  // If no web dashboard, run bot directly (CLI mode)
  await runBot();
}

/**
 * Run the bot with retry logic
 */
async function runBot() {
  // Check daily limit
  if (stateManager.isLimitReached()) {
    console.log('📊 Daily limit already reached. Try again tomorrow!');
    console.log(`   Applied today: ${stateManager.getTodayCount()}`);
    return;
  }

  console.log(`📈 Remaining applications today: ${stateManager.getRemainingToday()}`);

  let attempt = 0;
  let success = false;

  while (attempt < MAX_RETRIES && !success && !isShuttingDown) {
    try {
      attempt++;
      console.log(`\n🚀 Starting bot (attempt ${attempt}/${MAX_RETRIES})...`);

      bot = new LinkedInBot();
      setBotInstance(bot);
      setBotRunning(true);
      
      const stats = await bot.run();

      setBotRunning(false);
      success = true;
      console.log('\n✅ Bot completed successfully!');
      console.log(`   Applied: ${stats.applied}`);
      console.log(`   Skipped: ${stats.skipped}`);
      console.log(`   Failed: ${stats.failed}`);

      await notifyDailySummary(stats);
    } catch (error) {
      setBotRunning(false);
      console.error(`\n❌ Error (attempt ${attempt}/${MAX_RETRIES}): ${error.message}`);
      stateManager.logError(error, { attempt });

      if (bot) {
        await bot.close().catch(() => {});
        bot = null;
      }

      if (attempt < MAX_RETRIES && !isShuttingDown) {
        const delay = RETRY_DELAYS[attempt - 1] || 60000;
        console.log(`⏳ Waiting ${delay / 1000}s before retry...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        await notifyCriticalError(error.message);
      }
    }
  }

  if (!success && !isShuttingDown) {
    console.error('\n❌ Bot failed after all retries');
    return;
  }

  // Export final results
  stateManager.exportToCSV();
  
  // If run_non_stop is enabled, restart
  if (config.bot.runNonStop && success && !isShuttingDown) {
    console.log('\n🔄 Run non-stop mode enabled. Restarting in 5 minutes...');
    await new Promise(resolve => setTimeout(resolve, 5 * 60 * 1000));
    return runBot(); // Recursive call
  }
}

// Signal handlers
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', async (error) => {
  console.error('Uncaught exception:', error);
  await shutdown('uncaughtException');
});
process.on('unhandledRejection', async (reason) => {
  console.error('Unhandled rejection:', reason);
  await shutdown('unhandledRejection');
});

// Run
main().catch(console.error);
