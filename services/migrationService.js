const { randomUUID } = require('crypto');
const {
  getCampaigns,
  getCampaignDetails,
  getLeadsForStep,
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

const {
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
  emit('log', { message: `[details] Fetching details for "${campaign.name}"...` });

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

  // Log the full step tree with Skylead's internal lead counts
  emit('log', { message: `[details] ${steps.length} main step(s), ${branchesDropped} branch edge(s) dropped, ${branchSteps.length} branch step(s)` });
  let skyLeadTotalInSteps = 0;
  for (const s of steps) {
    const leadsInStep = s.numberOfLeadsInStep ?? s.leadCount ?? '?';
    if (typeof leadsInStep === 'number') skyLeadTotalInSteps += leadsInStep;
    const conditions = s.conditions ? JSON.stringify(s.conditions) : '';
    emit('log', { message: `[details]   step ${s.step} (id=${s.id}) action=${s.action} leadsInStep=${leadsInStep}${conditions ? ` conditions=${conditions}` : ''}` });
  }
  emit('log', { message: `[details] Sum of numberOfLeadsInStep across all steps: ${skyLeadTotalInSteps}` });

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

  emit('log', { message: `[family] Creating as HYBRID campaign (hasEmailSteps=${hasEmailSteps}, hasEmailAccount=${hasEmailAccount})` });

  // --- Build sequence step DTOs ---
  let emailThreadGroupId = null;
  let isFirstEmailStep = true;

  const sequenceStepDTOList = steps.map((s, idx) => {
    const stepType = mapStepType(s.action);
    const isEmailStep = stepType === 'SEND_EMAIL';

    const rawBody = s.data?.message || '';
    const dto = {
      stepOrdinal: idx + 1,
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
  emit('log', { message: `[create] Creating HYBRID campaign "${campaign.name}" in Salesrobot...` });

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

  // --- Phase: Link email account ---
  if (hasEmailAccount) {
    emit('log', { message: `[link-email] Linking email account ${salesrobotEmailAccountUuid} to campaign...` });
    try {
      await addRunnerAccounts(salesrobotApiKey, srCampaignUuid, [salesrobotEmailAccountUuid], []);
      emit('log', { message: `[link-email] Email account linked OK` });
    } catch (err) {
      result.phaseErrors.push({ phase: 'link-email', message: `Failed to link email account: ${err.message}` });
      emit('log', { message: `[link-email] WARNING: Failed to link email account — ${err.message}. Email steps may not execute.` });
    }
  }

  // --- Phase: Add sequence steps ---
  if (sequenceStepDTOList.length > 0) {
    emit('log', { message: `[steps] Adding ${sequenceStepDTOList.length} sequence step(s)...` });
    emit('log', { message: `[steps] Payload: ${JSON.stringify(sequenceStepDTOList)}` });
    try {
      await addSequenceSteps(salesrobotApiKey, salesrobotLinkedinAccountUuid, srCampaignUuid, sequenceStepDTOList);
      emit('log', { message: `[steps] Sequence steps saved OK` });
    } catch (err) {
      result.phaseErrors.push({ phase: 'add-steps', message: `Failed to add sequence steps: ${err.message}` });
      emit('log', { message: `[steps] WARNING: Failed to add steps — ${err.message}. Continuing...` });
    }
  }

  // --- Phase: Fetch leads per step from Skylead using filterByCurrentStep ---
  emit('log', { message: `[leads] Fetching leads for ${steps.length} step(s)...` });

  const allowEmailOnly = hasEmailAccount && hasEmailSteps;
  if (allowEmailOnly) {
    emit('log', { message: `[leads] Email account mapped — email-only leads allowed (no LinkedIn URL required)` });
  }

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
    return {
      ...lead,
      _resolvedUrl: identity.url,
      _resolvedEmail: identity.email,
      _emailOnly: identity.emailOnly,
    };
  }

  for (const [idx, step] of steps.entries()) {
    const stepOrdinal = idx + 1;
    emit('log', { message: `[leads]   Fetching leads at step ${stepOrdinal} (Skylead step ID ${step.id})...` });

    let leads;
    try {
      leads = await getLeadsForStep(
        skyLeadApiKey, skyLeadUserId, skyLeadAccountId, campaign.id, step.id
      );
    } catch (err) {
      result.phaseErrors.push({ phase: `fetch-leads-step-${stepOrdinal}`, message: `Failed to fetch leads for step ${stepOrdinal}: ${err.message}` });
      emit('log', { message: `[leads]   WARNING: Failed to fetch leads for step ${stepOrdinal} — ${err.message}. Skipping step.` });
      continue;
    }

    emit('log', { message: `[leads]   Step ${stepOrdinal}: fetched ${leads.length} lead(s) from API` });

    // Log sample lead on first step for debugging
    if (idx === 0 && leads.length > 0) {
      const sample = leads[0];
      emit('log', { message: `[leads]   [debug] sample lead keys: ${Object.keys(sample).join(', ')}` });
      emit('log', { message: `[leads]   [debug] sample linkedinUrl="${sample.linkedinUrl}"` });
      emit('log', { message: `[leads]   [debug] sample profileIdentifiers=${JSON.stringify((sample.profileIdentifiers || []).slice(0, 3))}` });
    }

    let noIdentity = 0;
    let replied = 0;
    let dupes = 0;
    const valid = [];

    for (const lead of leads) {
      const result = processLead(lead, stepOrdinal);
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

    emit('log', { message: `[leads]   Step ${stepOrdinal}: ${valid.length} valid, ${noIdentity} no identity, ${replied} replied skipped, ${dupes} duplicate(s)` });
    if (valid.length > 0) {
      const sample = valid[0];
      const sampleId = sample._emailOnly
        ? `email=${sample._resolvedEmail}`
        : `profileUrl=${sample._resolvedUrl}`;
      emit('log', { message: `[leads]   [debug] sample ${sampleId}` });
      leadsByOrdinal.set(stepOrdinal, { step, valid });
    }
  }

  // --- Also fetch leads from branch steps (conditional paths) ---
  // These leads already completed the parent step (it executed but got a non-SUCCESS
  // result like FAILURE/NO_REPLY). Place them at parentOrdinal + 1 so they skip the
  // already-executed step and continue from the next one in the linear sequence.
  // If parentOrdinal is the last step, cap at the last step.
  const stepIdToOrdinal = new Map();
  for (const [idx, step] of steps.entries()) {
    stepIdToOrdinal.set(step.id, idx + 1);
  }

  if (branchSteps.length > 0) {
    emit('log', { message: `[leads] Fetching leads from ${branchSteps.length} branch step(s)...` });

    for (const { branchStepId, parentStepId } of branchSteps) {
      const parentOrdinal = stepIdToOrdinal.get(parentStepId) || 1;
      const targetOrdinal = Math.min(parentOrdinal + 1, steps.length);
      emit('log', { message: `[leads]   Fetching leads at branch step ${branchStepId} (parent step ${parentOrdinal} → placing at step ${targetOrdinal})...` });

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

      emit('log', { message: `[leads]   Branch ${branchStepId} → step ${targetOrdinal}: fetched ${leads.length}, ${valid.length} valid (new), ${noIdentity} no identity, ${dupes} duplicate(s)` });

      if (valid.length > 0) {
        if (!leadsByOrdinal.has(targetOrdinal)) {
          leadsByOrdinal.set(targetOrdinal, { step: steps[targetOrdinal - 1], valid: [] });
        }
        leadsByOrdinal.get(targetOrdinal).valid.push(...valid);
      }
    }
  }

  const totalValid = [...leadsByOrdinal.values()].reduce((sum, e) => sum + e.valid.length, 0);
  const emailOnlyCount = [...leadsByOrdinal.values()].reduce(
    (sum, e) => sum + e.valid.filter(l => l._emailOnly).length,
    0
  );
  emit('log', { message: `[leads] Total: ${totalValid} unique valid lead(s) across ${leadsByOrdinal.size} step(s) (${emailOnlyCount} email-only)` });
  emit('log', { message: `[leads] Skylead numberOfLeadsInStep sum: ${skyLeadTotalInSteps}, unique identities seen: ${seenKeys.size}, skipped no-identity: ${summary.leadsSkippedNoUrl}, skipped replied: ${summary.leadsSkippedReplied}` });
  if (skyLeadTotalInSteps > totalValid) {
    emit('log', { message: `[leads] ⚠ Gap: ${skyLeadTotalInSteps - totalValid} leads in Skylead step counts but not in migration (likely URL duplicates across steps or inactive leads not returned by API)` });
  }

  // --- Phase: Seed one lead ---
  const seedEntry = leadsByOrdinal.get(1)
    || [...leadsByOrdinal.values()][0];

  if (seedEntry) {
    const seedLead = seedEntry.valid.slice(0, 1);
    emit('log', { message: `[seed] Seeding 1 lead to enable start (from step ${seedEntry.step.step})...` });
    try {
      await addLeadsDirectToCampaign(
        salesrobotApiKey, salesrobotLinkedinAccountUuid, srCampaignUuid, seedLead
      );
      await sleep(3000);
      emit('log', { message: `[seed] Seed complete.` });
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

  emit('log', { message: `[start] Preparing to start campaign ${srCampaignUuid}` });
  emit('log', { message: `[start] linkedinAccount=${salesrobotLinkedinAccountUuid}, hasInviteMessage=${hasInviteMessage}, steps=${sequenceStepDTOList.length}` });

  let startSucceeded = false;

  async function startWithRetry(maxAttempts = 10) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const t0 = Date.now();
      try {
        emit('log', { message: `[start] Attempt ${attempt}/${maxAttempts} — calling POST /start...` });
        await startCampaign(salesrobotApiKey, srCampaignUuid, salesrobotLinkedinAccountUuid, hasInviteMessage);
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        emit('log', { message: `[start] Success on attempt ${attempt} (${elapsed}s)` });
        return true;
      } catch (err) {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        const status = err.response?.status;
        const isTimeout = err.code === 'ECONNABORTED' || err.message?.includes('timeout');
        const isRetryable = status === 504 || status === 502 || status === 503 || status === 429 || isTimeout;
        const reason = isTimeout ? 'timeout' : `HTTP ${status}`;
        const body = err.response?.data
          ? (typeof err.response.data === 'string' ? err.response.data : JSON.stringify(err.response.data))
          : '(no body)';

        emit('log', { message: `[start] Attempt ${attempt} failed after ${elapsed}s — ${reason}` });
        emit('log', { message: `[start] Response body: ${body}` });
        emit('log', { message: `[start] Error: ${err.message}` });

        if (isRetryable && attempt < maxAttempts) {
          const backoff = Math.min(10_000 * attempt, 60_000);
          emit('log', { message: `[start] Retryable — waiting ${backoff / 1000}s before attempt ${attempt + 1}...` });
          await sleep(backoff);
        } else {
          emit('log', { message: `[start] Not retryable or max attempts reached — giving up` });
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
    emit('log', { message: `[pause] Pausing campaign...` });
    try {
      await pauseCampaign(salesrobotApiKey, srCampaignUuid, salesrobotLinkedinAccountUuid);
      await sleep(2000);
      emit('log', { message: `[pause] Campaign paused OK` });
    } catch (err) {
      result.phaseErrors.push({ phase: 'pause-campaign', message: `Failed to pause campaign: ${err.message}` });
      emit('log', { message: `[pause] WARNING: Failed to pause — ${err.message}. Campaign may still be running!` });
    }
  }

  // --- Phase: Import leads via lead lists ---
  for (const [stepOrdinal, { step, valid }] of leadsByOrdinal) {
    emit('log', { message: `[import] Importing ${valid.length} lead(s) at step ${stepOrdinal} via lead list...` });

    try {
      const leadListName = `${campaign.name} - Step ${stepOrdinal}`;
      const leadListUuid = await createLeadListFromCSV(salesrobotApiKey, leadListName, valid);
      emit('log', { message: `[import] Lead list created: ${leadListUuid}` });

      await addLeadListToCampaign(salesrobotApiKey, srCampaignUuid, leadListUuid, stepOrdinal);
      emit('log', { message: `[import] Lead list attached at step ${stepOrdinal} OK` });

      summary.leadsImported += valid.length;
      emit('leads_imported', { count: valid.length, step: stepOrdinal, campaignName: campaign.name });
    } catch (err) {
      result.phaseErrors.push({ phase: `import-step-${stepOrdinal}`, message: `Failed to import ${valid.length} lead(s) at step ${stepOrdinal}: ${err.message}` });
      emit('log', { message: `[import] WARNING: Failed to import leads at step ${stepOrdinal} — ${err.message}. Skipping.` });
    }
  }

  return result;
}

module.exports = { runMigration };
