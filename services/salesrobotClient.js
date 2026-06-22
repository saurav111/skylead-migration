const axios = require('axios');

const BASE = 'https://app.boomtechinc.com/api';

// 250 req/min = one request every 240ms (safety margin under 300/min limit)
const REQUEST_INTERVAL_MS = 240;
let lastRequestTime = 0;

async function throttle() {
  const now = Date.now();
  const wait = REQUEST_INTERVAL_MS - (now - lastRequestTime);
  if (wait > 0) await sleep(wait);
  lastRequestTime = Date.now();
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function client(apiKey, opts = {}) {
  return axios.create({
    baseURL: BASE,
    timeout: opts.timeout || 60_000,
    headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
  });
}

function extractError(err) {
  const body = err.response?.data;
  const bodyStr = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : '';
  return bodyStr
    ? `HTTP ${err.response?.status}: ${bodyStr}`
    : err.message;
}

async function req(fn) {
  await throttle();
  try {
    return await fn();
  } catch (err) {
    const msg = extractError(err);
    const enhanced = new Error(msg);
    enhanced.response = err.response;
    throw enhanced;
  }
}

async function getLinkedinAccounts(apiKey) {
  const all = [];
  let page = 1;
  const size = 50;

  while (true) {
    const resp = await req(() =>
      client(apiKey).get('/linkedinAccounts', {
        params: { page, size, sort: 'id,desc' },
      })
    );
    const result = resp.data?.data;
    const items = result?.data || [];
    all.push(...items);
    if (page >= (result?.totalPages || 1) || items.length === 0) break;
    page++;
  }

  return all;
}

async function getEmailAccounts(apiKey) {
  const resp = await req(() =>
    client(apiKey).get('/emailAccounts/list-all')
  );
  const data = resp.data?.data || resp.data;
  return Array.isArray(data) ? data : [];
}

async function createCampaign(apiKey, linkedinAccountUuid, name, campaignFamily = 'LINKEDIN') {
  const resp = await req(() =>
    client(apiKey).post(`/campaign?linkedinAccountUuid=${linkedinAccountUuid}`, {
      campaignName: name,
      campaignType: 'ADVANCED',
      campaignFamily,
      linkedinAccountUuid,
    })
  );
  const d = resp.data?.data;
  return typeof d === 'string' ? d : d?.uuid || d?.campaignUuid;
}

async function createEmailCampaign(apiKey, nylasAccountUuid, name) {
  const resp = await req(() =>
    client(apiKey).post(`/campaign/nylas?nylasAccountUuid=${nylasAccountUuid}`, {
      campaignName: name,
      campaignType: 'ADVANCED',
      campaignFamily: 'NYLAS',
      nylasAccountUuid,
    })
  );
  const d = resp.data?.data;
  return typeof d === 'string' ? d : d?.uuid || d?.campaignUuid;
}

async function addSequenceSteps(apiKey, linkedinAccountUuid, campaignUuid, sequenceStepDTOList) {
  await req(() =>
    client(apiKey).post(`/sequence/save/from-steps?linkedinAccountUuid=${linkedinAccountUuid}`, {
      campaignUuid,
      selectedAccountType: 'LINKEDIN_ACCOUNT',
      campaignType: 'ADVANCED',
      deleteExistingConditionalSequence: false,
      sequenceStepDTOList,
    })
  );
}

async function addSequenceStepsNylas(apiKey, nylasAccountUuid, campaignUuid, sequenceStepDTOList) {
  await req(() =>
    client(apiKey).post(`/sequence/save/from-steps-nylas?nylasAccountUuid=${nylasAccountUuid}`, {
      campaignUuid,
      selectedAccountType: 'NYLAS_ACCOUNT',
      campaignType: 'ADVANCED',
      deleteExistingConditionalSequence: false,
      sequenceStepDTOList,
    })
  );
}

async function addRunnerAccounts(apiKey, campaignUuid, emailAccountUuids = [], linkedinAccountUuids = []) {
  await req(() =>
    client(apiKey).post('/campaign/add-runner-accounts', {
      campaignUuid,
      emailAccountUuids,
      linkedinAccountUuids,
    })
  );
}

async function startCampaign(apiKey, campaignUuid, linkedinAccountUuid, hasInviteMessage = false) {
  await req(() =>
    client(apiKey, { timeout: 120_000 }).post(
      `/start?campaignUuid=${campaignUuid}&hasInviteMessage=${hasInviteMessage}&linkedinAccountUuid=${linkedinAccountUuid}`
    )
  );
}

async function pauseCampaign(apiKey, campaignUuid, linkedinAccountUuid) {
  await req(() =>
    client(apiKey).post(
      `/campaign/pause?linkedinAccountUuid=${linkedinAccountUuid}&campaignUuid=${campaignUuid}&pause=true&continueStartedCampaign=false`
    )
  );
}

async function createLeadListFromCSV(apiKey, name, leads) {
  const prospectData = buildProspectData(leads);
  const resp = await req(() =>
    client(apiKey, { timeout: 180_000 }).post('/leadlist/add-from-csv', { name, prospectData })
  );
  return typeof resp.data === 'string' ? resp.data : resp.data?.data;
}

async function addLeadListToCampaign(apiKey, campaignUuid, leadListUuid, startingStepOrdinal) {
  await req(() =>
    client(apiKey, { timeout: 180_000 }).post('/campaign/add-leadlist', {
      campaignUuid,
      leadListUuid,
      startingStepOrdinal,
    })
  );
}

// Adds leads directly to a campaign (no startingStepOrdinal — they land at step 1).
// Used to seed the campaign with at least one lead so it can be started.
async function addLeadsDirectToCampaign(apiKey, linkedinAccountUuid, campaignUuid, leads) {
  const prospectData = buildProspectData(leads);
  await req(() =>
    client(apiKey).post(
      `/add-from-csv?linkedinAccountUuid=${linkedinAccountUuid}&campaignUuid=${campaignUuid}`,
      { prospectData, dontAddIfInAnotherLinkedinAccountForMyUser: false }
    )
  );
}

// Converts flat lead array to Salesrobot's columnar prospectData format
function buildProspectData(leads) {
  const fields = [
    { name: 'profileUrl',      pick: l => l._resolvedUrl || l.linkedinUrl || '' },
    { name: 'firstName',       pick: l => l.firstName || '' },
    { name: 'lastName',        pick: l => l.lastName || '' },
    { name: 'fullName',        pick: l => l.allFieldsData?.full_name || l.fullName || '' },
    { name: 'jobTitle',        pick: l => l.occupation || '' },
    { name: 'companyName',     pick: l => l.allFieldsData?.currentCompany || l.company || '' },
    { name: 'emailId',         pick: l => l.personalEmail || l.allFieldsData?.email || '' },
    { name: 'phoneNumber',     pick: l => l.allFieldsData?.phone || '' },
    { name: 'connectionLevel', pick: l => String(l.connectionDegree || '') },
    { name: 'profilePhoto',    pick: l => l.image || '' },
    { name: 'Headline',        pick: l => l.headline || '' },
    { name: 'Country',         pick: l => l.allFieldsData?.country || '' },
  ];

  return fields.map(({ name, pick }) => ({
    name,
    values: leads.map(pick),
  }));
}

module.exports = {
  getLinkedinAccounts,
  getEmailAccounts,
  createCampaign,
  createEmailCampaign,
  addSequenceSteps,
  addSequenceStepsNylas,
  addRunnerAccounts,
  startCampaign,
  pauseCampaign,
  createLeadListFromCSV,
  addLeadListToCampaign,
  addLeadsDirectToCampaign,
};
