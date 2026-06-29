const express = require('express');
const router = express.Router();
const { getMe, getSeats, getCampaigns, getCampaignDetails, flattenSteps, detectCampaignFamily } = require('../services/skyleadClient');
const { getLinkedinAccounts, getEmailAccounts } = require('../services/salesrobotClient');
const { runMigration } = require('../services/migrationService');
const { runBlacklistImport } = require('../services/blacklistService');
const { runPauseProspects } = require('../services/pauseProspectsService');

// POST /api/connect — validate both keys, auto-fetch userId + seats + SR accounts
router.post('/connect', async (req, res) => {
  const { skyLeadApiKey, salesrobotApiKey } = req.body;

  if (!skyLeadApiKey || !salesrobotApiKey) {
    return res.status(400).json({ error: 'Both API keys are required' });
  }

  let me, seats, srAccounts;

  try {
    [me, seats] = await Promise.all([getMe(skyLeadApiKey), getSeats(skyLeadApiKey)]);
  } catch (err) {
    const status = err.response?.status;
    console.error('Skylead error', status, err.response?.data);
    if (status === 401 || status === 403) {
      return res.status(400).json({ error: 'Skylead API key is invalid' });
    }
    return res.status(500).json({ error: `Skylead error: ${err.message}` });
  }

  try {
    srAccounts = await getLinkedinAccounts(salesrobotApiKey);
  } catch (err) {
    const status = err.response?.status;
    console.error('Salesrobot error', status, err.response?.data);
    if (status === 401 || status === 403) {
      return res.status(400).json({ error: 'Salesrobot API key is invalid' });
    }
    return res.status(500).json({ error: `Salesrobot error: ${err.message}` });
  }

  let srEmailAccounts = [];
  try {
    srEmailAccounts = await getEmailAccounts(salesrobotApiKey);
  } catch (err) {
    console.warn('Could not fetch Salesrobot email accounts:', err.message);
  }

  res.json({ userId: me.id, skyLeadUser: me, seats, srAccounts, srEmailAccounts });
});

// GET /api/campaigns?skyLeadApiKey=&skyLeadUserId=&accountId=
router.get('/campaigns', async (req, res) => {
  const { skyLeadApiKey, skyLeadUserId, accountId } = req.query;

  if (!skyLeadApiKey || !skyLeadUserId || !accountId) {
    return res.status(400).json({ error: 'Missing required query params' });
  }

  try {
    const campaigns = await getCampaigns(skyLeadApiKey, skyLeadUserId, accountId);
    res.json({ campaigns });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/check-email-steps — check if selected campaigns contain email steps
router.post('/check-email-steps', async (req, res) => {
  const { skyLeadApiKey, skyLeadUserId, accountMappings, campaignIds } = req.body;

  if (!skyLeadApiKey || !skyLeadUserId || !accountMappings?.length || !campaignIds?.length) {
    return res.status(400).json({ error: 'Missing required params' });
  }

  try {
    let hasEmailSteps = false;
    const campaignsWithEmail = [];

    for (const mapping of accountMappings) {
      const campaigns = await getCampaigns(skyLeadApiKey, skyLeadUserId, mapping.skyLeadAccountId);
      const selected = campaigns.filter(c => campaignIds.includes(String(c.id)));

      for (const campaign of selected) {
        const details = await getCampaignDetails(
          skyLeadApiKey, skyLeadUserId, mapping.skyLeadAccountId, campaign.id
        );
        const { steps } = flattenSteps(details.campaignSteps);
        const family = detectCampaignFamily(steps);

        if (family === 'HYBRID' || family === 'NYLAS') {
          hasEmailSteps = true;
          campaignsWithEmail.push({ id: campaign.id, name: campaign.name, family });
        }
      }
    }

    res.json({ hasEmailSteps, campaignsWithEmail });
  } catch (err) {
    console.error('check-email-steps error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/migrate/stream — SSE migration stream (config in body, no session needed)
router.post('/migrate/stream', async (req, res) => {
  const { skyLeadApiKey, skyLeadUserId, salesrobotApiKey, accountMappings, selectedCampaignIds } = req.body;

  if (!skyLeadApiKey || !skyLeadUserId || !salesrobotApiKey || !accountMappings?.length || !selectedCampaignIds?.length) {
    return res.status(400).json({ error: 'Incomplete migration config' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);

  function emit(type, data = {}) {
    const isError = type === 'error' || type === 'campaign_error';
    const logLine = data.message || data.name || type;
    if (isError) console.error(`[migration] ${type}:`, logLine);
    else console.log(`[migration] ${type}:`, logLine);
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  }

  try {
    const summary = await runMigration(req.body, emit);
    console.log('[migration] complete:', JSON.stringify(summary));
    emit('complete', { summary });
  } catch (err) {
    console.error('[migration] fatal:', err.message);
    emit('error', { message: err.message });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

// POST /api/blacklist/stream — SSE blacklist import stream
router.post('/blacklist/stream', async (req, res) => {
  const { skyLeadApiKey, skyLeadUserId, salesrobotApiKey, accountMappings, skyleadCookie } = req.body;

  if (!skyLeadApiKey || !skyLeadUserId || !salesrobotApiKey || !accountMappings?.length) {
    return res.status(400).json({ error: 'Incomplete blacklist import config' });
  }
  if (!skyleadCookie) {
    return res.status(400).json({ error: 'Skylead session cookie is required to read the blacklist' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);

  function emit(type, data = {}) {
    const isError = type === 'error';
    const logLine = data.message || data.seat || type;
    if (isError) console.error(`[blacklist] ${type}:`, logLine);
    else console.log(`[blacklist] ${type}:`, logLine);
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  }

  try {
    const summary = await runBlacklistImport(req.body, emit);
    console.log('[blacklist] complete:', JSON.stringify(summary));
    emit('complete', { summary });
  } catch (err) {
    console.error('[blacklist] fatal:', err.message);
    emit('error', { message: err.message });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

// POST /api/pause-prospects/stream — SSE: pause Skylead-paused leads in matching SR campaigns
router.post('/pause-prospects/stream', async (req, res) => {
  const { skyLeadApiKey, skyLeadUserId, salesrobotApiKey, accountMappings } = req.body;

  if (!skyLeadApiKey || !skyLeadUserId || !salesrobotApiKey || !accountMappings?.length) {
    return res.status(400).json({ error: 'Incomplete pause-prospects config' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);

  function emit(type, data = {}) {
    const isError = type === 'error';
    const logLine = data.message || data.seat || data.name || type;
    if (isError) console.error(`[pause-prospects] ${type}:`, logLine);
    else console.log(`[pause-prospects] ${type}:`, logLine);
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  }

  try {
    const summary = await runPauseProspects(req.body, emit);
    console.log('[pause-prospects] complete:', JSON.stringify(summary));
    emit('complete', { summary });
  } catch (err) {
    console.error('[pause-prospects] fatal:', err.message);
    emit('error', { message: err.message });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

module.exports = router;
