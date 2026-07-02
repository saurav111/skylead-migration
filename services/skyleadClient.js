const axios = require('axios');

const BASE = 'https://api.multilead.io/api/open-api/v1';
const BASE_V2 = 'https://api.multilead.io/api/open-api/v2';

// Default host for the Skylead/Multilead web app's internal backend (white-labeled
// per account, e.g. app.expertleads.io). Used for blacklist reads, which the public
// Open API key cannot access (returns 403 "Insufficient permissions").
const APP_BASE = 'https://app.expertleads.io';

function client(apiKey, opts = {}) {
  return axios.create({
    baseURL: opts.base || BASE,
    timeout: opts.timeout ?? 60_000,
    headers: { Authorization: apiKey },
  });
}

// Client for the app's internal backend, authenticated with the user's browser
// session cookie instead of the Open API key.
function appClient(cookie, base, opts = {}) {
  return axios.create({
    baseURL: `${(base || APP_BASE).replace(/\/+$/, '')}/api/backend/v1`,
    timeout: opts.timeout ?? 60_000,
    headers: {
      Cookie: cookie,
      Accept: 'application/json, text/plain, */*',
      'User-Agent': 'Mozilla/5.0',
    },
  });
}

function isRetryableError(err) {
  const status = err.response?.status;
  if (status === 429 || status === 502 || status === 503 || status === 504) return true;

  const code = err.code;
  if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)) {
    return true;
  }

  const msg = err.message || '';
  return /socket hang up|network error|timeout/i.test(msg);
}

async function withRetry(fn, retries = 5) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isLast = attempt === retries - 1;
      if (!isRetryableError(err) || isLast) throw err;

      let waitMs;
      if (err.response?.status === 429) {
        waitMs = parseInt(err.response.headers['retry-after'] || '10', 10) * 1000;
      } else {
        waitMs = Math.min(2000 * 2 ** attempt, 30_000);
      }

      console.warn(`[skylead] Request failed (${err.code || err.message}), retry ${attempt + 1}/${retries - 1} in ${waitMs / 1000}s...`);
      await sleep(waitMs);
    }
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function getMe(apiKey) {
  const resp = await withRetry(() => client(apiKey).get('/user/me'));
  return resp.data; // { id, email, fullName, ... }
}

async function getSeats(apiKey) {
  const all = [];
  let offset = 0;
  const limit = 50;

  while (true) {
    const resp = await withRetry(() =>
      client(apiKey).get('/accounts', {
        params: { offset, limit, onlyActive: true },
      })
    );
    const items = resp.data.result?.items || [];
    all.push(...items);
    if (items.length < limit) break;
    offset += limit;
  }

  return all;
}

async function getCampaigns(apiKey, userId, accountId) {
  const all = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const resp = await withRetry(() =>
      client(apiKey).get(`/users/${userId}/accounts/${accountId}/campaigns`, {
        params: { campaignState: 1, limit, offset, sortOrder: 'DESC', sortColumn: 'createdAt' },
      })
    );
    const result = resp.data.result;
    const campaigns = result?.campaigns || [];
    all.push(...campaigns);
    if (all.length >= result?.count || campaigns.length < limit) break;
    offset += limit;
  }

  return all;
}

async function getCampaignDetails(apiKey, userId, accountId, campaignId) {
  const resp = await withRetry(() =>
    client(apiKey, { timeout: 120_000 }).get(
      `/users/${userId}/accounts/${accountId}/campaigns/${campaignId}/details`
    )
  );
  return resp.data.result;
}

async function getLeadsForStep(apiKey, userId, accountId, campaignId, stepId) {
  const all = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const resp = await withRetry(() =>
      client(apiKey).get(`/users/${userId}/accounts/${accountId}/campaigns/${campaignId}/leads`, {
        params: {
          filterByCurrentStep: JSON.stringify([stepId]),
          limit,
          offset,
        },
      })
    );
    const result = resp.data.result;
    const items = result?.items || [];
    all.push(...items);
    if (all.length >= result?.count || items.length < limit) break;
    offset += limit;
    await sleep(250);
  }

  return all;
}

// Fetches every lead in a campaign regardless of which step they're on.
// Used by the blacklist importer to resolve blacklisted full names → profile URLs.
async function getCampaignLeads(apiKey, userId, accountId, campaignId, onLog) {
  const all = [];
  let offset = 0;
  const limit = 10000;

  while (true) {
    const resp = await withRetry(() =>
      client(apiKey).get(`/users/${userId}/accounts/${accountId}/campaigns/${campaignId}/leads`, {
        params: { limit, offset },
      })
    );
    const result = resp.data.result;
    const items = result?.items || [];
    all.push(...items);
    const total = result?.count ?? all.length;
    if (all.length >= total || items.length < limit) break;
    offset += limit;
    // await sleep(250);
  }

  if (typeof onLog === 'function') {
    onLog(`Fetched ${all.length} campaign lead(s)`);
  }
  return all;
}

// --- Blacklist (Open API v2) ---
// Returns the blacklist groups for a seat. Each group is keyed by type
// (company_name | profile_url | full_name | email | domain | job_title) and a
// comparisonType (exact | contains | starts_with | ends_with). The actual values
// live in the keywords sub-resource (getBlacklistKeywords).
async function getBlacklists(apiKey, userId, accountId) {
  const all = [];
  let offset = 0;
  const limit = 50;

  while (true) {
    const resp = await withRetry(() =>
      client(apiKey, { base: BASE_V2 }).get(
        `/users/${userId}/accounts/${accountId}/blacklists/list`,
        { params: { offset, limit } }
      )
    );
    const data = resp.data?.data;
    const items = data?.blacklists || [];
    all.push(...items);
    const count = data?.count ?? all.length;
    if (all.length >= count || items.length < limit) break;
    offset += limit;
  }

  return all;
}

// Returns the keyword strings belonging to a single blacklist group.
async function getBlacklistKeywords(apiKey, userId, accountId, blacklistId) {
  const all = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const resp = await withRetry(() =>
      client(apiKey, { base: BASE_V2 }).get(
        `/users/${userId}/accounts/${accountId}/blacklists/${blacklistId}/keywords`,
        { params: { offset, limit } }
      )
    );
    const data = resp.data?.data;
    const items = data?.keywords || [];
    all.push(...items.map(k => k.keyword).filter(Boolean));
    const total = data?.pagination?.total ?? data?.count ?? all.length;
    if (all.length >= total || items.length < limit) break;
    offset += limit;
  }

  return all;
}

// Fetches a blacklist "tab" for a seat via the app's internal backend (cookie auth).
// The app splits the blacklist across endpoints: `linkedin` (company_name, profile_url,
// full_name, job_title) and `email` (email + domain — the "EMAIL_AND_DOMAIN" tab).
// Each row is already a flattened keyword: { blacklistId, type, comparisonType,
// keyword, ... }, so no separate keywords call is needed.
async function getAppBlacklist({ cookie, appBase, userId, accountId, tab, onPage }) {
  const all = [];
  let offset = 0;
  const limit = 10000;

  while (true) {
    const resp = await withRetry(() =>
      appClient(cookie, appBase).get(
        `/users/${userId}/accounts/${accountId}/blacklists/${tab}`,
        { params: { limit, offset } }
      )
    );
    const inner = resp.data?.result?.result || resp.data?.result || {};
    const items = inner.blacklists || [];
    all.push(...items);
    const count = inner.count ?? all.length;
    if (typeof onPage === 'function') onPage(all.length, count);
    if (all.length >= count || items.length < limit) break;
    offset += limit;
  }

  return all;
}

function getLinkedinBlacklist({ cookie, appBase, userId, accountId, onPage }) {
  return getAppBlacklist({ cookie, appBase, userId, accountId, tab: 'linkedin', onPage });
}

// Fetches the email + domain blacklist (the app's "EMAIL_AND_DOMAIN" tab).
function getEmailBlacklist({ cookie, appBase, userId, accountId, onPage }) {
  return getAppBlacklist({ cookie, appBase, userId, accountId, tab: 'email', onPage });
}

// Flattens Skylead's tree sequence into a linear list by following the step ordinal.
// Detects branch steps two ways:
//   1. nextSteps with previousStepResult !== 'SUCCESS'
//   2. condition steps (action=condition) with multiple nextSteps — each extra
//      nextStep after the first is a conditional branch
// Returns branch step references so the caller can fetch leads from them.
function flattenSteps(campaignSteps) {
  if (!campaignSteps || campaignSteps.length === 0) return { steps: [], branchesDropped: 0, branchSteps: [] };

  const sorted = [...campaignSteps].sort((a, b) => a.step - b.step);
  const mainStepIds = new Set(sorted.map(s => s.id));

  let branchesDropped = 0;
  const branchSteps = []; // { branchStepId, parentStepId }
  const seenBranchIds = new Set();

  function extractStepId(n) {
    return n.nextStepId || n.stepId || n.id || n.campaignStepId || n.step;
  }

  for (const step of sorted) {
    const nexts = step.nextSteps || [];

    if (step.action === 'condition' && nexts.length > 1) {
      // Condition step: first nextStep is the "true" (main) path,
      // remaining are alternative branches
      for (let i = 1; i < nexts.length; i++) {
        branchesDropped++;
        const branchId = extractStepId(nexts[i]);
        if (branchId && !mainStepIds.has(branchId) && !seenBranchIds.has(branchId)) {
          seenBranchIds.add(branchId);
          branchSteps.push({ branchStepId: branchId, parentStepId: step.id });
        }
      }
    } else {
      for (const n of nexts) {
        if (n.previousStepResult !== 'SUCCESS') {
          branchesDropped++;
          const branchId = extractStepId(n);
          if (branchId && !mainStepIds.has(branchId) && !seenBranchIds.has(branchId)) {
            seenBranchIds.add(branchId);
            branchSteps.push({ branchStepId: branchId, parentStepId: step.id });
          }
        }
      }
    }
  }

  return { steps: sorted, branchesDropped, branchSteps };
}

const STEP_TYPE_MAP = {
  message: 'SEND_MESSAGE',
  connect: 'SEND_CONNECTION_REQUEST',
  inmail: 'SEND_MESSAGE_IN_MAIL',
  email: 'SEND_EMAIL',
  follow: 'FOLLOW',
  view: 'VIEW_PROFILE',
  like: 'LIKE_POST',
  findandverifyemailbylinkedin: 'VIEW_PROFILE',
};

const EMAIL_ACTIONS = new Set(['email']);
const LINKEDIN_ACTIONS = new Set(['message', 'connect', 'inmail', 'follow', 'view', 'like']);

function mapStepType(action) {
  return STEP_TYPE_MAP[action?.toLowerCase()] || 'VIEW_PROFILE';
}

function detectCampaignFamily(steps) {
  for (const step of steps) {
    const action = (step.action || '').toLowerCase();
    if (EMAIL_ACTIONS.has(action)) return 'HYBRID';
  }
  return 'HYBRID';
}

module.exports = { getMe, getSeats, getCampaigns, getCampaignDetails, getLeadsForStep, getCampaignLeads, getBlacklists, getBlacklistKeywords, getLinkedinBlacklist, getEmailBlacklist, flattenSteps, mapStepType, detectCampaignFamily };
