const { getCampaigns, getCampaignLeads } = require('./skyleadClient');
const { getCampaignsList, getCampaignProspects, pauseProspects } = require('./salesrobotClient');
const { resolveBasicLinkedInUrl, resolveLeadEmail, linkedInMatchKey } = require('./migrationService');

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
// (active === false), then pause the matching prospects in every Salesrobot campaign
// whose name matches the Skylead campaign name.
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
    campaignsNotFoundInSR: [], // { seat, campaignName }
  };

  const BATCH_SIZE = 100;

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
          skyLeadApiKey, skyLeadUserId, skyLeadAccountId, campaign.id,
          (msg) => emit('log', { message: msg })
        );
      } catch (err) {
        const msg = `Failed to fetch leads for campaign "${campaign.name}": ${describeError(err)}`;
        emit('log', { message: `WARNING: ${msg}` });
        summary.errors.push(msg);
        continue;
      }

      const pausedLeads = leads.filter(l => l.active === false);
      emit('log', { message: `"${campaign.name}": ${pausedLeads.length} paused lead(s) of ${leads.length}` });
      if (pausedLeads.length === 0) continue;
      summary.pausedLeadsFound += pausedLeads.length;

      // Build lookup keys (basic /in/ id + email) for the paused leads.
      const pausedByKey = new Map();
      for (const lead of pausedLeads) {
        const url = resolveBasicLinkedInUrl(lead);
        const key = linkedInMatchKey(url);
        const email = resolveLeadEmail(lead);
        const rec = { name: leadFullName(lead), url, email };
        if (key) pausedByKey.set(key, rec);
        if (email) pausedByKey.set(`email:${email.toLowerCase()}`, rec);
      }

      // --- Salesrobot campaigns with the same name ---
      const targetUuids = srByName.get((campaign.name || '').trim().toLowerCase()) || [];
      if (targetUuids.length === 0) {
        summary.campaignsNotFoundInSR.push({ seat: skyLeadAccountId, campaignName: campaign.name });
        emit('log', { message: `  ⚠ No Salesrobot campaign named "${campaign.name}" — skipping` });
        continue;
      }
      emit('log', { message: `  ${targetUuids.length} matching Salesrobot campaign(s) named "${campaign.name}"` });

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

        const matched = [];
        for (const p of prospects) {
          const uuid = p.prospectUuid || p.uuid;
          if (!uuid) continue;
          const urlKey = linkedInMatchKey(p.profileUrl || p.linkedinUrl || '');
          const email = (p.linkedinEmailId || p.emailId || p.email || '').trim().toLowerCase();
          const rec = (urlKey && pausedByKey.get(urlKey)) || (email && pausedByKey.get(`email:${email}`));
          if (rec) {
            matched.push({ uuid, profileUrl: p.profileUrl || p.linkedinUrl || '', rec });
          }
        }

        summary.matchedProspects += matched.length;
        emit('log', { message: `  Matched ${matched.length} prospect(s) in Salesrobot campaign ${campaignUuid}` });

        for (let i = 0; i < matched.length; i += BATCH_SIZE) {
          const batch = matched.slice(i, i + BATCH_SIZE);
          const uuids = batch.map(m => m.uuid);
          try {
            await pauseProspects(salesrobotApiKey, salesrobotLinkedinAccountUuid, campaignUuid, uuids);
            summary.prospectsPaused += uuids.length;
            for (const m of batch) {
              summary.pausedProspects.push({
                seat: skyLeadAccountId,
                campaignName: campaign.name,
                prospectUuid: m.uuid,
                profileUrl: m.profileUrl,
                name: m.rec.name,
                email: m.rec.email,
              });
            }
            emit('log', { message: `  Paused ${Math.min(i + BATCH_SIZE, matched.length)}/${matched.length} prospect(s)` });
          } catch (err) {
            const msg = `Failed to pause a batch in Salesrobot campaign ${campaignUuid} ("${campaign.name}"): ${describeError(err)}`;
            emit('log', { message: `  WARNING: ${msg}` });
            summary.errors.push(msg);
          }
        }
      }

      emit('campaign_done', { name: campaign.name });
    }

    summary.accountsProcessed++;
    emit('account_done', { seat: skyLeadAccountId });
  }

  return summary;
}

module.exports = { runPauseProspects };
