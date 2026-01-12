/**
 * Pocketbase Service - Job Application Data Storage
 * 
 * Integrates with Pocketbase to store job application data.
 * 
 * @license MIT
 */

import { getSettings } from './settingsManager.js';

const POCKETBASE_URL = process.env.POCKETBASE_URL || 'https://pocket.bugbrewery.tech';
const COLLECTION_NAME = process.env.POCKETBASE_COLLECTION_NAME || 'job_applications';

let authToken = null;
let authExpiry = null;

/**
 * Authenticate with Pocketbase
 */
async function authenticate() {
  const email = process.env.POCKETBASE_EMAIL;
  const password = process.env.POCKETBASE_PASSWORD;
  
  if (!email || !password) {
    console.log('⚠️ Pocketbase credentials not configured. Skipping remote storage.');
    return null;
  }
  
  // Check if token is still valid (with 5 min buffer)
  if (authToken && authExpiry && Date.now() < authExpiry - 5 * 60 * 1000) {
    return authToken;
  }
  
  try {
    // PocketBase v0.23+ uses collections-based auth for superusers
    const response = await fetch(`${POCKETBASE_URL}/api/collections/_superusers/auth-with-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity: email, password }),
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Authentication failed');
    }
    
    const data = await response.json();
    authToken = data.token;
    // Token expires in ~14 days, but we'll refresh more often
    authExpiry = Date.now() + 24 * 60 * 60 * 1000; // 1 day
    
    console.log('✅ Pocketbase authenticated');
    return authToken;
  } catch (error) {
    console.error('❌ Pocketbase auth error:', error.message);
    return null;
  }
}

/**
 * Save job application to Pocketbase
 */
export async function saveJobApplication(jobData) {
  const token = await authenticate();
  if (!token) return null;
  
  try {
    // Use detailed text log if provided, otherwise stringify applicationData
    const logText = jobData.logText || '';
    const applicationDataString = jobData.applicationData 
      ? JSON.stringify(jobData.applicationData, null, 2) 
      : '{}';
    
    const payload = {
      job_id: String(jobData.jobId || ''),
      job_title: String(jobData.title || '').substring(0, 500), // Limit title length
      company_name: String(jobData.company || '').substring(0, 200),
      job_link: String(jobData.url || ''),
      status: jobData.status || 'applied',
      // Send stringified JSON for application_data field
      application_data: applicationDataString,
      // Store detailed text logs in the data field
      data: logText || applicationDataString,
    };
    
    const response = await fetch(`${POCKETBASE_URL}/api/collections/${COLLECTION_NAME}/records`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': token,
      },
      body: JSON.stringify(payload),
    });
    
    if (!response.ok) {
      const errorData = await response.json();
      // Log full error details for debugging
      console.error('❌ Pocketbase validation errors:', JSON.stringify(errorData, null, 2));
      throw new Error(errorData.message || JSON.stringify(errorData.data) || 'Failed to save job application');
    }
    
    const record = await response.json();
    console.log(`📤 Job saved to Pocketbase: ${record.id}`);
    return record;
  } catch (error) {
    console.error('❌ Pocketbase save error:', error.message);
    return null;
  }
}

/**
 * Update job application status in Pocketbase
 */
export async function updateJobStatus(recordId, status) {
  const token = await authenticate();
  if (!token) return null;
  
  try {
    const response = await fetch(`${POCKETBASE_URL}/api/collections/${COLLECTION_NAME}/records/${recordId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': token,
      },
      body: JSON.stringify({ status }),
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Failed to update job status');
    }
    
    const record = await response.json();
    return record;
  } catch (error) {
    console.error('❌ Pocketbase update error:', error.message);
    return null;
  }
}

/**
 * Get job applications from Pocketbase
 */
export async function getJobApplications(page = 1, perPage = 50, filter = '') {
  const token = await authenticate();
  if (!token) return null;
  
  try {
    let url = `${POCKETBASE_URL}/api/collections/${COLLECTION_NAME}/records?page=${page}&perPage=${perPage}&sort=-created`;
    if (filter) {
      url += `&filter=${encodeURIComponent(filter)}`;
    }
    
    const response = await fetch(url, {
      headers: {
        'Authorization': token,
      },
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Failed to fetch job applications');
    }
    
    return await response.json();
  } catch (error) {
    console.error('❌ Pocketbase fetch error:', error.message);
    return null;
  }
}

/**
 * Check if a job has already been applied to (by job_id)
 */
export async function hasAppliedRemote(jobId) {
  const token = await authenticate();
  if (!token) return false;
  
  try {
    const filter = `job_id="${jobId}"`;
    const url = `${POCKETBASE_URL}/api/collections/${COLLECTION_NAME}/records?filter=${encodeURIComponent(filter)}&perPage=1`;
    
    const response = await fetch(url, {
      headers: {
        'Authorization': token,
      },
    });
    
    if (!response.ok) {
      return false;
    }
    
    const data = await response.json();
    return data.totalItems > 0;
  } catch (error) {
    return false;
  }
}

/**
 * Get statistics from Pocketbase
 */
export async function getRemoteStats() {
  const token = await authenticate();
  if (!token) {
    return { available: false };
  }
  
  try {
    const today = new Date().toISOString().split('T')[0];
    
    // Get total count
    const totalResponse = await fetch(
      `${POCKETBASE_URL}/api/collections/${COLLECTION_NAME}/records?perPage=1`,
      { headers: { 'Authorization': token } }
    );
    const totalData = await totalResponse.json();
    
    // Get today's applied count
    const todayFilter = `created>="${today}" && status="applied"`;
    const todayResponse = await fetch(
      `${POCKETBASE_URL}/api/collections/${COLLECTION_NAME}/records?filter=${encodeURIComponent(todayFilter)}&perPage=1`,
      { headers: { 'Authorization': token } }
    );
    const todayData = await todayResponse.json();
    
    return {
      available: true,
      totalRecords: totalData.totalItems || 0,
      todayApplied: todayData.totalItems || 0,
    };
  } catch (error) {
    return { available: false, error: error.message };
  }
}

/**
 * Test Pocketbase connection
 */
export async function testConnection() {
  try {
    const token = await authenticate();
    if (!token) {
      return { success: false, message: 'Authentication failed or credentials not configured' };
    }
    
    const stats = await getRemoteStats();
    return {
      success: true,
      message: 'Connected to Pocketbase',
      stats,
    };
  } catch (error) {
    return { success: false, message: error.message };
  }
}

export default {
  saveJobApplication,
  updateJobStatus,
  getJobApplications,
  hasAppliedRemote,
  getRemoteStats,
  testConnection,
};
