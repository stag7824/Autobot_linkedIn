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
import config from '../config/index.js';
import stateManager from '../services/stateManager.js';
import { getAIStatus } from '../services/aiService.js';

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

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
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
        <button class="btn btn-stop" id="stopBtn" onclick="stopBot()">Stop Bot</button>
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
        const stopBtn = document.getElementById('stopBtn');
        
        if (data.running) {
          statusDot.className = 'status-dot running';
          statusText.textContent = 'Running';
          stopBtn.disabled = false;
        } else {
          statusDot.className = 'status-dot stopped';
          statusText.textContent = 'Stopped';
          stopBtn.disabled = true;
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
    
    async function stopBot() {
      if (!confirm('Are you sure you want to stop the bot?')) return;
      
      try {
        const res = await fetch('/api/bot/stop', { method: 'POST' });
        const data = await res.json();
        alert(data.message);
        fetchStatus();
      } catch (err) {
        alert('Failed to stop bot');
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

// Serve dashboard
app.get('/', (req, res) => {
  res.send(dashboardHTML);
});

/**
 * Start the web server
 */
export function startWebServer() {
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
