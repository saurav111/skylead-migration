const {
  getCampaigns,
  getCampaignDetails,
  getLeadsForStep,
  flattenSteps,
  mapStepType,
} = require('./skyleadClient');

const {
  createCampaign,
  addSequenceSteps,
  startCampaign,
  pauseCampaign,
  createLeadListFromCSV,
  addLeadListToCampaign,
} = require('./salesrobotClient');

async function runMigration(config, emit) {
  const {
    skyLeadApiKey,
    skyLeadUserId,
    salesrobotApiKey,
    accountMappings,
    selectedCampaignIds,
  } = config;

  const summary = {
    campaignsCreated: 0,
    leadsImported: 0,
    leadsSkippedNoUrl: 0,
    leadsSkippedReplied: 0,
    branchesDropped: 0,
    errors: [],
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
  campaign, summary, emit,
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
  const sequenceStepDTOList = steps.map((s, idx) => ({
    stepOrdinal: idx + 1,
    sequenceStepType: mapStepType(s.action),
    hoursDelay: idx === 0 ? 0 : Math.round((s.doAfterPreviousStep || 0) / 3_600_000),
    multiVariateMails: [
      {
        body: s.data?.message || '',
        ...(s.data?.subject ? { subject: s.data.subject } : {}),
      },
    ],
  }));

  emit('log', { message: `Creating campaign "${campaign.name}" in Salesrobot...` });
  const srCampaignUuid = await createCampaign(
    salesrobotApiKey, salesrobotLinkedinAccountUuid, campaign.name
  );

  if (sequenceStepDTOList.length > 0) {
    emit('log', { message: `Adding ${sequenceStepDTOList.length} sequence step(s)...` });
    await addSequenceSteps(salesrobotApiKey, salesrobotLinkedinAccountUuid, srCampaignUuid, sequenceStepDTOList);
  }

  // Must start then immediately pause so startingStepOrdinal works
  await startCampaign(salesrobotApiKey, srCampaignUuid, salesrobotLinkedinAccountUuid);
  await pauseCampaign(salesrobotApiKey, srCampaignUuid, salesrobotLinkedinAccountUuid);

  // Migrate leads per step
  const stepsWithLeads = steps.filter(s => s.numberOfLeadsInStep > 0);
  emit('log', { message: `${stepsWithLeads.length} step(s) have leads to migrate` });

  for (const step of stepsWithLeads) {
    emit('log', { message: `Fetching leads at step ${step.step} (${step.numberOfLeadsInStep} expected)...` });

    const leads = await getLeadsForStep(
      skyLeadApiKey, skyLeadUserId, skyLeadAccountId, campaign.id, step.id
    );

    const noUrl = leads.filter(l => !l.linkedinUrl);
    const replied = leads.filter(l => l.linkedinUrl && l.leadStatusId === 4);
    const valid = leads.filter(l => l.linkedinUrl && l.leadStatusId !== 4);

    summary.leadsSkippedNoUrl += noUrl.length;
    summary.leadsSkippedReplied += replied.length;

    if (valid.length === 0) {
      emit('log', { message: `No importable leads at step ${step.step} (${replied.length} replied, ${noUrl.length} no URL)` });
      continue;
    }

    emit('log', { message: `Importing ${valid.length} lead(s) at step ${step.step}...` });

    const leadListName = `${campaign.name} - Step ${step.step}`;
    const leadListUuid = await createLeadListFromCSV(salesrobotApiKey, leadListName, valid);

    await addLeadListToCampaign(salesrobotApiKey, srCampaignUuid, leadListUuid, step.step);

    summary.leadsImported += valid.length;
    emit('leads_imported', { count: valid.length, step: step.step, campaignName: campaign.name });
  }
}

module.exports = { runMigration };
