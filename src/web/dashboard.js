/**
 * LinkedIn Easy Apply Bot - Web Dashboard
 * 
 * Simple web interface for managing the bot from VPS.
 * 
 * @license MIT
 */

import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import config from '../config/index.js';
import stateManager from '../services/stateManager.js';
import { getAIStatus } from '../services/aiService.js';
import { 
  getSettings, 
  updateSettings, 
  loadSettings,
  applySettingsToConfig 
} from '../services/settingsManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(express.json());

// Bot state
let botInstance = null;
let botRunning = false;
let botStartTime = null;

/**
 * Set bot instance reference
 */
export function setBotInstance(bot) {
  botInstance = bot;
}

/**
 * Update bot running state
 */
export function setBotRunning(running) {
  botRunning = running;
  if (running) {
    botStartTime = Date.now();
  }
}

/**
 * Get runtime in human readable format
 */
function getRuntime() {
  if (!botStartTime) return '0s';
  const seconds = Math.floor((Date.now() - botStartTime) / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

// ═══════════════════════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════════════════════

// Get bot status
app.get('/api/status', (req, res) => {
  const stats = stateManager.getStats();
  const aiStatus = getAIStatus();
  
  res.json({
    running: botRunning,
    runtime: getRuntime(),
    startTime: botStartTime ? new Date(botStartTime).toISOString() : null,
    stats: {
      todayApplied: stats.todayApplied || 0,
      totalApplied: stats.totalApplied || 0,
      todaySkipped: stats.todaySkipped || 0,
      todayFailed: stats.todayFailed || 0,
    },
    limits: {
      daily: config.bot.dailyLimit,
      remaining: config.bot.dailyLimit - (stats.todayApplied || 0),
    },
    ai: aiStatus,
    config: {
      headless: config.bot.headless,
      environment: config.env.nodeEnv,
      searchTerms: config.search.terms,
      location: config.search.location,
    },
  });
});

// Get applied jobs list
app.get('/api/jobs', (req, res) => {
  const appliedJobs = stateManager.getAppliedJobs() || {};
  const limit = parseInt(req.query.limit) || 50;
  
  // Get most recent jobs
  const jobs = Object.entries(appliedJobs)
    .map(([jobId, data]) => ({ jobId, ...data }))
    .sort((a, b) => new Date(b.appliedAt) - new Date(a.appliedAt))
    .slice(0, limit);
  
  res.json({
    total: Object.keys(appliedJobs).length,
    jobs,
  });
});

// Get logs
app.get('/api/logs', (req, res) => {
  const logs = stateManager.getLogs() || [];
  const limit = parseInt(req.query.limit) || 100;
  
  res.json({
    total: logs.length,
    logs: logs.slice(-limit),
  });
});

// Update daily limit
app.post('/api/config/daily-limit', (req, res) => {
  const { limit } = req.body;
  if (typeof limit === 'number' && limit > 0 && limit <= 500) {
    config.bot.dailyLimit = limit;
    res.json({ success: true, dailyLimit: limit });
  } else {
    res.status(400).json({ error: 'Invalid limit. Must be between 1 and 500.' });
  }
});

// Stop bot (graceful)
app.post('/api/bot/stop', (req, res) => {
  if (botInstance && botRunning) {
    botRunning = false;
    // Bot will stop at next iteration check
    res.json({ success: true, message: 'Bot stopping...' });
  } else {
    res.json({ success: false, message: 'Bot is not running' });
  }
});

// Start bot callback - set by index.js
let startBotCallback = null;

export function setStartBotCallback(callback) {
  startBotCallback = callback;
}

// Start bot endpoint
app.post('/api/bot/start', async (req, res) => {
  if (botRunning) {
    return res.json({ success: false, message: 'Bot is already running' });
  }
  
  if (!startBotCallback) {
    return res.status(500).json({ success: false, message: 'Bot start callback not configured' });
  }
  
  try {
    // Start bot in background
    startBotCallback();
    res.json({ success: true, message: 'Bot starting...' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ═══════════════════════════════════════════════════════════════════════════
// SETTINGS API
// ═══════════════════════════════════════════════════════════════════════════

// Debug endpoint to check env and config values
app.get('/api/debug', (req, res) => {
  const searchTermsRaw = process.env.SEARCH_TERMS || '';
  // Show first 20 chars as character codes to see exact escaping
  const charCodes = searchTermsRaw.split('').slice(0, 30).map(c => c.charCodeAt(0));
  
  res.json({
    env: {
      BAD_WORDS: process.env.BAD_WORDS?.substring(0, 100),
      BAD_JOB_TITLES: process.env.BAD_JOB_TITLES?.substring(0, 100),
      SEARCH_TERMS: process.env.SEARCH_TERMS,
      SEARCH_TERMS_CHARS: charCodes,
    },
    config: {
      badWords: config.jobFilter?.badWords,
      badJobTitles: config.jobFilter?.badJobTitles,
      searchTerms: config.search?.terms,
    }
  });
});

// Get all settings
app.get('/api/settings', (req, res) => {
  const settings = getSettings();
  res.json(settings);
});

// Update settings
app.post('/api/settings', (req, res) => {
  try {
    const updates = req.body;
    updateSettings(updates);
    // Apply to running config
    applySettingsToConfig(config);
    res.json({ success: true, message: 'Settings saved' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Clear session lock files
app.post('/api/session/clear-lock', (req, res) => {
  try {
    const sessionDir = process.env.SAVE_PATH 
      ? join(process.env.SAVE_PATH, 'session')
      : './data/session';
    
    const lockFiles = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];
    let cleared = [];
    
    for (const file of lockFiles) {
      const filePath = join(sessionDir, file);
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          cleared.push(file);
        }
      } catch (e) {
        // Ignore individual file errors
      }
    }
    
    res.json({ 
      success: true, 
      message: cleared.length > 0 
        ? `Cleared: ${cleared.join(', ')}` 
        : 'No lock files found'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update single setting
app.patch('/api/settings/:key', (req, res) => {
  try {
    const { key } = req.params;
    const { value } = req.body;
    const settings = getSettings();
    settings[key] = value;
    updateSettings(settings);
    applySettingsToConfig(config);
    res.json({ success: true, key, value });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// WEB DASHBOARD HTML
// ═══════════════════════════════════════════════════════════════════════════

const dashboardHTML = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LinkedIn Easy Apply Bot - Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      min-height: 100vh;
      color: #e0e0e0;
      padding: 20px;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    header {
      text-align: center;
      padding: 30px 0;
      border-bottom: 1px solid #333;
      margin-bottom: 30px;
    }
    h1 { 
      font-size: 2.5rem; 
      background: linear-gradient(90deg, #0077b5, #00a0dc);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 10px;
    }
    .subtitle { color: #888; font-size: 1rem; }
    
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 20px;
      margin-bottom: 30px;
    }
    
    .card {
      background: rgba(255,255,255,0.05);
      border-radius: 16px;
      padding: 24px;
      border: 1px solid rgba(255,255,255,0.1);
      backdrop-filter: blur(10px);
    }
    .card h3 {
      color: #0077b5;
      font-size: 0.9rem;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 15px;
    }
    .card .value {
      font-size: 2.5rem;
      font-weight: bold;
      color: #fff;
    }
    .card .label {
      color: #888;
      font-size: 0.85rem;
      margin-top: 5px;
    }
    
    .status-card {
      grid-column: span 2;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .status-indicator {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .status-dot {
      width: 16px;
      height: 16px;
      border-radius: 50%;
      animation: pulse 2s infinite;
    }
    .status-dot.running { background: #00c853; }
    .status-dot.stopped { background: #ff5252; animation: none; }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    
    .btn {
      padding: 12px 24px;
      border: none;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.3s ease;
    }
    .btn-start {
      background: #00c853;
      color: white;
    }
    .btn-start:hover { background: #00e676; }
    .btn-start:disabled {
      background: #555;
      cursor: not-allowed;
    }
    .btn-stop {
      background: #ff5252;
      color: white;
    }
    .btn-stop:hover { background: #ff1744; }
    .btn-stop:disabled {
      background: #555;
      cursor: not-allowed;
    }
    
    .progress-bar {
      background: rgba(255,255,255,0.1);
      border-radius: 10px;
      height: 10px;
      margin-top: 15px;
      overflow: hidden;
    }
    .progress-fill {
      height: 100%;
      background: linear-gradient(90deg, #0077b5, #00a0dc);
      border-radius: 10px;
      transition: width 0.5s ease;
    }
    
    .ai-status {
      display: flex;
      gap: 20px;
      margin-top: 10px;
    }
    .ai-provider {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 16px;
      border-radius: 20px;
      background: rgba(255,255,255,0.05);
      font-size: 0.85rem;
    }
    .ai-provider.active { background: rgba(0, 200, 83, 0.2); border: 1px solid #00c853; }
    .ai-provider.inactive { opacity: 0.5; }
    
    .jobs-table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 15px;
    }
    .jobs-table th, .jobs-table td {
      padding: 12px;
      text-align: left;
      border-bottom: 1px solid rgba(255,255,255,0.1);
    }
    .jobs-table th {
      color: #0077b5;
      font-size: 0.85rem;
      text-transform: uppercase;
    }
    .jobs-table tr:hover {
      background: rgba(255,255,255,0.05);
    }
    
    .config-input {
      display: flex;
      gap: 10px;
      align-items: center;
    }
    .config-input input {
      background: rgba(255,255,255,0.1);
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 8px;
      padding: 10px 15px;
      color: white;
      font-size: 1rem;
      width: 100px;
    }
    .config-input button {
      padding: 10px 20px;
      background: #0077b5;
      color: white;
      border: none;
      border-radius: 8px;
      cursor: pointer;
    }
    .config-input button:hover { background: #005582; }
    
    footer {
      text-align: center;
      padding: 30px;
      color: #666;
      font-size: 0.85rem;
    }
    .nav-link {
      color: #0077b5;
      text-decoration: none;
      padding: 8px 16px;
      border: 1px solid #0077b5;
      border-radius: 8px;
      transition: all 0.3s;
    }
    .nav-link:hover {
      background: #0077b5;
      color: white;
    }
    
    @media (max-width: 768px) {
      .status-card { grid-column: span 1; flex-direction: column; gap: 20px; }
      h1 { font-size: 1.8rem; }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>🤖 LinkedIn Easy Apply Bot</h1>
      <p class="subtitle">Automated Job Application Dashboard</p>
      <div style="margin-top: 15px;">
        <a href="/settings" class="nav-link">⚙️ Settings</a>
      </div>
    </header>
    
    <div class="grid">
      <!-- Status Card -->
      <div class="card status-card">
        <div class="status-indicator">
          <div class="status-dot" id="statusDot"></div>
          <div>
            <div class="value" id="statusText">Loading...</div>
            <div class="label">Runtime: <span id="runtime">-</span></div>
          </div>
        </div>
        <button class="btn btn-start" id="startBtn" onclick="startBot()" style="display: none;">▶️ Start Bot</button>
        <button class="btn btn-stop" id="stopBtn" onclick="stopBot()" style="display: none;">⏹️ Stop Bot</button>
        <button class="btn" onclick="clearSessionLock()" style="background: #f59e0b; margin-top: 10px;">🔓 Clear Session Lock</button>
      </div>
      
      <!-- Today's Applications -->
      <div class="card">
        <h3>📝 Today's Applications</h3>
        <div class="value" id="todayApplied">-</div>
        <div class="label">of <span id="dailyLimit">-</span> daily limit</div>
        <div class="progress-bar">
          <div class="progress-fill" id="progressBar" style="width: 0%"></div>
        </div>
      </div>
      
      <!-- Total Applications -->
      <div class="card">
        <h3>📊 Total Applications</h3>
        <div class="value" id="totalApplied">-</div>
        <div class="label">All time</div>
      </div>
      
      <!-- Skipped -->
      <div class="card">
        <h3>⏭️ Skipped Today</h3>
        <div class="value" id="todaySkipped">-</div>
        <div class="label">Not matching criteria</div>
      </div>
      
      <!-- Failed -->
      <div class="card">
        <h3>❌ Failed Today</h3>
        <div class="value" id="todayFailed">-</div>
        <div class="label">Errors encountered</div>
      </div>
      
      <!-- AI Status -->
      <div class="card" style="grid-column: span 2;">
        <h3>🤖 AI Providers</h3>
        <div class="ai-status" id="aiStatus">
          <div class="ai-provider" id="geminiStatus">
            <span>🔷</span> Gemini
          </div>
          <div class="ai-provider" id="openrouterStatus">
            <span>🔶</span> OpenRouter (Backup)
          </div>
        </div>
      </div>
      
      <!-- Config -->
      <div class="card" style="grid-column: span 2;">
        <h3>⚙️ Configuration</h3>
        <div style="display: flex; justify-content: space-between; flex-wrap: wrap; gap: 20px; margin-top: 10px;">
          <div>
            <div class="label">Environment</div>
            <div style="font-size: 1.2rem; margin-top: 5px;" id="environment">-</div>
          </div>
          <div>
            <div class="label">Search Location</div>
            <div style="font-size: 1.2rem; margin-top: 5px;" id="location">-</div>
          </div>
          <div>
            <div class="label">Daily Limit</div>
            <div class="config-input" style="margin-top: 5px;">
              <input type="number" id="limitInput" min="1" max="500" />
              <button onclick="updateLimit()">Update</button>
            </div>
          </div>
        </div>
      </div>
      
      <!-- Recent Jobs -->
      <div class="card" style="grid-column: span 2;">
        <h3>📋 Recent Applications</h3>
        <table class="jobs-table">
          <thead>
            <tr>
              <th>Company</th>
              <th>Title</th>
              <th>Applied At</th>
            </tr>
          </thead>
          <tbody id="jobsTable">
            <tr><td colspan="3" style="text-align: center; color: #666;">Loading...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
    
    <footer>
      LinkedIn Easy Apply Bot v2.0.0 | MIT License
    </footer>
  </div>
  
  <script>
    async function fetchStatus() {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        
        // Update status
        const statusDot = document.getElementById('statusDot');
        const statusText = document.getElementById('statusText');
        const startBtn = document.getElementById('startBtn');
        const stopBtn = document.getElementById('stopBtn');
        
        if (data.running) {
          statusDot.className = 'status-dot running';
          statusText.textContent = 'Running';
          startBtn.style.display = 'none';
          stopBtn.style.display = 'inline-block';
          stopBtn.disabled = false;
        } else {
          statusDot.className = 'status-dot stopped';
          statusText.textContent = 'Stopped';
          startBtn.style.display = 'inline-block';
          startBtn.disabled = false;
          startBtn.textContent = '▶️ Start Bot';
          stopBtn.style.display = 'none';
        }
        
        document.getElementById('runtime').textContent = data.runtime;
        document.getElementById('todayApplied').textContent = data.stats.todayApplied;
        document.getElementById('totalApplied').textContent = data.stats.totalApplied;
        document.getElementById('todaySkipped').textContent = data.stats.todaySkipped;
        document.getElementById('todayFailed').textContent = data.stats.todayFailed;
        document.getElementById('dailyLimit').textContent = data.limits.daily;
        document.getElementById('limitInput').value = data.limits.daily;
        
        const progress = (data.stats.todayApplied / data.limits.daily) * 100;
        document.getElementById('progressBar').style.width = Math.min(progress, 100) + '%';
        
        // AI Status
        const geminiEl = document.getElementById('geminiStatus');
        const openrouterEl = document.getElementById('openrouterStatus');
        geminiEl.className = 'ai-provider ' + (data.ai.gemini?.active ? 'active' : 'inactive');
        openrouterEl.className = 'ai-provider ' + (data.ai.openrouter?.active ? 'active' : 'inactive');
        
        // Config
        document.getElementById('environment').textContent = data.config.environment.toUpperCase();
        document.getElementById('location').textContent = data.config.location || 'Worldwide';
        
      } catch (err) {
        console.error('Failed to fetch status:', err);
      }
    }
    
    async function fetchJobs() {
      try {
        const res = await fetch('/api/jobs?limit=10');
        const data = await res.json();
        
        const tbody = document.getElementById('jobsTable');
        if (data.jobs.length === 0) {
          tbody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: #666;">No applications yet</td></tr>';
          return;
        }
        
        tbody.innerHTML = data.jobs.map(job => \`
          <tr>
            <td>\${job.company || 'Unknown'}</td>
            <td>\${job.title || 'Unknown'}</td>
            <td>\${new Date(job.appliedAt).toLocaleString()}</td>
          </tr>
        \`).join('');
        
      } catch (err) {
        console.error('Failed to fetch jobs:', err);
      }
    }
    
    async function startBot() {
      try {
        document.getElementById('startBtn').disabled = true;
        document.getElementById('startBtn').textContent = '⏳ Starting...';
        
        const res = await fetch('/api/bot/start', { method: 'POST' });
        const data = await res.json();
        
        if (data.success) {
          fetchStatus();
        } else {
          alert(data.message);
          document.getElementById('startBtn').disabled = false;
          document.getElementById('startBtn').textContent = '▶️ Start Bot';
        }
      } catch (err) {
        alert('Failed to start bot');
        document.getElementById('startBtn').disabled = false;
        document.getElementById('startBtn').textContent = '▶️ Start Bot';
      }
    }
    
    async function stopBot() {
      if (!confirm('Are you sure you want to stop the bot?')) return;
      
      try {
        const res = await fetch('/api/bot/stop', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          fetchStatus();
        } else {
          alert(data.message);
        }
      } catch (err) {
        alert('Failed to stop bot');
      }
    }
    
    async function clearSessionLock() {
      try {
        const res = await fetch('/api/session/clear-lock', { method: 'POST' });
        const data = await res.json();
        alert(data.message || (data.success ? 'Lock cleared!' : 'Failed to clear lock'));
      } catch (err) {
        alert('Failed to clear session lock');
      }
    }
    
    async function updateLimit() {
      const limit = parseInt(document.getElementById('limitInput').value);
      if (!limit || limit < 1 || limit > 500) {
        alert('Please enter a valid limit between 1 and 500');
        return;
      }
      
      try {
        const res = await fetch('/api/config/daily-limit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ limit }),
        });
        const data = await res.json();
        if (data.success) {
          alert('Daily limit updated to ' + limit);
          fetchStatus();
        } else {
          alert(data.error);
        }
      } catch (err) {
        alert('Failed to update limit');
      }
    }
    
    // Initial fetch
    fetchStatus();
    fetchJobs();
    
    // Auto-refresh every 5 seconds
    setInterval(fetchStatus, 5000);
    setInterval(fetchJobs, 30000);
  </script>
</body>
</html>
`;

// ═══════════════════════════════════════════════════════════════════════════
// SETTINGS PAGE HTML
// ═══════════════════════════════════════════════════════════════════════════

const settingsHTML = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Settings - LinkedIn Easy Apply Bot</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      min-height: 100vh;
      color: #e0e0e0;
      padding: 20px;
    }
    .container { max-width: 900px; margin: 0 auto; }
    header {
      text-align: center;
      padding: 20px 0;
      border-bottom: 1px solid #333;
      margin-bottom: 30px;
    }
    h1 { 
      font-size: 2rem; 
      background: linear-gradient(90deg, #0077b5, #00a0dc);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 10px;
    }
    .nav-link {
      color: #0077b5;
      text-decoration: none;
      padding: 8px 16px;
      border: 1px solid #0077b5;
      border-radius: 8px;
      transition: all 0.3s;
      display: inline-block;
      margin-top: 15px;
    }
    .nav-link:hover { background: #0077b5; color: white; }
    
    .section {
      background: rgba(255,255,255,0.05);
      border-radius: 16px;
      padding: 24px;
      border: 1px solid rgba(255,255,255,0.1);
      margin-bottom: 20px;
    }
    .section h2 {
      color: #0077b5;
      font-size: 1.1rem;
      margin-bottom: 20px;
      padding-bottom: 10px;
      border-bottom: 1px solid rgba(255,255,255,0.1);
    }
    
    .form-row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 15px;
      margin-bottom: 15px;
    }
    .form-group {
      display: flex;
      flex-direction: column;
    }
    .form-group label {
      font-size: 0.85rem;
      color: #888;
      margin-bottom: 5px;
    }
    .form-group input, .form-group select, .form-group textarea {
      background: rgba(255,255,255,0.1);
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 8px;
      padding: 10px 12px;
      color: white;
      font-size: 0.95rem;
    }
    .form-group input:focus, .form-group select:focus, .form-group textarea:focus {
      outline: none;
      border-color: #0077b5;
    }
    .form-group textarea {
      min-height: 80px;
      resize: vertical;
    }
    .form-group.full-width {
      grid-column: 1 / -1;
    }
    
    .checkbox-group {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .checkbox-group input[type="checkbox"] {
      width: 18px;
      height: 18px;
    }
    
    .tags-input {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      padding: 8px;
      background: rgba(255,255,255,0.1);
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 8px;
      min-height: 42px;
    }
    .tag {
      background: #0077b5;
      color: white;
      padding: 4px 10px;
      border-radius: 15px;
      font-size: 0.85rem;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .tag .remove {
      cursor: pointer;
      font-weight: bold;
    }
    .tags-input input {
      flex: 1;
      min-width: 100px;
      background: transparent;
      border: none;
      color: white;
      outline: none;
    }
    
    .btn {
      padding: 12px 30px;
      border: none;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.3s;
    }
    .btn-primary {
      background: #0077b5;
      color: white;
    }
    .btn-primary:hover { background: #005582; }
    .btn-secondary {
      background: rgba(255,255,255,0.1);
      color: white;
      border: 1px solid rgba(255,255,255,0.2);
    }
    
    .actions {
      display: flex;
      gap: 15px;
      justify-content: center;
      margin-top: 30px;
      padding-top: 20px;
      border-top: 1px solid #333;
    }
    
    .toast {
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: #00c853;
      color: white;
      padding: 15px 25px;
      border-radius: 8px;
      display: none;
      animation: slideIn 0.3s ease;
    }
    .toast.error { background: #ff5252; }
    @keyframes slideIn {
      from { transform: translateX(100%); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>⚙️ Bot Settings</h1>
      <a href="/" class="nav-link">← Back to Dashboard</a>
    </header>
    
    <!-- Bot Settings -->
    <div class="section">
      <h2>🤖 Bot Settings</h2>
      <div class="form-row">
        <div class="form-group">
          <label>Daily Application Limit</label>
          <input type="number" id="dailyLimit" min="1" max="500" />
        </div>
        <div class="form-group">
          <label>Switch Topic After</label>
          <input type="number" id="switchAfter" min="1" max="100" />
        </div>
        <div class="form-group">
          <label>Headless Mode</label>
          <select id="headless">
            <option value="false">No (Show Browser)</option>
            <option value="true">Yes (Hidden)</option>
          </select>
        </div>
      </div>
    </div>
    
    <!-- Search Settings -->
    <div class="section">
      <h2>🔍 Search Settings</h2>
      <div class="form-row">
        <div class="form-group full-width">
          <label>Search Terms (press Enter to add)</label>
          <div class="tags-input" id="searchTermsContainer">
            <input type="text" id="searchTermsInput" placeholder="Add search term..." />
          </div>
        </div>
        <div class="form-group">
          <label>Location</label>
          <input type="text" id="searchLocation" />
        </div>
        <div class="form-group">
          <label>Sort By</label>
          <select id="sortBy">
            <option value="Most recent">Most Recent</option>
            <option value="Most relevant">Most Relevant</option>
          </select>
        </div>
        <div class="form-group">
          <label>Date Posted</label>
          <select id="datePosted">
            <option value="Any time">Any Time</option>
            <option value="Past 24 hours">Past 24 Hours</option>
            <option value="Past week">Past Week</option>
            <option value="Past month">Past Month</option>
          </select>
        </div>
      </div>
    </div>
    
    <!-- Job Filters -->
    <div class="section">
      <h2>🎯 Job Filters</h2>
      <div class="form-row">
        <div class="form-group full-width">
          <label>Experience Level</label>
          <div style="display: flex; flex-wrap: wrap; gap: 15px; margin-top: 5px;">
            <label class="checkbox-group"><input type="checkbox" id="exp_entry" value="Entry level" /> Entry Level</label>
            <label class="checkbox-group"><input type="checkbox" id="exp_associate" value="Associate" /> Associate</label>
            <label class="checkbox-group"><input type="checkbox" id="exp_mid" value="Mid-Senior level" /> Mid-Senior</label>
            <label class="checkbox-group"><input type="checkbox" id="exp_director" value="Director" /> Director</label>
          </div>
        </div>
        <div class="form-group full-width">
          <label>Job Type</label>
          <div style="display: flex; flex-wrap: wrap; gap: 15px; margin-top: 5px;">
            <label class="checkbox-group"><input type="checkbox" id="type_fulltime" value="Full-time" /> Full-time</label>
            <label class="checkbox-group"><input type="checkbox" id="type_parttime" value="Part-time" /> Part-time</label>
            <label class="checkbox-group"><input type="checkbox" id="type_contract" value="Contract" /> Contract</label>
            <label class="checkbox-group"><input type="checkbox" id="type_internship" value="Internship" /> Internship</label>
          </div>
        </div>
        <div class="form-group full-width">
          <label>Work Location</label>
          <div style="display: flex; flex-wrap: wrap; gap: 15px; margin-top: 5px;">
            <label class="checkbox-group"><input type="checkbox" id="site_remote" value="Remote" /> Remote</label>
            <label class="checkbox-group"><input type="checkbox" id="site_hybrid" value="Hybrid" /> Hybrid</label>
            <label class="checkbox-group"><input type="checkbox" id="site_onsite" value="On-site" /> On-site</label>
          </div>
        </div>
        <div class="form-group full-width">
          <label>Bad Words in Description (skip jobs with these)</label>
          <div class="tags-input" id="badWordsContainer">
            <input type="text" id="badWordsInput" placeholder="Add word..." />
          </div>
        </div>
        <div class="form-group full-width">
          <label>Bad Job Titles (skip these job types)</label>
          <div class="tags-input" id="badJobTitlesContainer">
            <input type="text" id="badJobTitlesInput" placeholder="Add title..." />
          </div>
        </div>
      </div>
    </div>
    
    <!-- Personal Info -->
    <div class="section">
      <h2>👤 Personal Information</h2>
      <div class="form-row">
        <div class="form-group">
          <label>First Name</label>
          <input type="text" id="firstName" />
        </div>
        <div class="form-group">
          <label>Middle Name</label>
          <input type="text" id="middleName" />
        </div>
        <div class="form-group">
          <label>Last Name</label>
          <input type="text" id="lastName" />
        </div>
        <div class="form-group">
          <label>Phone Number</label>
          <input type="text" id="phoneNumber" />
        </div>
        <div class="form-group">
          <label>Current City</label>
          <input type="text" id="currentCity" />
        </div>
        <div class="form-group">
          <label>Country</label>
          <input type="text" id="country" />
        </div>
      </div>
    </div>
    
    <!-- Application Details -->
    <div class="section">
      <h2>📝 Application Details</h2>
      <div class="form-row">
        <div class="form-group">
          <label>Years of Experience</label>
          <input type="text" id="yearsOfExperience" />
        </div>
        <div class="form-group">
          <label>Require Visa Sponsorship</label>
          <select id="requireVisa">
            <option value="Yes">Yes</option>
            <option value="No">No</option>
          </select>
        </div>
        <div class="form-group">
          <label>Desired Salary (Min)</label>
          <input type="number" id="desiredSalary" />
        </div>
        <div class="form-group">
          <label>Max Salary</label>
          <input type="number" id="maxSalary" />
        </div>
        <div class="form-group">
          <label>Salary Currency</label>
          <input type="text" id="salaryCurrency" />
        </div>
        <div class="form-group">
          <label>Notice Period (days)</label>
          <input type="number" id="noticePeriod" />
        </div>
        <div class="form-group">
          <label>Website/Portfolio</label>
          <input type="text" id="website" />
        </div>
        <div class="form-group">
          <label>LinkedIn URL</label>
          <input type="text" id="linkedInUrl" />
        </div>
      </div>
    </div>
    
    <!-- Resume/Profile -->
    <div class="section">
      <h2>📄 Resume & Profile</h2>
      <div class="form-row">
        <div class="form-group full-width">
          <label>LinkedIn Headline</label>
          <input type="text" id="linkedInHeadline" />
        </div>
        <div class="form-group full-width">
          <label>LinkedIn Summary</label>
          <textarea id="linkedInSummary" rows="3"></textarea>
        </div>
        <div class="form-group full-width">
          <label>Complete Profile (for AI answers)</label>
          <textarea id="userInfo" rows="10" placeholder="Paste your full resume/profile here for AI to use when answering questions..."></textarea>
        </div>
      </div>
    </div>
    
    <!-- Advanced -->
    <div class="section">
      <h2>🔧 Advanced Settings</h2>
      <div class="form-row">
        <div class="form-group">
          <label class="checkbox-group">
            <input type="checkbox" id="skipResumeUpload" />
            Skip Resume Upload
          </label>
        </div>
        <div class="form-group">
          <label class="checkbox-group">
            <input type="checkbox" id="followCompanies" />
            Follow Companies
          </label>
        </div>
        <div class="form-group">
          <label class="checkbox-group">
            <input type="checkbox" id="stealthMode" />
            Stealth Mode
          </label>
        </div>
        <div class="form-group">
          <label>Has Master's Degree</label>
          <select id="hasMasters">
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        </div>
        <div class="form-group">
          <label>Current Experience (years)</label>
          <input type="number" id="currentExperience" />
        </div>
      </div>
    </div>
    
    <div class="actions">
      <button class="btn btn-primary" onclick="saveSettings()">💾 Save Settings</button>
      <button class="btn btn-secondary" onclick="loadSettings()">🔄 Reload</button>
    </div>
  </div>
  
  <div class="toast" id="toast"></div>
  
  <script>
    let settings = {};
    let searchTerms = [];
    let badWords = [];
    let badJobTitles = [];
    
    function showToast(message, isError = false) {
      const toast = document.getElementById('toast');
      toast.textContent = message;
      toast.className = 'toast' + (isError ? ' error' : '');
      toast.style.display = 'block';
      setTimeout(() => toast.style.display = 'none', 3000);
    }
    
    function renderTags(containerId, items, inputId) {
      const container = document.getElementById(containerId);
      // Store current input value before clearing
      const oldInput = document.getElementById(inputId);
      const currentValue = oldInput ? oldInput.value : '';
      const placeholder = oldInput ? oldInput.placeholder : 'Add...';
      
      container.innerHTML = '';
      items.forEach((item, i) => {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.innerHTML = item + '<span class="remove" onclick="removeTag(\\'' + containerId + '\\', ' + i + ')">×</span>';
        container.appendChild(tag);
      });
      
      // Create new input element
      const newInput = document.createElement('input');
      newInput.type = 'text';
      newInput.id = inputId;
      newInput.placeholder = placeholder;
      newInput.value = currentValue;
      container.appendChild(newInput);
      
      // Re-attach event listener
      setupTagInputElement(newInput, containerId, items);
    }
    
    function setupTagInputElement(input, containerId, array) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.value.trim()) {
          e.preventDefault();
          array.push(e.target.value.trim());
          e.target.value = '';
          renderTags(containerId, array, e.target.id);
        }
      });
    }
    
    function removeTag(containerId, index) {
      if (containerId === 'searchTermsContainer') {
        searchTerms.splice(index, 1);
        renderTags('searchTermsContainer', searchTerms, 'searchTermsInput');
      } else if (containerId === 'badWordsContainer') {
        badWords.splice(index, 1);
        renderTags('badWordsContainer', badWords, 'badWordsInput');
      } else if (containerId === 'badJobTitlesContainer') {
        badJobTitles.splice(index, 1);
        renderTags('badJobTitlesContainer', badJobTitles, 'badJobTitlesInput');
      }
    }
    
    async function loadSettings() {
      try {
        const res = await fetch('/api/settings');
        settings = await res.json();
        
        // Simple fields
        ['dailyLimit', 'switchAfter', 'searchLocation', 'sortBy', 'datePosted',
         'firstName', 'middleName', 'lastName', 'phoneNumber', 'currentCity', 'country',
         'yearsOfExperience', 'requireVisa', 'desiredSalary', 'maxSalary', 'salaryCurrency',
         'noticePeriod', 'website', 'linkedInUrl', 'linkedInHeadline', 'linkedInSummary',
         'userInfo', 'currentExperience'].forEach(id => {
          const el = document.getElementById(id);
          if (el) el.value = settings[id] || '';
        });
        
        // Booleans
        document.getElementById('headless').value = settings.headless ? 'true' : 'false';
        document.getElementById('hasMasters').value = settings.hasMasters ? 'true' : 'false';
        document.getElementById('skipResumeUpload').checked = settings.skipResumeUpload || false;
        document.getElementById('followCompanies').checked = settings.followCompanies || false;
        document.getElementById('stealthMode').checked = settings.stealthMode !== false;
        
        // Experience level checkboxes
        const expLevels = settings.experienceLevel || [];
        document.getElementById('exp_entry').checked = expLevels.includes('Entry level');
        document.getElementById('exp_associate').checked = expLevels.includes('Associate');
        document.getElementById('exp_mid').checked = expLevels.includes('Mid-Senior level');
        document.getElementById('exp_director').checked = expLevels.includes('Director');
        
        // Job type checkboxes
        const jobTypes = settings.jobType || [];
        document.getElementById('type_fulltime').checked = jobTypes.includes('Full-time');
        document.getElementById('type_parttime').checked = jobTypes.includes('Part-time');
        document.getElementById('type_contract').checked = jobTypes.includes('Contract');
        document.getElementById('type_internship').checked = jobTypes.includes('Internship');
        
        // Work location checkboxes
        const onSite = settings.onSite || [];
        document.getElementById('site_remote').checked = onSite.includes('Remote');
        document.getElementById('site_hybrid').checked = onSite.includes('Hybrid');
        document.getElementById('site_onsite').checked = onSite.includes('On-site');
        
        // Tags
        searchTerms = settings.searchTerms || [];
        badWords = settings.badWords || [];
        badJobTitles = settings.badJobTitles || [];
        renderTags('searchTermsContainer', searchTerms, 'searchTermsInput');
        renderTags('badWordsContainer', badWords, 'badWordsInput');
        renderTags('badJobTitlesContainer', badJobTitles, 'badJobTitlesInput');
        
        showToast('Settings loaded');
      } catch (err) {
        showToast('Failed to load settings', true);
      }
    }
    
    async function saveSettings() {
      try {
        // Collect all values
        const updates = {
          dailyLimit: parseInt(document.getElementById('dailyLimit').value) || 20,
          switchAfter: parseInt(document.getElementById('switchAfter').value) || 30,
          headless: document.getElementById('headless').value === 'true',
          searchTerms: searchTerms,
          searchLocation: document.getElementById('searchLocation').value,
          sortBy: document.getElementById('sortBy').value,
          datePosted: document.getElementById('datePosted').value,
          
          experienceLevel: [
            document.getElementById('exp_entry').checked && 'Entry level',
            document.getElementById('exp_associate').checked && 'Associate',
            document.getElementById('exp_mid').checked && 'Mid-Senior level',
            document.getElementById('exp_director').checked && 'Director',
          ].filter(Boolean),
          
          jobType: [
            document.getElementById('type_fulltime').checked && 'Full-time',
            document.getElementById('type_parttime').checked && 'Part-time',
            document.getElementById('type_contract').checked && 'Contract',
            document.getElementById('type_internship').checked && 'Internship',
          ].filter(Boolean),
          
          onSite: [
            document.getElementById('site_remote').checked && 'Remote',
            document.getElementById('site_hybrid').checked && 'Hybrid',
            document.getElementById('site_onsite').checked && 'On-site',
          ].filter(Boolean),
          
          badWords: badWords,
          badJobTitles: badJobTitles,
          
          firstName: document.getElementById('firstName').value,
          middleName: document.getElementById('middleName').value,
          lastName: document.getElementById('lastName').value,
          phoneNumber: document.getElementById('phoneNumber').value,
          currentCity: document.getElementById('currentCity').value,
          country: document.getElementById('country').value,
          
          yearsOfExperience: document.getElementById('yearsOfExperience').value,
          requireVisa: document.getElementById('requireVisa').value,
          desiredSalary: parseInt(document.getElementById('desiredSalary').value) || 0,
          maxSalary: parseInt(document.getElementById('maxSalary').value) || 0,
          salaryCurrency: document.getElementById('salaryCurrency').value,
          noticePeriod: parseInt(document.getElementById('noticePeriod').value) || 0,
          website: document.getElementById('website').value,
          linkedInUrl: document.getElementById('linkedInUrl').value,
          
          linkedInHeadline: document.getElementById('linkedInHeadline').value,
          linkedInSummary: document.getElementById('linkedInSummary').value,
          userInfo: document.getElementById('userInfo').value,
          
          skipResumeUpload: document.getElementById('skipResumeUpload').checked,
          followCompanies: document.getElementById('followCompanies').checked,
          stealthMode: document.getElementById('stealthMode').checked,
          hasMasters: document.getElementById('hasMasters').value === 'true',
          currentExperience: parseInt(document.getElementById('currentExperience').value) || 0,
        };
        
        const res = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updates),
        });
        
        const data = await res.json();
        if (data.success) {
          showToast('✅ Settings saved successfully!');
        } else {
          showToast(data.error || 'Failed to save', true);
        }
      } catch (err) {
        showToast('Failed to save settings', true);
      }
    }
    
    // Initialize tag inputs after DOM is ready - the event listeners will be attached
    // during renderTags when loadSettings completes
    
    // Load settings on page load
    loadSettings();
  </script>
</body>
</html>
`;

// Serve dashboard
app.get('/', (req, res) => {
  res.send(dashboardHTML);
});

// Serve settings page
app.get('/settings', (req, res) => {
  res.send(settingsHTML);
});

/**
 * Start the web server
 */
export function startWebServer() {
  // Load settings on startup
  loadSettings();
  applySettingsToConfig(config);
  
  const port = config.web.port;
  
  return new Promise((resolve) => {
    const server = app.listen(port, '0.0.0.0', () => {
      console.log(`🌐 Web dashboard running at http://localhost:${port}`);
      resolve(server);
    });
  });
}

/**
 * Check if bot should continue running
 */
export function shouldBotRun() {
  return botRunning;
}

export default {
  startWebServer,
  setBotInstance,
  setBotRunning,
  shouldBotRun,
};
