const { randomUUID } = require('crypto');
const {
  getCampaigns,
  getCampaignDetails,
  getLeadsForStep,
  getCampaignLeads,
  flattenSteps,
  mapStepType,
  detectCampaignFamily,
} = require('./skyleadClient');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Skylead email steps store body as HTML (<html><div>...</div>). Salesrobot expects plain text.
function htmlToPlainText(html) {
  if (!html || typeof html !== 'string') return '';

  let text = html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(div|p|li|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");

  text = text.split('\n').map(line => line.trimEnd()).join('\n');
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

function resolveLeadEmail(lead) {
  const identifiers = lead.profileIdentifiers || [];

  const personalId = identifiers.find(p => p.identityTypeId === 4);
  if (personalId?.identifier?.trim()) return personalId.identifier.trim();

  const businessId = identifiers.find(p => p.identityTypeId === 5);
  if (businessId?.identifier?.trim()) return businessId.identifier.trim();

  return (
    lead.personalEmail
    || lead.businessEmail
    || lead.allFieldsData?.email
    || ''
  ).trim();
}

function resolveLeadLinkedInUrl(lead) {
  const identifiers = lead.profileIdentifiers || [];

  const navId = identifiers.find(p => p.identityTypeId === 2);
  if (navId?.identifier?.trim()) {
    const id = navId.identifier.trim();
    return id.startsWith('http')
      ? id
      : `https://www.linkedin.com/sales/people/${id}`;
  }

  const basicId = identifiers.find(p => p.identityTypeId === 1);
  if (basicId?.identifier?.trim()) {
    const id = basicId.identifier.trim();
    return id.startsWith('http')
      ? id
      : `https://www.linkedin.com/in/${id}`;
  }

  return (lead.linkedinUrl || '').trim();
}

// Resolves the lead's BASIC LinkedIn (/in/<memberId>) URL specifically. Salesrobot
// stores prospects in the /in/ form, whereas resolveLeadLinkedInUrl prefers the
// Sales Navigator (/sales/people/<navId>) URL — a different identifier namespace.
// So pause-matching must key off the /in/ identifier, not the Sales Nav one.
function resolveBasicLinkedInUrl(lead) {
  const identifiers = lead.profileIdentifiers || [];

  const basicId = identifiers.find(p => p.identityTypeId === 1);
  if (basicId?.identifier?.trim()) {
    const id = basicId.identifier.trim();
    return id.startsWith('http') ? id : `https://www.linkedin.com/in/${id}`;
  }

  return (lead.linkedinUrl || '').trim();
}

// Last path segment after splitting on "/" — used to compare Skylead identifiers
// with Salesrobot uniqueLinkedinId / profileUrl values.
function lastPathSegment(value) {
  if (!value || typeof value !== 'string') return '';
  const trimmed = value.trim().replace(/\/+$/, '');
  const parts = trimmed.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

function normalizeIdentifierSegment(value) {
  const segment = lastPathSegment(value) || (typeof value === 'string' ? value.trim() : '');
  return segment ? segment.toLowerCase() : '';
}

// Skylead profileIdentifiers identityTypeId 2 — Sales Navigator member id.
function resolveSkyleadType2Id(lead) {
  const identifiers = lead.profileIdentifiers || [];
  const navId = identifiers.find(p => p.identityTypeId === 2);
  if (!navId?.identifier?.trim()) return '';
  return normalizeIdentifierSegment(navId.identifier);
}

// Skylead profileIdentifiers identityTypeId 1 — basic LinkedIn /in/ member id.
function resolveSkyleadType1Id(lead) {
  const identifiers = lead.profileIdentifiers || [];
  const basicId = identifiers.find(p => p.identityTypeId === 1);
  if (!basicId?.identifier?.trim()) return '';
  return normalizeIdentifierSegment(basicId.identifier);
}

// Reads the human-readable "next step" label from a Skylead lead (UI shows "Finished").
function leadNextStepLabel(lead) {
  const candidates = [
    lead.nextStep,
    lead.nextStepName,
    lead.nextCampaignStep,
    lead.nextStepLabel,
    lead.allFieldsData?.nextStep,
    lead.allFieldsData?.next_step,
  ];
  for (const c of candidates) {
    if (c == null) continue;
    if (typeof c === 'string') {
      const s = c.trim();
      if (s) return s;
      continue;
    }
    if (typeof c === 'object') {
      const inner = c.name ?? c.label ?? c.stepName ?? c.title ?? c.value ?? '';
      if (typeof inner === 'string' && inner.trim()) return inner.trim();
    }
  }
  return '';
}

// A lead that has completed the whole Skylead sequence shows nextStep "Finished".
// Such leads should be paused in Salesrobot so it doesn't resume the sequence.
function isLeadFinished(lead) {
  if (lead.isFinished === true || lead.sequenceFinished === true) return true;
  return leadNextStepLabel(lead).toLowerCase() === 'finished';
}

function buildPauseLeadRecord(lead, identity) {
  return {
    ...lead,
    _resolvedUrl: identity.url,
    _resolvedEmail: identity.email,
    _emailOnly: identity.emailOnly,
    _finished: isLeadFinished(lead),
    _paused: lead.active === false || isLeadFinished(lead),
  };
}

// Indexes Skylead leads by identifier type so Salesrobot prospects can be matched
// with a fixed priority (uniqueLinkedinId → profileUrl → linkedinEmail).
function addLeadToPauseRegistry(registry, lead) {
  const type2 = resolveSkyleadType2Id(lead);
  if (type2) registry.set(`type2:${type2}`, lead);

  const type1 = resolveSkyleadType1Id(lead);
  if (type1) registry.set(`type1:${type1}`, lead);

  const email = (lead._resolvedEmail || resolveLeadEmail(lead) || '').trim().toLowerCase();
  if (email) registry.set(`email:${email}`, lead);
}

function findLeadInPauseRegistry(registry, prospect) {
  const uniqueLinkedinId = (prospect.uniqueLinkedinId || '').trim();
  if (uniqueLinkedinId) {
    const segment = normalizeIdentifierSegment(uniqueLinkedinId);
    return segment ? (registry.get(`type2:${segment}`) || null) : null;
  }

  const profileUrl = (prospect.profileUrl || prospect.linkedinUrl || '').trim();
  if (profileUrl) {
    const segment = normalizeIdentifierSegment(profileUrl);
    return segment ? (registry.get(`type1:${segment}`) || null) : null;
  }

  const email = (prospect.linkedinEmail || prospect.linkedinEmailId || prospect.emailId || prospect.email || '')
    .trim()
    .toLowerCase();
  if (email) return registry.get(`email:${email}`) || null;

  return null;
}

// Stable identity for deduping Skylead leads in the pause queue.
function leadPauseDedupeKey(lead) {
  const email = (lead._resolvedEmail || resolveLeadEmail(lead) || '').trim().toLowerCase();
  if (email) return `email:${email}`;
  const url = lead._resolvedUrl || resolveLeadLinkedInUrl(lead) || resolveBasicLinkedInUrl(lead) || lead.linkedinUrl;
  if (url) return url.toLowerCase();
  return '';
}

// Statuses that mean the prospect will not be contacted further in Salesrobot.
const PAUSED_PROSPECT_STATUSES = new Set([
  'STOPPED',
  'PAUSED',
  'COMPLETED',
  'FINISHED',
]);

const PAUSE_VERIFY_BACKOFF_MS = [5000, 8000, 12000, 15000, 18000, 20000];
const PAUSE_BATCH_SIZE = 100;

function prospectUuid(prospect) {
  return prospect.uuid || prospect.prospectUuid || '';
}

function prospectStatusLabel(prospect) {
  const status = String(prospect.status || '').trim().toUpperCase();
  return status || '(none)';
}

function isProspectStoppedInSalesrobot(prospect) {
  const status = prospectStatusLabel(prospect);
  return status !== '(none)' && PAUSED_PROSPECT_STATUSES.has(status);
}

function buildProspectMap(prospects) {
  const map = new Map();
  for (const p of prospects) {
    const uuid = prospectUuid(p);
    if (uuid) map.set(uuid, p);
  }
  return map;
}

function countMatchedProspectStatusDistribution(matchedByUuid, prospects) {
  const counts = new Map();
  for (const p of prospects) {
    const uuid = prospectUuid(p);
    if (!uuid || !matchedByUuid.has(uuid)) continue;
    const label = prospectStatusLabel(p);
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return counts;
}

function formatStatusDistribution(counts) {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([status, count]) => `${status}: ${count}`)
    .join(', ');
}

async function pauseProspectsInBatches(pauseFn, uuids, onBatchError) {
  for (let i = 0; i < uuids.length; i += PAUSE_BATCH_SIZE) {
    const batch = uuids.slice(i, i + PAUSE_BATCH_SIZE);
    try {
      await pauseFn(batch);
    } catch (err) {
      if (onBatchError) onBatchError(err, batch);
    }
  }
}

// Re-pauses remaining prospects with backoff until they reach a terminal/paused status
// or no further progress is made.
async function pauseAndVerify({
  matchedByUuid,
  pauseFn,
  fetchFn,
  emit,
  logPrefix = '[pause-prospects]',
  onBatchError,
  maxAttempts = 6,
}) {
  const verifiedByUuid = new Map();
  let remaining = new Set(matchedByUuid.keys());

  for (let attempt = 0; attempt < maxAttempts && remaining.size > 0; attempt++) {
    await pauseProspectsInBatches(pauseFn, [...remaining], onBatchError);

    const backoff = PAUSE_VERIFY_BACKOFF_MS[Math.min(attempt, PAUSE_VERIFY_BACKOFF_MS.length - 1)];
    if (backoff > 0) await sleep(backoff);

    const prospectMap = buildProspectMap(await fetchFn());
    const before = remaining.size;

    for (const uuid of [...remaining]) {
      const prospect = prospectMap.get(uuid);
      if (prospect && isProspectStoppedInSalesrobot(prospect)) {
        verifiedByUuid.set(uuid, prospect);
        remaining.delete(uuid);
      }
    }

    if (emit) {
      const settled = before - remaining.size;
      emit('log', {
        message: `${logPrefix} Attempt ${attempt + 1}/${maxAttempts}: ${verifiedByUuid.size}/${matchedByUuid.size} paused (${remaining.size} remaining${settled > 0 ? `, +${settled} this round` : ''})`,
      });
    }

    if (remaining.size === 0) break;
    if (before - remaining.size === 0 && attempt > 0) break;
  }

  const afterProspects = await fetchFn();
  if (emit) {
    const dist = countMatchedProspectStatusDistribution(matchedByUuid, afterProspects);
    emit('log', {
      message: `${logPrefix} Status breakdown among matched: ${formatStatusDistribution(dist) || 'none'}`,
    });
  }

  for (const p of afterProspects) {
    const uuid = prospectUuid(p);
    if (!uuid || !matchedByUuid.has(uuid)) continue;
    if (isProspectStoppedInSalesrobot(p)) verifiedByUuid.set(uuid, p);
  }

  return { verifiedByUuid, remaining, finalProspectMap: buildProspectMap(afterProspects) };
}

function buildQueuedNotPausedProspectRow(campaignName, lead, { reason, prospect, prospectUuid } = {}) {
  return {
    campaignName,
    reason,
    prospectUuid: prospectUuid || '',
    salesrobotStatus: prospect ? prospectStatusLabel(prospect) : '',
    skyleadLeadId: lead.id || '',
    finishedInSkylead: lead._finished ? 'yes' : 'no',
    pausedInSkylead: lead.active === false ? 'yes' : 'no',
    profileUrl: lead._resolvedUrl || resolveLeadLinkedInUrl(lead) || resolveBasicLinkedInUrl(lead) || lead.linkedinUrl || '',
    firstName: lead.firstName || '',
    lastName: lead.lastName || '',
    fullName: lead.fullName || lead.allFieldsData?.full_name || '',
    email: lead._resolvedEmail || resolveLeadEmail(lead) || '',
    company: lead.company || lead.allFieldsData?.currentCompany || '',
    linkedinUrl: lead.linkedinUrl || '',
  };
}

function resolveLeadIdentity(lead, allowEmailOnly) {
  const url = resolveLeadLinkedInUrl(lead);
  const email = resolveLeadEmail(lead);

  if (url) {
    return { url, email, dedupeKey: url.toLowerCase(), emailOnly: false };
  }
  if (allowEmailOnly && email) {
    return { url: '', email, dedupeKey: `email:${email.toLowerCase()}`, emailOnly: true };
  }
  return null;
}

function recordSkippedLead(summary, campaignName, lead) {
  summary.leadsSkippedNoUrl++;
  summary.skippedLeads.push({
    campaignName,
    firstName: lead.firstName || '',
    lastName: lead.lastName || '',
    fullName: lead.fullName || lead.allFieldsData?.full_name || '',
    email: resolveLeadEmail(lead),
    company: lead.company || lead.allFieldsData?.currentCompany || '',
    occupation: lead.occupation || '',
    linkedinUrl: lead.linkedinUrl || '',
    profileIdentifiers: (lead.profileIdentifiers || []).map(p => p.identifier).join('; '),
  });
}

function recordDuplicateLead(summary, campaignName, lead, profileUrl, stepOrdinal) {
  summary.leadsSkippedDuplicate++;
  summary.duplicateLeads.push({
    campaignName,
    skyleadLeadId: lead.id,
    step: stepOrdinal,
    profileUrl,
    firstName: lead.firstName || '',
    lastName: lead.lastName || '',
    fullName: lead.fullName || lead.allFieldsData?.full_name || '',
    email: lead.personalEmail || lead.businessEmail || lead.allFieldsData?.email || '',
    company: lead.company || lead.allFieldsData?.currentCompany || '',
    occupation: lead.occupation || '',
    linkedinUrl: lead.linkedinUrl || '',
    profileIdentifiers: (lead.profileIdentifiers || []).map(p => p.identifier).join('; '),
  });
}

function recordFinishedLead(summary, campaignName, lead) {
  summary.finishedLeads.push({
    campaignName,
    skyleadLeadId: lead.id,
    nextStep: leadNextStepLabel(lead),
    firstName: lead.firstName || '',
    lastName: lead.lastName || '',
    fullName: lead.fullName || lead.allFieldsData?.full_name || '',
    email: resolveLeadEmail(lead),
    company: lead.company || lead.allFieldsData?.currentCompany || '',
    occupation: lead.occupation || '',
    profileUrl: resolveLeadLinkedInUrl(lead) || resolveBasicLinkedInUrl(lead) || lead.linkedinUrl || '',
    linkedinUrl: lead.linkedinUrl || '',
    profileIdentifiers: (lead.profileIdentifiers || []).map(p => p.identifier).join('; '),
  });
}

const {
  createCampaign,
  updateCampaignConfig,
  createEmailCampaign,
  addSequenceSteps,
  addSequenceStepsNylas,
  addRunnerAccounts,
  startCampaign,
  pauseCampaign,
  createLeadListFromCSV,
  addLeadListToCampaign,
  addLeadsDirectToCampaign,
} = require('./salesrobotClient');

async function runMigration(config, emit) {
  const {
    skyLeadApiKey,
    skyLeadUserId,
    salesrobotApiKey,
    accountMappings,
    selectedCampaignIds,
    includeReplied = true,
    emailAccountUuid = '',
  } = config;

  const summary = {
    campaignsCreated: 0,
    leadsImported: 0,
    leadsSkippedNoUrl: 0,
    leadsSkippedReplied: 0,
    branchesDropped: 0,
    errors: [],
    skippedLeads: [], // leads with no resolvable LinkedIn URL or email (when email allowed)
    duplicateLeads: [], // leads skipped because profile URL already imported
    leadsSkippedDuplicate: 0,
    finishedLeads: [], // leads with nextStep = Finished in Skylead
    prospectsIdentifierType2: 0, // unique prospects having a type-2 (Sales Navigator) identifier
  };

  for (const mapping of accountMappings) {
    const { skyLeadAccountId, salesrobotLinkedinAccountUuid } = mapping;

    emit('log', { message: `Processing seat ${skyLeadAccountId}...` });

    let campaigns;
    try {
      campaigns = await getCampaigns(skyLeadApiKey, skyLeadUserId, skyLeadAccountId);
    } catch (err) {
      const msg = `Failed to fetch campaigns for seat ${skyLeadAccountId}: ${err.message}`;
      emit('error', { message: msg });
      summary.errors.push(msg);
      continue;
    }

    const toMigrate = campaigns.filter(c => selectedCampaignIds.includes(String(c.id)));

    emit('log', { message: `Migrating ${toMigrate.length} campaign(s) from seat ${skyLeadAccountId}` });

    for (const campaign of toMigrate) {
      emit('campaign_start', { name: campaign.name, id: campaign.id });

      const result = await migrateCampaign({
        skyLeadApiKey,
        skyLeadUserId,
        skyLeadAccountId,
        salesrobotApiKey,
        salesrobotLinkedinAccountUuid,
        salesrobotEmailAccountUuid: emailAccountUuid,
        campaign,
        includeReplied,
        summary,
        emit,
      });

      if (result.created) summary.campaignsCreated++;

      if (result.phaseErrors.length > 0) {
        for (const pe of result.phaseErrors) {
          const msg = `Campaign "${campaign.name}" [${pe.phase}]: ${pe.message}`;
          summary.errors.push(msg);
        }
        if (result.aborted) {
          emit('campaign_error', { name: campaign.name, message: result.phaseErrors.map(e => `[${e.phase}] ${e.message}`).join('; ') });
        } else {
          emit('campaign_done', { name: campaign.name });
          emit('log', { message: `Campaign "${campaign.name}" completed with ${result.phaseErrors.length} warning(s)` });
        }
      } else {
        emit('campaign_done', { name: campaign.name });
      }
    }
  }

  return summary;
}

async function migrateCampaign({
  skyLeadApiKey, skyLeadUserId, skyLeadAccountId,
  salesrobotApiKey, salesrobotLinkedinAccountUuid, salesrobotEmailAccountUuid,
  campaign, includeReplied, summary, emit,
}) {
  const result = { created: false, aborted: false, phaseErrors: [] };

  // --- Phase: Fetch campaign details from Skylead ---
  let details;
  try {
    details = await getCampaignDetails(
      skyLeadApiKey, skyLeadUserId, skyLeadAccountId, campaign.id
    );
  } catch (err) {
    result.aborted = true;
    result.phaseErrors.push({ phase: 'fetch-details', message: `Failed to fetch campaign details: ${err.message}` });
    return result;
  }

  const { steps, branchesDropped, branchSteps } = flattenSteps(details.campaignSteps);
  summary.branchesDropped += branchesDropped;

  // Log step summary with Skylead's internal lead counts
  emit('log', { message: `[details] ${steps.length} main step(s), ${branchesDropped} branch edge(s) dropped, ${branchSteps.length} branch step(s)` });
  let skyLeadTotalInSteps = 0;
  for (const s of steps) {
    const leadsInStep = s.numberOfLeadsInStep ?? s.leadCount ?? '?';
    if (typeof leadsInStep === 'number') skyLeadTotalInSteps += leadsInStep;
  }

  if (steps.length === 0) {
    emit('log', { message: `"${campaign.name}" has no steps — creating empty campaign` });
  }

  // --- All campaigns are created as HYBRID ---
  const hasEmailAccount = !!salesrobotEmailAccountUuid;
  const hasEmailSteps = steps.some(s => (s.action || '').toLowerCase() === 'email');

  if (hasEmailSteps && !hasEmailAccount) {
    result.aborted = true;
    result.phaseErrors.push({ phase: 'pre-check', message: 'Campaign has email steps but no Salesrobot email account is mapped. Please map an email account and retry.' });
    return result;
  }

  emit('log', { message: `[create] Creating campaign "${campaign.name}" in Salesrobot...` });
  let emailThreadGroupId = null;
  let isFirstEmailStep = true;

  const sequenceStepDTOList = steps.map((s, idx) => {
    const stepType = mapStepType(s.action);
    const isEmailStep = stepType === 'SEND_EMAIL';

    const rawBody = s.data?.message || '';
    const dto = {
      stepOrdinal: idx, // Salesrobot step ordinals are 0-based
      sequenceStepType: stepType,
      hoursDelay: idx === 0 ? 0 : Math.round((s.doAfterPreviousStep || 0) / 3_600_000),
      multiVariateMails: [{
        body: isEmailStep ? htmlToPlainText(rawBody) : rawBody,
        ...(s.data?.subject ? { subject: s.data.subject } : {}),
      }],
      stepChannel: isEmailStep && hasEmailAccount ? 'EMAIL' : 'LINKEDIN',
    };

    if (isEmailStep && hasEmailAccount) {
      if (!emailThreadGroupId) emailThreadGroupId = randomUUID();
      dto.emailThreadMode = isFirstEmailStep ? 'NEW' : 'CONTINUE';
      dto.emailThreadGroupId = emailThreadGroupId;
      isFirstEmailStep = false;
      if (!dto.multiVariateMails[0].subject) {
        dto.multiVariateMails[0].subject = campaign.name;
      }
    }

    return dto;
  });

  // --- Phase: Create campaign in Salesrobot ---
  let srCampaignUuid;
  try {
    srCampaignUuid = await createCampaign(
      salesrobotApiKey, salesrobotLinkedinAccountUuid, campaign.name, 'HYBRID'
    );
    result.created = true;
    emit('log', { message: `[create] Campaign created: ${srCampaignUuid}` });
  } catch (err) {
    result.aborted = true;
    result.phaseErrors.push({ phase: 'create-campaign', message: `Failed to create campaign in Salesrobot: ${err.message}` });
    return result;
  }

  // --- Phase: Set campaign config (acceptedConnectionLevels = 1st,2nd,3rd) ---
  try {
    await updateCampaignConfig(
      salesrobotApiKey, salesrobotLinkedinAccountUuid, srCampaignUuid, campaign.name
    );
  } catch (err) {
    result.phaseErrors.push({ phase: 'update-config', message: `Failed to update campaign config: ${err.message}` });
    emit('log', { message: `[config] WARNING: Failed to update campaign config — ${err.message}. Continuing...` });
  }

  // --- Phase: Link email account ---
  if (hasEmailAccount) {
    try {
      await addRunnerAccounts(salesrobotApiKey, srCampaignUuid, [salesrobotEmailAccountUuid], []);
    } catch (err) {
      result.phaseErrors.push({ phase: 'link-email', message: `Failed to link email account: ${err.message}` });
      emit('log', { message: `[link-email] WARNING: Failed to link email account — ${err.message}. Email steps may not execute.` });
    }
  }

  // --- Phase: Add sequence steps ---
  if (sequenceStepDTOList.length > 0) {
    try {
      await addSequenceSteps(salesrobotApiKey, salesrobotLinkedinAccountUuid, srCampaignUuid, sequenceStepDTOList);
    } catch (err) {
      result.phaseErrors.push({ phase: 'add-steps', message: `Failed to add sequence steps: ${err.message}` });
      emit('log', { message: `[steps] WARNING: Failed to add steps — ${err.message}. Continuing...` });
    }
  }

  // --- Phase: Fetch leads per step from Skylead using filterByCurrentStep ---
  const allowEmailOnly = hasEmailAccount && hasEmailSteps;

  const seenKeys = new Set();
  const leadsByOrdinal = new Map();

  function processLead(lead, stepOrdinal) {
    const identity = resolveLeadIdentity(lead, allowEmailOnly);
    if (!identity) {
      recordSkippedLead(summary, campaign.name, lead);
      return 'noIdentity';
    }

    if (!includeReplied && lead.leadStatusId === 4) {
      summary.leadsSkippedReplied++;
      return 'replied';
    }

    if (seenKeys.has(identity.dedupeKey)) {
      recordDuplicateLead(
        summary,
        campaign.name,
        lead,
        identity.url || identity.email,
        stepOrdinal
      );
      return 'dupe';
    }

    seenKeys.add(identity.dedupeKey);

    if ((lead.profileIdentifiers || []).some(p => p.identityTypeId === 2)) {
      summary.prospectsIdentifierType2++;
    }

    return buildPauseLeadRecord(lead, identity);
  }

  // Skylead and Salesrobot share the same step semantics, and Salesrobot ordinals
  // are 0-based (step idx in the sequence) while we iterate steps 0..n-1:
  //   - In Skylead, a lead "at step N" has ALREADY executed step N.
  //   - In Salesrobot, a lead "at step N" has ALREADY executed step N.
  // So a lead returned by filterByCurrentStep for the idx-th Skylead step (which it
  // completed) maps directly to the same 0-based Salesrobot step ordinal idx.
  for (const [idx, step] of steps.entries()) {
    const skyleadStep = idx + 1; // human-readable Skylead step number (for logs)
    const targetOrdinal = idx;

    let leads;
    try {
      leads = await getLeadsForStep(
        skyLeadApiKey, skyLeadUserId, skyLeadAccountId, campaign.id, step.id
      );
    } catch (err) {
      result.phaseErrors.push({ phase: `fetch-leads-step-${skyleadStep}`, message: `Failed to fetch leads for step ${skyleadStep}: ${err.message}` });
      emit('log', { message: `[leads]   WARNING: Failed to fetch leads for step ${skyleadStep} — ${err.message}. Skipping step.` });
      continue;
    }

    let noIdentity = 0;
    let replied = 0;
    let dupes = 0;
    const valid = [];

    for (const lead of leads) {
      const result = processLead(lead, targetOrdinal);
      if (result === 'noIdentity') {
        noIdentity++;
        continue;
      }
      if (result === 'replied') {
        replied++;
        continue;
      }
      if (result === 'dupe') {
        dupes++;
        continue;
      }
      valid.push(result);
    }

    if (valid.length > 0) {
      // Merge into the target bucket (branch steps below may target the same
      // ordinal), so don't overwrite an existing bucket.
      if (!leadsByOrdinal.has(targetOrdinal)) {
        leadsByOrdinal.set(targetOrdinal, { step: steps[targetOrdinal], valid: [] });
      }
      leadsByOrdinal.get(targetOrdinal).valid.push(...valid);
    }
  }

  // --- Also fetch leads from branch steps (conditional paths) ---
  // These leads already completed the parent step (it executed but got a non-SUCCESS
  // result like FAILURE/NO_REPLY). Since "at step N" means "has executed N" in both
  // tools, they map directly to the parent's own 0-based Salesrobot ordinal so the
  // sequence continues from the next step.
  const stepIdToOrdinal = new Map();
  for (const [idx, step] of steps.entries()) {
    stepIdToOrdinal.set(step.id, idx); // 0-based Salesrobot ordinal
  }

  if (branchSteps.length > 0) {
    for (const { branchStepId, parentStepId } of branchSteps) {
      const parentOrdinal = stepIdToOrdinal.get(parentStepId) || 0;
      const targetOrdinal = parentOrdinal;

      let leads;
      try {
        leads = await getLeadsForStep(
          skyLeadApiKey, skyLeadUserId, skyLeadAccountId, campaign.id, branchStepId
        );
      } catch (err) {
        result.phaseErrors.push({ phase: `fetch-leads-branch-${branchStepId}`, message: `Failed to fetch leads for branch step ${branchStepId}: ${err.message}` });
        emit('log', { message: `[leads]   WARNING: Failed to fetch branch step ${branchStepId} — ${err.message}. Skipping.` });
        continue;
      }

      let noIdentity = 0;
      let replied = 0;
      let dupes = 0;
      const valid = [];

      for (const lead of leads) {
        const result = processLead(lead, targetOrdinal);
        if (result === 'noIdentity') {
          noIdentity++;
          continue;
        }
        if (result === 'replied') {
          replied++;
          continue;
        }
        if (result === 'dupe') {
          dupes++;
          continue;
        }
        valid.push(result);
      }

      if (valid.length > 0) {
        if (!leadsByOrdinal.has(targetOrdinal)) {
          leadsByOrdinal.set(targetOrdinal, { step: steps[targetOrdinal], valid: [] });
        }
        leadsByOrdinal.get(targetOrdinal).valid.push(...valid);
      }
    }
  }

  // --- Fetch finished leads (nextStep = Finished) ---
  // Finished leads are NOT returned by filterByCurrentStep for any campaign step id.
  emit('log', { message: '[leads] Fetching finished leads (nextStep = Finished)...' });
  let allCampaignLeads = [];
  try {
    allCampaignLeads = await getCampaignLeads(
      skyLeadApiKey, skyLeadUserId, skyLeadAccountId, campaign.id
    );
  } catch (err) {
    result.phaseErrors.push({ phase: 'fetch-finished-leads', message: `Failed to fetch all campaign leads: ${err.message}` });
    emit('log', { message: `[leads]   WARNING: Failed to fetch all campaign leads — ${err.message}` });
  }

  const finishedLeads = allCampaignLeads.filter(isLeadFinished);
  for (const lead of finishedLeads) {
    recordFinishedLead(summary, campaign.name, lead);
  }
  emit('log', { message: `[leads]   ${finishedLeads.length} finished lead(s) of ${allCampaignLeads.length} total in campaign` });

  const lastOrdinal = Math.max(0, steps.length - 1);
  let finishedImported = 0;
  let finishedDupes = 0;
  for (const lead of finishedLeads) {
    const identity = resolveLeadIdentity(lead, allowEmailOnly);
    if (!identity) {
      recordSkippedLead(summary, campaign.name, lead);
      continue;
    }
    if (!includeReplied && lead.leadStatusId === 4) {
      summary.leadsSkippedReplied++;
      continue;
    }

    if (seenKeys.has(identity.dedupeKey)) {
      finishedDupes++;
      continue;
    }

    seenKeys.add(identity.dedupeKey);
    const processed = buildPauseLeadRecord(lead, identity);
    if (!leadsByOrdinal.has(lastOrdinal)) {
      leadsByOrdinal.set(lastOrdinal, { step: steps[lastOrdinal], valid: [] });
    }
    leadsByOrdinal.get(lastOrdinal).valid.push(processed);
    finishedImported++;
  }
  emit('log', { message: `[leads]   Finished: ${finishedImported} new import(s) at step ${lastOrdinal}, ${finishedDupes} already imported (skipped duplicate)` });

  const totalValid = [...leadsByOrdinal.values()].reduce((sum, e) => sum + e.valid.length, 0);
  const emailOnlyCount = [...leadsByOrdinal.values()].reduce(
    (sum, e) => sum + e.valid.filter(l => l._emailOnly).length,
    0
  );
  emit('log', { message: `[leads] Total: ${totalValid} unique valid lead(s) across ${leadsByOrdinal.size} step(s) (${emailOnlyCount} email-only)` });
  if (skyLeadTotalInSteps > totalValid) {
    emit('log', { message: `[leads] ⚠ Gap: ${skyLeadTotalInSteps - totalValid} leads in Skylead step counts but not in migration (likely URL duplicates across steps or inactive leads not returned by API)` });
  }

  // --- Phase: Seed one lead ---
  const seedEntry = leadsByOrdinal.get(0)
    || [...leadsByOrdinal.values()][0];

  if (seedEntry) {
    const seedLead = seedEntry.valid.slice(0, 1);
    emit('log', { message: `[seed] Seeding 1 lead to enable start...` });
    try {
      await addLeadsDirectToCampaign(
        salesrobotApiKey, salesrobotLinkedinAccountUuid, srCampaignUuid, seedLead
      );
      await sleep(3000);
    } catch (err) {
      result.phaseErrors.push({ phase: 'seed-lead', message: `Failed to seed lead: ${err.message}` });
      emit('log', { message: `[seed] WARNING: Failed to seed lead — ${err.message}. Start may fail.` });
    }
  } else {
    emit('log', { message: `[seed] No valid leads found in any step — attempting start anyway.` });
  }

  // --- Phase: Start campaign ---
  const hasInviteMessage = sequenceStepDTOList.some(
    s => s.sequenceStepType === 'SEND_CONNECTION_REQUEST' && s.multiVariateMails?.[0]?.body?.trim()
  );

  emit('log', { message: `[start] Starting campaign...` });

  let startSucceeded = false;

  async function startWithRetry(maxAttempts = 10) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const t0 = Date.now();
      try {
        await startCampaign(salesrobotApiKey, srCampaignUuid, salesrobotLinkedinAccountUuid, hasInviteMessage);
        return true;
      } catch (err) {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        const status = err.response?.status;
        const isTimeout = err.code === 'ECONNABORTED' || err.message?.includes('timeout');
        const isRetryable = status === 504 || status === 502 || status === 503 || status === 429 || isTimeout;
        const reason = isTimeout ? 'timeout' : `HTTP ${status}`;

        if (isRetryable && attempt < maxAttempts) {
          const backoff = Math.min(10_000 * attempt, 60_000);
          emit('log', { message: `[start] Attempt ${attempt} failed (${reason}, ${elapsed}s) — retrying in ${backoff / 1000}s...` });
          await sleep(backoff);
        } else {
          emit('log', { message: `[start] Failed after ${attempt} attempt(s) (${reason}): ${err.message}` });
          throw err;
        }
      }
    }
  }

  try {
    await startWithRetry();
    startSucceeded = true;
  } catch (err) {
    result.phaseErrors.push({ phase: 'start-campaign', message: `Failed to start campaign after retries: ${err.message}` });
    emit('log', { message: `[start] WARNING: Could not start campaign — ${err.message}. Will still attempt lead import.` });
  }

  // --- Phase: Pause campaign ---
  if (startSucceeded) {
    try {
      await pauseCampaign(salesrobotApiKey, srCampaignUuid, salesrobotLinkedinAccountUuid);
      await sleep(2000);
    } catch (err) {
      result.phaseErrors.push({ phase: 'pause-campaign', message: `Failed to pause campaign: ${err.message}` });
      emit('log', { message: `[pause] WARNING: Failed to pause — ${err.message}. Campaign may still be running!` });
    }
  }

  // --- Phase: Import leads via lead lists ---
  // leadsByOrdinal keys are 0-based step ordinals (matching the sequence DTO
  // stepOrdinal), and Salesrobot's startingStepOrdinal uses that same index — so
  // pass it through unchanged. For 0th-step prospects, omit it entirely (the API
  // requires >= 1, and omitting it lands them at step 0).
  for (const [stepOrdinal, { step, valid }] of leadsByOrdinal) {
    const startingStepOrdinal = stepOrdinal === 0 ? undefined : stepOrdinal;

    try {
      const leadListName = `${campaign.name} - Step ${stepOrdinal}`;
      const leadListUuid = await createLeadListFromCSV(salesrobotApiKey, leadListName, valid);

      await addLeadListToCampaign(salesrobotApiKey, srCampaignUuid, leadListUuid, startingStepOrdinal);

      summary.leadsImported += valid.length;
      emit('leads_imported', { count: valid.length, step: stepOrdinal, campaignName: campaign.name });
    } catch (err) {
      result.phaseErrors.push({ phase: `import-step-${stepOrdinal}`, message: `Failed to import ${valid.length} lead(s) at step ${stepOrdinal}: ${err.message}` });
      emit('log', { message: `[import] WARNING: Failed to import leads at step ${stepOrdinal} — ${err.message}. Skipping.` });
    }
  }

  return result;
}

module.exports = {
  runMigration,
  resolveLeadLinkedInUrl,
  resolveBasicLinkedInUrl,
  resolveLeadEmail,
  isLeadFinished,
  leadNextStepLabel,
  buildPauseLeadRecord,
  addLeadToPauseRegistry,
  findLeadInPauseRegistry,
  leadPauseDedupeKey,
  isProspectStoppedInSalesrobot,
  buildQueuedNotPausedProspectRow,
  pauseAndVerify,
};
