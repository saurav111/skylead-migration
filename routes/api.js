const express = require('express');
const router = express.Router();
const { getMe, getSeats, getCampaigns } = require('../services/skyleadClient');
const { getLinkedinAccounts } = require('../services/salesrobotClient');
const { runMigration } = require('../services/migrationService');

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

  res.json({ userId: me.id, skyLeadUser: me, seats, srAccounts });
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

module.exports = router;
