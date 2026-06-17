const {
  getCampaigns,
  getCampaignDetails,
  getLeadsForStep,
  flattenSteps,
  mapStepType,
} = require('./skyleadClient');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const {
  createCampaign,
  addSequenceSteps,
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
  } = config;

  const summary = {
    campaignsCreated: 0,
    leadsImported: 0,
    leadsSkippedNoUrl: 0,
    leadsSkippedReplied: 0,
    branchesDropped: 0,
    errors: [],
    skippedLeads: [], // leads with no resolvable LinkedIn URL
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

      try {
        await migrateCampaign({
          skyLeadApiKey,
          skyLeadUserId,
          skyLeadAccountId,
          salesrobotApiKey,
          salesrobotLinkedinAccountUuid,
          campaign,
          includeReplied,
          summary,
          emit,
        });

        summary.campaignsCreated++;
        emit('campaign_done', { name: campaign.name });
      } catch (err) {
        const msg = `Campaign "${campaign.name}" failed: ${err.message}`;
        emit('campaign_error', { name: campaign.name, message: err.message });
        summary.errors.push(msg);
      }
    }
  }

  return summary;
}

async function migrateCampaign({
  skyLeadApiKey, skyLeadUserId, skyLeadAccountId,
  salesrobotApiKey, salesrobotLinkedinAccountUuid,
  campaign, includeReplied, summary, emit,
}) {
  emit('log', { message: `Fetching details for "${campaign.name}"...` });

  const details = await getCampaignDetails(
    skyLeadApiKey, skyLeadUserId, skyLeadAccountId, campaign.id
  );

  const { steps, branchesDropped } = flattenSteps(details.campaignSteps);
  summary.branchesDropped += branchesDropped;

  if (steps.length === 0) {
    emit('log', { message: `"${campaign.name}" has no steps — creating empty campaign` });
  }

  // Build Salesrobot sequence steps
  // All step types require multiVariateMails per the API docs; non-message steps send an empty body
  const sequenceStepDTOList = steps.map((s, idx) => ({
    stepOrdinal: idx + 1,
    sequenceStepType: mapStepType(s.action),
    hoursDelay: idx === 0 ? 0 : Math.round((s.doAfterPreviousStep || 0) / 3_600_000),
    multiVariateMails: [{
      body: s.data?.message || '',
      ...(s.data?.subject ? { subject: s.data.subject } : {}),
    }],
  }));

  emit('log', { message: `Creating campaign "${campaign.name}" in Salesrobot...` });
  const srCampaignUuid = await createCampaign(
    salesrobotApiKey, salesrobotLinkedinAccountUuid, campaign.name
  );
  emit('log', { message: `Campaign created: ${srCampaignUuid}` });

  if (sequenceStepDTOList.length > 0) {
    emit('log', { message: `Adding ${sequenceStepDTOList.length} sequence step(s)...` });
    emit('log', { message: `Steps payload: ${JSON.stringify(sequenceStepDTOList)}` });
    await addSequenceSteps(salesrobotApiKey, salesrobotLinkedinAccountUuid, srCampaignUuid, sequenceStepDTOList);
    emit('log', { message: `Sequence steps saved OK` });
  }

  // --- Phase 1: Fetch leads for all steps from Skylead ---
  // Skylead step objects have no lead-count field, so we fetch every step
  // and skip if the API returns nothing.
  emit('log', { message: `Fetching leads for all ${steps.length} step(s)...` });

  // stepOrdinal (1-based) → { step, valid leads[] }
  const leadsByOrdinal = new Map();

  for (const [idx, step] of steps.entries()) {
    const stepOrdinal = idx + 1;
    emit('log', { message: `  Fetching leads at step ${stepOrdinal} (Skylead step ID ${step.id})...` });

    const leads = await getLeadsForStep(
      skyLeadApiKey, skyLeadUserId, skyLeadAccountId, campaign.id, step.id
    );

    // Resolve the best LinkedIn URL for this lead.
    // identityTypeId values per Skylead docs:
    //   1 = BASIC     → linkedin.com/in/
    //   2 = NAVIGATOR → linkedin.com/sales/people/
    //   3 = RECRUITER
    //   4 = EMAIL, 5 = BUSINESS_EMAIL
    //
    // Prefer NAVIGATOR (id=2) so Sales Nav leads route to the Sales Nav inbox
    // in Salesrobot. Fall back to BASIC (id=1), then the raw linkedinUrl field
    // (which Skylead populates lazily and can be an empty string).
    function resolveUrl(lead) {
      const identifiers = lead.profileIdentifiers || [];

      const navId = identifiers.find(p => p.identityTypeId === 2);
      if (navId?.identifier) {
        return navId.identifier.startsWith('http')
          ? navId.identifier
          : `https://www.linkedin.com/sales/people/${navId.identifier}`;
      }

      const basicId = identifiers.find(p => p.identityTypeId === 1);
      if (basicId?.identifier) {
        return basicId.identifier.startsWith('http')
          ? basicId.identifier
          : `https://www.linkedin.com/in/${basicId.identifier}`;
      }

      return lead.linkedinUrl || '';
    }

    const leadsWithUrl = leads.map(l => ({ ...l, _resolvedUrl: resolveUrl(l) }));
    const noUrl   = leadsWithUrl.filter(l => !l._resolvedUrl);
    const replied = leadsWithUrl.filter(l => l._resolvedUrl && l.leadStatusId === 4);
    const valid   = leadsWithUrl.filter(l => l._resolvedUrl && (l.leadStatusId !== 4 || includeReplied));

    // Log sample of no-URL leads so we can diagnose if the field name ever changes
    if (noUrl.length > 0) {
      const sample = noUrl[0];
      emit('log', { message: `  [debug] no-URL lead sample keys: ${Object.keys(sample).join(', ')}` });
      emit('log', { message: `  [debug] linkedinUrl="${sample.linkedinUrl}" profileIdentifiers=${JSON.stringify(sample.profileIdentifiers?.slice(0,2))}` });
    }

    summary.leadsSkippedNoUrl += noUrl.length;
    if (!includeReplied) summary.leadsSkippedReplied += replied.length;

    // Collect skipped leads with just enough fields for a CSV download
    for (const l of noUrl) {
      summary.skippedLeads.push({
        campaignName: campaign.name,
        firstName: l.firstName || '',
        lastName: l.lastName || '',
        fullName: l.fullName || l.allFieldsData?.full_name || '',
        email: l.personalEmail || l.businessEmail || l.allFieldsData?.email || '',
        company: l.company || l.allFieldsData?.currentCompany || '',
        occupation: l.occupation || '',
        linkedinUrl: l.linkedinUrl || '',
        profileIdentifiers: (l.profileIdentifiers || []).map(p => p.identifier).join('; '),
      });
    }

    emit('log', { message: `  Step ${stepOrdinal}: ${valid.length} valid${includeReplied ? ' (incl. replied)' : ''}, ${replied.length} replied, ${noUrl.length} no URL` });

    if (valid.length > 0) leadsByOrdinal.set(stepOrdinal, { step, valid });
  }

  // --- Phase 2: Seed exactly ONE lead so the campaign can be started ---
  // Salesrobot requires at least one lead to start. Seeding all leads before
  // start caused 504 timeouts on large campaigns — the server was still
  // processing the import when the start request arrived.
  // We seed only 1 lead here; all leads (including this one) are added at the
  // correct step ordinal via leadlists in Phase 4.
  const seedEntry = leadsByOrdinal.get(1)
    || [...leadsByOrdinal.values()][0]; // first available step

  if (seedEntry) {
    const seedLead = seedEntry.valid.slice(0, 1);
    emit('log', { message: `Seeding 1 lead to enable start (from step ${seedEntry.step.step})...` });
    await addLeadsDirectToCampaign(
      salesrobotApiKey, salesrobotLinkedinAccountUuid, srCampaignUuid, seedLead
    );
    await sleep(3000);
    emit('log', { message: `Seed complete.` });
  } else {
    emit('log', { message: `No valid leads found in any step — attempting start anyway.` });
  }

  // --- Phase 3: Start → Pause with retry on 504/5xx ---
  // The /start endpoint can be slow on Salesrobot's side; retry up to 3 times
  // with a 10-second back-off before giving up.
  const hasInviteMessage = sequenceStepDTOList.some(
    s => s.sequenceStepType === 'SEND_CONNECTION_REQUEST' && s.multiVariateMails?.[0]?.body?.trim()
  );

  async function startWithRetry(maxAttempts = 5) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        emit('log', { message: `Starting campaign (attempt ${attempt}/${maxAttempts}, hasInviteMessage=${hasInviteMessage})...` });
        await startCampaign(salesrobotApiKey, srCampaignUuid, salesrobotLinkedinAccountUuid, hasInviteMessage);
        return;
      } catch (err) {
        const status = err.response?.status;
        const isRetryable = status === 504 || status === 502 || status === 503 || status === 429;
        if (isRetryable && attempt < maxAttempts) {
          emit('log', { message: `  Start got HTTP ${status} — waiting 10s then retrying...` });
          await sleep(10000);
        } else {
          throw err;
        }
      }
    }
  }

  await startWithRetry();
  emit('log', { message: `Pausing campaign...` });
  await pauseCampaign(salesrobotApiKey, srCampaignUuid, salesrobotLinkedinAccountUuid);
  await sleep(2000);

  // --- Phase 4: Add all steps via lead lists with startingStepOrdinal ---
  // Includes step 1 if it had leads (Salesrobot will move the seed leads to the
  // correct ordinal when the same profiles appear in the leadlist).
  for (const [stepOrdinal, { step, valid }] of leadsByOrdinal) {

    emit('log', { message: `Importing ${valid.length} lead(s) at step ${stepOrdinal} via lead list...` });

    const leadListName = `${campaign.name} - Step ${stepOrdinal}`;
    const leadListUuid = await createLeadListFromCSV(salesrobotApiKey, leadListName, valid);
    emit('log', { message: `Lead list created: ${leadListUuid}` });

    await addLeadListToCampaign(salesrobotApiKey, srCampaignUuid, leadListUuid, stepOrdinal);
    emit('log', { message: `Lead list attached at step ${stepOrdinal} OK` });

    summary.leadsImported += valid.length;
    emit('leads_imported', { count: valid.length, step: stepOrdinal, campaignName: campaign.name });
  }
}

module.exports = { runMigration };
