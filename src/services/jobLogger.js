/**
 * Job Application Logger Service
 * 
 * Captures detailed logs for each job application in a human-readable text format.
 * This is stored in Pocketbase for debugging and tracking purposes.
 * 
 * @license MIT
 */

// Store logs per job (keyed by jobId)
const jobLogs = new Map();

/**
 * Get timestamp in readable format
 */
function getTimestamp() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

/**
 * Initialize logger for a new job application
 */
export function startJobLog(jobId, title, company, url) {
  const header = `
════════════════════════════════════════════════════════════════════════════════
                         JOB APPLICATION LOG
════════════════════════════════════════════════════════════════════════════════
Job ID:    ${jobId}
Title:     ${title}
Company:   ${company}
URL:       ${url}
Started:   ${getTimestamp()}
════════════════════════════════════════════════════════════════════════════════

`;
  
  jobLogs.set(jobId, {
    lines: [header],
    startTime: Date.now(),
  });
  
  return jobId;
}

/**
 * Add a log entry for a specific job
 */
export function log(jobId, message, indent = 0) {
  const jobLog = jobLogs.get(jobId);
  if (!jobLog) return;
  
  const prefix = '  '.repeat(indent);
  const timestamp = getTimestamp();
  jobLog.lines.push(`[${timestamp}] ${prefix}${message}`);
}

/**
 * Log a section header
 */
export function logSection(jobId, sectionName) {
  const jobLog = jobLogs.get(jobId);
  if (!jobLog) return;
  
  jobLog.lines.push(`\n────────────────────────────────────────────────────────────────────────────────`);
  jobLog.lines.push(`  ${sectionName.toUpperCase()}`);
  jobLog.lines.push(`────────────────────────────────────────────────────────────────────────────────`);
}

/**
 * Log a step in the application process
 */
export function logStep(jobId, stepNumber, maxSteps, modalState) {
  const jobLog = jobLogs.get(jobId);
  if (!jobLog) return;
  
  jobLog.lines.push(`\n┌─ STEP ${stepNumber}/${maxSteps} ─────────────────────────────────────────────────────────────────`);
  if (modalState) {
    jobLog.lines.push(`│  Modal: ${modalState}`);
  }
  jobLog.lines.push(`└──────────────────────────────────────────────────────────────────────────────`);
}

/**
 * Log a form field detection
 */
export function logFormField(jobId, { fieldType, label, currentValue, action, newValue }) {
  const jobLog = jobLogs.get(jobId);
  if (!jobLog) return;
  
  const timestamp = getTimestamp();
  let entry = `[${timestamp}] 📋 FIELD: "${label}"`;
  entry += `\n                    Type: ${fieldType}`;
  if (currentValue) {
    entry += `\n                    Current: "${currentValue}"`;
  }
  entry += `\n                    Action: ${action}`;
  if (newValue !== undefined && newValue !== currentValue) {
    entry += `\n                    New Value: "${newValue}"`;
  }
  
  jobLog.lines.push(entry);
}

/**
 * Log an AI request with full details
 */
export function logAIRequest(jobId, {
  question,
  questionType,
  options,
  provider,
  prompt,
  response,
  error,
  presetAnswer,
  salaryConversion,
}) {
  const jobLog = jobLogs.get(jobId);
  if (!jobLog) return;
  
  const timestamp = getTimestamp();
  let entry = `\n[${timestamp}] 🤖 AI REQUEST`;
  entry += `\n    ┌────────────────────────────────────────────────────────────────────────`;
  entry += `\n    │ Question: "${question}"`;
  entry += `\n    │ Type: ${questionType || 'text'}`;
  
  if (options && options.length > 0) {
    entry += `\n    │ Options: [${options.join(' | ')}]`;
  }
  
  if (presetAnswer !== undefined) {
    entry += `\n    │`;
    entry += `\n    │ ✓ PRESET ANSWER USED (no AI call)`;
    entry += `\n    │ Answer: "${presetAnswer}"`;
    if (salaryConversion) {
      entry += `\n    │ Salary Conversion: ${salaryConversion}`;
    }
  } else if (provider) {
    entry += `\n    │`;
    entry += `\n    │ Provider: ${provider}`;
    
    if (prompt) {
      // Log full prompt - no truncation for debugging
      entry += `\n    │ ───── PROMPT ─────`;
      prompt.split('\n').forEach(line => {
        entry += `\n    │   ${line}`;
      });
    }
    
    if (response) {
      entry += `\n    │`;
      entry += `\n    │ ───── RESPONSE ─────`;
      entry += `\n    │   "${response}"`;
    }
    
    if (error) {
      entry += `\n    │`;
      entry += `\n    │ ❌ ERROR: ${error}`;
    }
  }
  
  entry += `\n    └────────────────────────────────────────────────────────────────────────`;
  
  jobLog.lines.push(entry);
}

/**
 * Log a button click or action
 */
export function logAction(jobId, action, details = '') {
  const jobLog = jobLogs.get(jobId);
  if (!jobLog) return;
  
  const timestamp = getTimestamp();
  let entry = `[${timestamp}] 🖱️  ${action}`;
  if (details) {
    entry += ` - ${details}`;
  }
  
  jobLog.lines.push(entry);
}

/**
 * Log an error
 */
export function logError(jobId, error, context = '') {
  const jobLog = jobLogs.get(jobId);
  if (!jobLog) return;
  
  const timestamp = getTimestamp();
  let entry = `[${timestamp}] ❌ ERROR: ${error}`;
  if (context) {
    entry += `\n                    Context: ${context}`;
  }
  
  jobLog.lines.push(entry);
}

/**
 * Log a warning
 */
export function logWarning(jobId, warning) {
  const jobLog = jobLogs.get(jobId);
  if (!jobLog) return;
  
  const timestamp = getTimestamp();
  jobLog.lines.push(`[${timestamp}] ⚠️  ${warning}`);
}

/**
 * Log success message
 */
export function logSuccess(jobId, message) {
  const jobLog = jobLogs.get(jobId);
  if (!jobLog) return;
  
  const timestamp = getTimestamp();
  jobLog.lines.push(`[${timestamp}] ✅ ${message}`);
}

/**
 * Finalize the log and return as text
 */
export function finalizeJobLog(jobId, status, reason = '') {
  const jobLog = jobLogs.get(jobId);
  if (!jobLog) return '';
  
  const duration = ((Date.now() - jobLog.startTime) / 1000).toFixed(1);
  
  const footer = `

════════════════════════════════════════════════════════════════════════════════
                         APPLICATION ${status.toUpperCase()}
════════════════════════════════════════════════════════════════════════════════
Completed: ${getTimestamp()}
Duration:  ${duration} seconds
Status:    ${status}${reason ? `\nReason:    ${reason}` : ''}
════════════════════════════════════════════════════════════════════════════════
`;
  
  jobLog.lines.push(footer);
  
  const fullLog = jobLog.lines.join('\n');
  
  // Clean up
  jobLogs.delete(jobId);
  
  return fullLog;
}

/**
 * Get current log for a job (without finalizing)
 */
export function getJobLog(jobId) {
  const jobLog = jobLogs.get(jobId);
  if (!jobLog) return '';
  
  return jobLog.lines.join('\n');
}

/**
 * Check if a job log exists
 */
export function hasJobLog(jobId) {
  return jobLogs.has(jobId);
}

export default {
  startJobLog,
  log,
  logSection,
  logStep,
  logFormField,
  logAIRequest,
  logAction,
  logError,
  logWarning,
  logSuccess,
  finalizeJobLog,
  getJobLog,
  hasJobLog,
};
