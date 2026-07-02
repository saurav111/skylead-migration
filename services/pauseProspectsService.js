const { getCampaigns, getCampaignLeads } = require('./skyleadClient');
const { getCampaignsList, getCampaignProspects, pauseProspects } = require('./salesrobotClient');
const {
  resolveLeadLinkedInUrl,
  resolveLeadEmail,
  isLeadFinished,
  buildPauseLeadRecord,
  addLeadToPauseRegistry,
  findLeadInPauseRegistry,
  leadPauseDedupeKey,
  pauseAndVerify,
  buildQueuedNotPausedProspectRow,
} = require('./migrationService');

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

function srCampaignName(c) {
  return (c.campaignName || c.name || '').trim();
}
function srCampaignUuid(c) {
  return c.campaignUuid || c.uuid || c.campaignUUID || '';
}

// For each mapped seat: scan every campaign's leads, keep the ones paused in Skylead
// (active === false) or finished (nextStep === 'Finished'), then pause the matching
// prospects in every Salesrobot campaign whose name matches the Skylead campaign name.
async function runPauseProspects(config, emit) {
  const { skyLeadApiKey, skyLeadUserId, salesrobotApiKey, accountMappings } = config;

  const summary = {
    accountsProcessed: 0,
    skyleadCampaignsScanned: 0,
    pausedLeadsFound: 0,
    matchedProspects: 0,
    prospectsPaused: 0,
    errors: [],
    pausedProspects: [], // { seat, campaignName, prospectUuid, profileUrl, name, email }
    queuedNotPausedProspects: [],
    campaignsNotFoundInSR: [], // { seat, campaignName }
  };

  for (const mapping of accountMappings) {
    const { skyLeadAccountId, salesrobotLinkedinAccountUuid } = mapping;

    emit('account_start', { seat: skyLeadAccountId });
    emit('log', { message: `Processing seat ${skyLeadAccountId}...` });

    // --- Skylead campaigns for this seat ---
    let campaigns;
    try {
      campaigns = await getCampaigns(skyLeadApiKey, skyLeadUserId, skyLeadAccountId);
    } catch (err) {
      const msg = `Failed to fetch Skylead campaigns for seat ${skyLeadAccountId}: ${describeError(err)}`;
      emit('error', { message: msg });
      summary.errors.push(msg);
      continue;
    }
    emit('log', { message: `Found ${campaigns.length} Skylead campaign(s)` });

    // --- Salesrobot campaigns for this account → name → [uuid] map ---
    let srCampaigns;
    try {
      srCampaigns = await getCampaignsList(salesrobotApiKey, salesrobotLinkedinAccountUuid);
    } catch (err) {
      const msg = `Failed to fetch Salesrobot campaigns for account ${salesrobotLinkedinAccountUuid}: ${describeError(err)}`;
      emit('error', { message: msg });
      summary.errors.push(msg);
      continue;
    }
    emit('log', { message: `Found ${srCampaigns.length} Salesrobot campaign(s) for account ${salesrobotLinkedinAccountUuid}` });

    const srByName = new Map();
    for (const sc of srCampaigns) {
      const name = srCampaignName(sc).toLowerCase();
      const uuid = srCampaignUuid(sc);
      if (!name || !uuid) continue;
      if (!srByName.has(name)) srByName.set(name, []);
      srByName.get(name).push(uuid);
    }

    for (const campaign of campaigns) {
      summary.skyleadCampaignsScanned++;
      emit('campaign_start', { name: campaign.name });

      // --- Leads for this campaign, keep only those paused in Skylead ---
      let leads;
      try {
        leads = await getCampaignLeads(
          skyLeadApiKey, skyLeadUserId, skyLeadAccountId, campaign.id
        );
      } catch (err) {
        const msg = `Failed to fetch leads for campaign "${campaign.name}": ${describeError(err)}`;
        emit('log', { message: `WARNING: ${msg}` });
        summary.errors.push(msg);
        continue;
      }

      // Pause leads that are paused in Skylead (active === false) OR have finished
      // the sequence (nextStep === 'Finished').
      const pausedLeads = leads.filter(l => l.active === false || isLeadFinished(l));
      const finishedCount = pausedLeads.filter(l => isLeadFinished(l)).length;
      emit('log', { message: `"${campaign.name}": ${pausedLeads.length} lead(s) to pause (${finishedCount} finished) of ${leads.length}` });
      const pauseRegistry = new Map();
      const pauseDedupeSeen = new Set();
      const queuedLeadRecords = [];
      for (const lead of pausedLeads) {
        const url = resolveLeadLinkedInUrl(lead);
        const email = resolveLeadEmail(lead);
        const rec = buildPauseLeadRecord(lead, {
          url,
          email,
          emailOnly: !url && !!email,
        });
        rec._displayName = leadFullName(lead);
        const dedupeKey = leadPauseDedupeKey(rec);
        if (!dedupeKey || pauseDedupeSeen.has(dedupeKey)) continue;
        pauseDedupeSeen.add(dedupeKey);
        queuedLeadRecords.push(rec);
        addLeadToPauseRegistry(pauseRegistry, rec);
      }
      const leadsQueuedForPause = pauseDedupeSeen.size;
      if (leadsQueuedForPause === 0) continue;
      summary.pausedLeadsFound += leadsQueuedForPause;

      // --- Salesrobot campaigns with the same name ---
      const targetUuids = srByName.get((campaign.name || '').trim().toLowerCase()) || [];
      if (targetUuids.length === 0) {
        summary.campaignsNotFoundInSR.push({ seat: skyLeadAccountId, campaignName: campaign.name });
        for (const lead of queuedLeadRecords) {
          summary.queuedNotPausedProspects.push({
            seat: skyLeadAccountId,
            ...buildQueuedNotPausedProspectRow(campaign.name, lead, { reason: 'no_salesrobot_campaign' }),
          });
        }
        emit('log', { message: `  ⚠ No Salesrobot campaign named "${campaign.name}" — skipping` });
        continue;
      }
      emit('log', { message: `  ${targetUuids.length} matching Salesrobot campaign(s) named "${campaign.name}"` });

      const allMatchedDedupeKeys = new Set();
      for (const campaignUuid of targetUuids) {
        let prospects;
        try {
          prospects = await getCampaignProspects(salesrobotApiKey, campaignUuid, salesrobotLinkedinAccountUuid);
        } catch (err) {
          const msg = `Failed to fetch prospects for Salesrobot campaign ${campaignUuid} ("${campaign.name}"): ${describeError(err)}`;
          emit('log', { message: `  WARNING: ${msg}` });
          summary.errors.push(msg);
          continue;
        }

        const matchedByUuid = new Map();
        for (const p of prospects) {
          const uuid = p.prospectUuid || p.uuid;
          if (!uuid || matchedByUuid.has(uuid)) continue;
          const lead = findLeadInPauseRegistry(pauseRegistry, p);
          if (lead) {
            matchedByUuid.set(uuid, {
              uuid,
              profileUrl: p.profileUrl || p.linkedinUrl || '',
              lead,
            });
          }
        }

        const matched = [...matchedByUuid.values()];
        summary.matchedProspects += matched.length;
        for (const { lead } of matched) {
          const key = leadPauseDedupeKey(lead);
          if (key) allMatchedDedupeKeys.add(key);
        }
        emit('log', { message: `  Matched ${matched.length} unique prospect(s) in Salesrobot campaign ${campaignUuid}` });

        const { verifiedByUuid, remaining, finalProspectMap } = await pauseAndVerify({
          matchedByUuid,
          pauseFn: (uuids) => pauseProspects(
            salesrobotApiKey, salesrobotLinkedinAccountUuid, campaignUuid, uuids
          ),
          fetchFn: () => getCampaignProspects(
            salesrobotApiKey, campaignUuid, salesrobotLinkedinAccountUuid
          ),
          emit,
          logPrefix: '  [pause-prospects]',
          onBatchError: (err, batch) => {
            const msg = `Failed to pause a batch in Salesrobot campaign ${campaignUuid} ("${campaign.name}"): ${describeError(err)}`;
            emit('log', { message: `  WARNING: ${msg}` });
            summary.errors.push(msg);
          },
        });

        let verifiedPaused = 0;
        for (const [uuid, prospect] of verifiedByUuid) {
          const { lead, profileUrl } = matchedByUuid.get(uuid);
          summary.prospectsPaused++;
          verifiedPaused++;
          summary.pausedProspects.push({
            seat: skyLeadAccountId,
            campaignName: campaign.name,
            prospectUuid: uuid,
            profileUrl: prospect.profileUrl || prospect.linkedinUrl || profileUrl,
            name: lead._displayName || leadFullName(lead),
            email: lead._resolvedEmail || resolveLeadEmail(lead),
          });
        }
        emit('log', { message: `  Verified ${verifiedPaused}/${matched.length} prospect(s) paused in Salesrobot` });

        for (const uuid of remaining) {
          const { lead } = matchedByUuid.get(uuid);
          summary.queuedNotPausedProspects.push({
            seat: skyLeadAccountId,
            ...buildQueuedNotPausedProspectRow(campaign.name, lead, {
              reason: 'pause_failed',
              prospect: finalProspectMap.get(uuid),
              prospectUuid: uuid,
            }),
          });
        }

        if (remaining.size > 0) {
          emit('log', { message: `  ⚠ ${remaining.size} matched prospect(s) are still not in a paused/terminal status` });
        }
      }

      for (const lead of queuedLeadRecords) {
        const key = leadPauseDedupeKey(lead);
        if (!key || allMatchedDedupeKeys.has(key)) continue;
        summary.queuedNotPausedProspects.push({
          seat: skyLeadAccountId,
          ...buildQueuedNotPausedProspectRow(campaign.name, lead, { reason: 'no_prospect_match' }),
        });
      }

      emit('campaign_done', { name: campaign.name });
    }

    summary.accountsProcessed++;
    emit('account_done', { seat: skyLeadAccountId });
  }

  return summary;
}

module.exports = { runPauseProspects };
