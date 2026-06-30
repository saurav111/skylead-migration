const {
  getLinkedinBlacklist,
  getEmailBlacklist,
  getCampaigns,
  getCampaignLeads,
} = require('./skyleadClient');
const { updateBlacklist } = require('./salesrobotClient');
const { resolveBasicLinkedInUrl, resolveLeadLinkedInUrl } = require('./migrationService');

// Skylead blacklist types we know how to map into Salesrobot.
const TYPE_PROFILE_URL = 'profile_url';
const TYPE_COMPANY_NAME = 'company_name';
const TYPE_FULL_NAME = 'full_name';
const TYPE_EMAIL = 'email';
const TYPE_DOMAIN = 'domain';

// Surfaces Multilead's structured error body (e.g. {"success":false,"message":"..."})
// instead of the opaque "Request failed with status code 403".
function describeError(err) {
  const status = err.response?.status;
  const data = err.response?.data;
  const body = data ? (typeof data === 'string' ? data : JSON.stringify(data)) : '';
  if (status) return `HTTP ${status}${body ? `: ${body}` : ` — ${err.message}`}`;
  return err.message;
}

function leadFullName(lead) {
  const fromFields = lead.allFieldsData?.full_name || lead.fullName;
  const composed = `${lead.firstName || ''} ${lead.lastName || ''}`;
  return (fromFields || composed).replace(/\s+/g, ' ').trim();
}

// Imports each mapped seat's Skylead blacklist into the corresponding Salesrobot
// LinkedIn account. The blacklist is read from the app's internal backend using the
// user's session cookie (the public Open API key cannot read blacklists). Mapping:
//   - profile_url  → imported directly
//   - company_name → imported directly
//   - email        → imported directly (Salesrobot UpdateBlackListDTO.emails)
//   - domain       → imported directly (Salesrobot UpdateBlackListDTO.domains)
//   - full_name    → resolved to profile URL(s) by matching the name against every
//                    lead across every campaign under that seat
//   - anything else (job_title) → skipped (Salesrobot has no equivalent)
async function runBlacklistImport(config, emit) {
  const { skyLeadApiKey, skyLeadUserId, salesrobotApiKey, accountMappings, skyleadCookie, appBaseUrl } = config;

  const summary = {
    accountsProcessed: 0,
    blacklistEntriesRead: 0,
    companyNamesImported: 0,
    profileUrlsImported: 0,
    emailsImported: 0,
    domainsImported: 0,
    fullNamesMatched: 0,
    fullNamesUnmatched: 0,
    unsupportedSkipped: 0,
    errors: [],
    unmatchedNames: [], // { seat, name }
    unsupportedTypes: [], // { seat, type, comparisonType, count }
    companyNamesList: [], // { seat, companyName }
    profileUrlsList: [], // { seat, profileUrl }
    emailsList: [], // { seat, email }
    domainsList: [], // { seat, domain }
    resolvedNames: [], // { seat, name, profileUrl }
  };

  for (const mapping of accountMappings) {
    const { skyLeadAccountId, salesrobotLinkedinAccountUuid } = mapping;

    emit('account_start', { seat: skyLeadAccountId });
    emit('log', { message: `Processing seat ${skyLeadAccountId}...` });

    // The app splits the blacklist into two tabs/endpoints: the LinkedIn tab
    // (company_name, profile_url, full_name, job_title) and the EMAIL_AND_DOMAIN tab
    // (email, domain). Fetch both and combine.
    let rows;
    try {
      const [linkedinRows, emailRows] = await Promise.all([
        getLinkedinBlacklist({
          cookie: skyleadCookie,
          appBase: appBaseUrl,
          userId: skyLeadUserId,
          accountId: skyLeadAccountId,
          onPage: (fetched, total) => emit('log', { message: `  fetched ${fetched}/${total} LinkedIn blacklist entr(ies)...` }),
        }),
        getEmailBlacklist({
          cookie: skyleadCookie,
          appBase: appBaseUrl,
          userId: skyLeadUserId,
          accountId: skyLeadAccountId,
          onPage: (fetched, total) => emit('log', { message: `  fetched ${fetched}/${total} email/domain blacklist entr(ies)...` }),
        }),
      ]);
      rows = [...linkedinRows, ...emailRows];
    } catch (err) {
      const msg = `Failed to fetch blacklist for seat ${skyLeadAccountId}: ${describeError(err)}`;
      emit('error', { message: msg });
      summary.errors.push(msg);
      continue;
    }

    summary.blacklistEntriesRead += rows.length;
    emit('log', { message: `Found ${rows.length} blacklist entr(ies) for seat ${skyLeadAccountId}` });

    const companyNames = new Set();
    const profileUrls = new Set();
    const emails = new Set();
    const domains = new Set();
    const fullNames = []; // raw blacklisted full-name strings to resolve
    const unsupportedByType = new Map(); // type → count

    for (const row of rows) {
      const type = (row.type || '').toLowerCase();
      const val = (row.keyword || '').trim();
      if (!val) continue;

      if (type === TYPE_PROFILE_URL) {
        profileUrls.add(val);
      } else if (type === TYPE_COMPANY_NAME) {
        companyNames.add(val);
      } else if (type === TYPE_EMAIL) {
        emails.add(val);
      } else if (type === TYPE_DOMAIN) {
        domains.add(val);
      } else if (type === TYPE_FULL_NAME) {
        fullNames.push(val);
      } else {
        summary.unsupportedSkipped++;
        unsupportedByType.set(type || 'unknown', (unsupportedByType.get(type || 'unknown') || 0) + 1);
      }
    }

    emit('log', { message: `  ${profileUrls.size} profile URL(s), ${companyNames.size} company name(s), ${emails.size} email(s), ${domains.size} domain(s), ${fullNames.length} full name(s)` });
    for (const [type, count] of unsupportedByType) {
      summary.unsupportedTypes.push({ seat: skyLeadAccountId, type, count });
      emit('log', { message: `  - skipping ${count} "${type}" entr(ies) — no Salesrobot equivalent` });
    }

    // Resolve blacklisted full names → profile URLs using this seat's campaign leads.
    if (fullNames.length > 0) {
      emit('log', { message: `Resolving ${fullNames.length} blacklisted full name(s) against campaign leads...` });
      const nameToUrls = await buildNameToUrlMap(
        skyLeadApiKey, skyLeadUserId, skyLeadAccountId, emit, summary
      );

      for (const name of fullNames) {
        const urls = nameToUrls.get(name.toLowerCase());
        if (urls && urls.size > 0) {
          urls.forEach(u => {
            profileUrls.add(u);
            summary.resolvedNames.push({ seat: skyLeadAccountId, name, profileUrl: u });
          });
          summary.fullNamesMatched++;
        } else {
          summary.fullNamesUnmatched++;
          summary.unmatchedNames.push({ seat: skyLeadAccountId, name });
        }
      }
      emit('log', { message: `Matched ${summary.fullNamesMatched} name(s); ${summary.fullNamesUnmatched} unmatched so far` });
    }

    const companyArr = [...companyNames];
    const profileArr = [...profileUrls];
    const emailArr = [...emails];
    const domainArr = [...domains];

    if (companyArr.length === 0 && profileArr.length === 0 && emailArr.length === 0 && domainArr.length === 0) {
      emit('log', { message: `Nothing to import for seat ${skyLeadAccountId} (no supported blacklist entries).` });
      summary.accountsProcessed++;
      emit('account_done', { seat: skyLeadAccountId });
      continue;
    }

    emit('log', { message: `Importing ${companyArr.length} company name(s) + ${profileArr.length} profile URL(s) + ${emailArr.length} email(s) + ${domainArr.length} domain(s) into Salesrobot account ${salesrobotLinkedinAccountUuid}...` });
    try {
      await updateBlacklist(salesrobotApiKey, salesrobotLinkedinAccountUuid, {
        companyNames: companyArr,
        profileUrls: profileArr,
        emails: emailArr,
        domains: domainArr,
      });
      summary.companyNamesImported += companyArr.length;
      summary.profileUrlsImported += profileArr.length;
      summary.emailsImported += emailArr.length;
      summary.domainsImported += domainArr.length;
      companyArr.forEach(c => summary.companyNamesList.push({ seat: skyLeadAccountId, companyName: c }));
      profileArr.forEach(u => summary.profileUrlsList.push({ seat: skyLeadAccountId, profileUrl: u }));
      emailArr.forEach(e => summary.emailsList.push({ seat: skyLeadAccountId, email: e }));
      domainArr.forEach(d => summary.domainsList.push({ seat: skyLeadAccountId, domain: d }));
      emit('log', { message: `✓ Blacklist updated for Salesrobot account ${salesrobotLinkedinAccountUuid}` });
    } catch (err) {
      const msg = `Failed to update Salesrobot blacklist for account ${salesrobotLinkedinAccountUuid}: ${describeError(err)}`;
      emit('error', { message: msg });
      summary.errors.push(msg);
    }

    summary.accountsProcessed++;
    emit('account_done', { seat: skyLeadAccountId });
  }

  return summary;
}

// Builds a lowercase-fullName → Set(profileUrl) map from every lead across every
// campaign under the given seat.
async function buildNameToUrlMap(apiKey, userId, accountId, emit, summary) {
  const map = new Map();

  let campaigns = [];
  try {
    campaigns = await getCampaigns(apiKey, userId, accountId);
  } catch (err) {
    const msg = `Failed to fetch campaigns for full-name resolution (seat ${accountId}): ${describeError(err)}`;
    emit('log', { message: `WARNING: ${msg}` });
    summary.errors.push(msg);
    return map;
  }

  emit('log', { message: `  Scanning ${campaigns.length} campaign(s) for matching leads...` });

  for (const campaign of campaigns) {
    let leads = [];
    try {
      leads = await getCampaignLeads(apiKey, userId, accountId, campaign.id, (msg) => emit('log', { message: msg }));
    } catch (err) {
      emit('log', { message: `  WARNING: failed to fetch leads for campaign ${campaign.id} — ${err.message}` });
      continue;
    }

    for (const lead of leads) {
      const name = leadFullName(lead).toLowerCase();
      if (!name) continue;
      const url = resolveBasicLinkedInUrl(lead) || resolveLeadLinkedInUrl(lead);
      if (!url) continue;
      if (!map.has(name)) map.set(name, new Set());
      map.get(name).add(url);
    }
  }

  emit('log', { message: `  Indexed ${map.size} distinct lead name(s) with profile URLs.` });
  return map;
}

module.exports = { runBlacklistImport };
