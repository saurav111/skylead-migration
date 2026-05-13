const express = require('express');
const router = express.Router();
const { getMe, getSeats, getCampaigns } = require('../services/skyleadClient');
const { getLinkedinAccounts } = require('../services/salesrobotClient');
const { runMigration } = require('../services/migrationService');

const sessions = new Map();

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

// POST /api/migrate/start — store config, return sessionId
router.post('/migrate/start', (req, res) => {
  const { skyLeadApiKey, skyLeadUserId, salesrobotApiKey, accountMappings, selectedCampaignIds } = req.body;

  if (!skyLeadApiKey || !skyLeadUserId || !salesrobotApiKey || !accountMappings?.length || !selectedCampaignIds?.length) {
    return res.status(400).json({ error: 'Incomplete migration config' });
  }

  const sessionId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  sessions.set(sessionId, req.body);
  setTimeout(() => sessions.delete(sessionId), 30 * 60 * 1000);

  res.json({ sessionId });
});

// GET /api/migrate/stream?sessionId=xxx — SSE migration stream
router.get('/migrate/stream', async (req, res) => {
  const { sessionId } = req.query;
  const config = sessions.get(sessionId);

  if (!config) {
    return res.status(404).json({ error: 'Session not found or expired' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);

  function emit(type, data = {}) {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  }

  try {
    const summary = await runMigration(config, emit);
    emit('complete', { summary });
  } catch (err) {
    emit('error', { message: err.message });
  } finally {
    clearInterval(heartbeat);
    sessions.delete(sessionId);
    res.end();
  }
});

module.exports = router;
