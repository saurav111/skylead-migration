const axios = require('axios');

const BASE = 'https://api.multilead.io/api/open-api/v1';

function client(apiKey) {
  return axios.create({
    baseURL: BASE,
    headers: { Authorization: apiKey },
  });
}

async function withRetry(fn, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.response?.status;
      if (status === 429) {
        const retryAfter = parseInt(err.response.headers['retry-after'] || '10', 10);
        await sleep(retryAfter * 1000);
        continue;
      }
      throw err;
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
    client(apiKey).get(`/users/${userId}/accounts/${accountId}/campaigns/${campaignId}/details`)
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

// Flattens Skylead's tree sequence into a linear list by following the step ordinal.
// Branches (non-main-path nextSteps) are counted and dropped.
function flattenSteps(campaignSteps) {
  if (!campaignSteps || campaignSteps.length === 0) return { steps: [], branchesDropped: 0 };

  const sorted = [...campaignSteps].sort((a, b) => a.step - b.step);

  let branchesDropped = 0;
  for (const step of sorted) {
    const successBranches = (step.nextSteps || []).filter(
      n => n.previousStepResult === 'SUCCESS'
    );
    const otherBranches = (step.nextSteps || []).length - successBranches.length;
    branchesDropped += otherBranches;
  }

  return { steps: sorted, branchesDropped };
}

const STEP_TYPE_MAP = {
  message: 'SEND_MESSAGE',
  connect: 'SEND_CONNECTION_REQUEST',
  inmail: 'SEND_MESSAGE_IN_MAIL',
  email: 'SEND_EMAIL',
  follow: 'FOLLOW',
  view: 'VIEW_PROFILE',
  like: 'LIKE_POST',
};

function mapStepType(action) {
  return STEP_TYPE_MAP[action?.toLowerCase()] || 'VIEW_PROFILE';
}

module.exports = { getMe, getSeats, getCampaigns, getCampaignDetails, getLeadsForStep, flattenSteps, mapStepType };
