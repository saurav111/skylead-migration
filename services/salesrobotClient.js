const axios = require('axios');

const BASE = 'https://api.boomtechinc.com/api';

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

function client(apiKey) {
  return axios.create({
    baseURL: BASE,
    headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
  });
}

async function req(fn) {
  await throttle();
  return fn();
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

async function createCampaign(apiKey, linkedinAccountUuid, name) {
  const resp = await req(() =>
    client(apiKey).post(`/campaign?linkedinAccountUuid=${linkedinAccountUuid}`, { name })
  );
  return resp.data?.data?.uuid || resp.data?.data?.campaignUuid;
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

async function startCampaign(apiKey, campaignUuid, linkedinAccountUuid) {
  await req(() =>
    client(apiKey).post(
      `/start?campaignUuid=${campaignUuid}&hasInviteMessage=false&linkedinAccountUuid=${linkedinAccountUuid}`
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
    client(apiKey).post('/leadlist/add-from-csv', { name, prospectData })
  );
  // Returns plain string UUID
  return typeof resp.data === 'string' ? resp.data : resp.data?.data;
}

async function addLeadListToCampaign(apiKey, campaignUuid, leadListUuid, startingStepOrdinal) {
  await req(() =>
    client(apiKey).post('/campaign/add-leadlist', {
      campaignUuid,
      leadListUuid,
      startingStepOrdinal,
    })
  );
}

// Converts flat lead array to Salesrobot's columnar prospectData format
function buildProspectData(leads) {
  const fields = [
    { name: 'profileUrl',      pick: l => l.linkedinUrl || '' },
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
  createCampaign,
  addSequenceSteps,
  startCampaign,
  pauseCampaign,
  createLeadListFromCSV,
  addLeadListToCampaign,
};
