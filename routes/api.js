const express = require('express');
const router = express.Router();
const { getSeats, getCampaigns } = require('../services/skyleadClient');
const { getLinkedinAccounts } = require('../services/salesrobotClient');
const { runMigration } = require('../services/migrationService');

// In-memory session store (single-instance, no DB needed)
const sessions = new Map();

// POST /api/connect — validate both API keys and fetch accounts
router.post('/connect', async (req, res) => {
  const { skyLeadApiKey, skyLeadUserId, salesrobotApiKey } = req.body;

  if (!skyLeadApiKey || !skyLeadUserId || !salesrobotApiKey) {
    return res.status(400).json({ error: 'All three fields are required' });
  }

  try {
    const [seats, srAccounts] = await Promise.all([
      getSeats(skyLeadApiKey, skyLeadUserId),
      getLinkedinAccounts(salesrobotApiKey),
    ]);

    res.json({ seats, srAccounts });
  } catch (err) {
    const status = err.response?.status;
    if (status === 401 || status === 403) {
      return res.status(400).json({ error: 'Invalid API key — check your credentials and try again' });
    }
    res.status(500).json({ error: err.message });
  }
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
  setTimeout(() => sessions.delete(sessionId), 30 * 60 * 1000); // clean up after 30min

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
  res.setHeader('X-Accel-Buffering', 'no'); // important for Render/nginx
  res.flushHeaders();

  // Keep connection alive every 15s
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
