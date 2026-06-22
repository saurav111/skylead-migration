import { useState, useEffect } from 'react';

export default function StepCampaignSelect({ credentials, accountMappings, seats, srEmailAccounts = [], onBack, onDone }) {
  const [campaigns, setCampaigns] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [includeReplied, setIncludeReplied] = useState(true);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');

  // Email step detection state
  const [emailPromptVisible, setEmailPromptVisible] = useState(false);
  const [campaignsWithEmail, setCampaignsWithEmail] = useState([]);
  const [emailAccountUuid, setEmailAccountUuid] = useState('');

  const { skyLeadApiKey, skyLeadUserId } = credentials;

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError('');
      const all = [];

      try {
        for (const mapping of accountMappings) {
          const params = new URLSearchParams({
            skyLeadApiKey,
            skyLeadUserId,
            accountId: mapping.skyLeadAccountId,
          });
          const resp = await fetch(`/api/campaigns?${params}`);
          const data = await resp.json();
          if (!resp.ok) throw new Error(data.error || 'Failed to fetch campaigns');

          const seat = seats.find(s => String(s.id) === mapping.skyLeadAccountId);
          const seatLabel = seat?.name || seat?.email || `Seat ${mapping.skyLeadAccountId}`;

          (data.campaigns || []).forEach(c => {
            all.push({ ...c, _seatLabel: seatLabel, _accountId: mapping.skyLeadAccountId });
          });
        }

        setCampaigns(all);
        setSelected(new Set(all.map(c => String(c.id))));
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    }

    load();
  }, []);

  function toggleCampaign(id) {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
    setEmailPromptVisible(false);
  }

  function toggleAll() {
    if (selected.size === campaigns.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(campaigns.map(c => String(c.id))));
    }
    setEmailPromptVisible(false);
  }

  async function handleNext() {
    if (selected.size === 0) return;

    if (emailPromptVisible) {
      onDone({
        campaigns,
        selectedIds: [...selected],
        includeReplied,
        emailAccountUuid: emailAccountUuid || '',
      });
      return;
    }

    setChecking(true);
    setError('');

    try {
      const resp = await fetch('/api/check-email-steps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          skyLeadApiKey,
          skyLeadUserId,
          accountMappings,
          campaignIds: [...selected],
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Failed to check campaigns');

      if (data.hasEmailSteps && srEmailAccounts.length > 0) {
        setCampaignsWithEmail(data.campaignsWithEmail || []);
        setEmailPromptVisible(true);
      } else {
        onDone({
          campaigns,
          selectedIds: [...selected],
          includeReplied,
          emailAccountUuid: '',
        });
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setChecking(false);
    }
  }

  if (loading) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: '60px 32px' }}>
        <span className="spinner dark" style={{ width: 24, height: 24 }} />
        <p style={{ marginTop: 16, color: '#6b7280' }}>Fetching campaigns from Skylead…</p>
      </div>
    );
  }

  return (
    <div className="card">
      <h2>Select campaigns to migrate</h2>
      <p className="subtitle">
        {campaigns.length} active campaign(s) found. All are selected by default.
      </p>

      {error && <div className="error-box">{error}</div>}

      <div className="select-all-row">
        <button className="btn btn-secondary" style={{ padding: '6px 14px', fontSize: 13 }} onClick={toggleAll}>
          {selected.size === campaigns.length ? 'Deselect all' : 'Select all'}
        </button>
      </div>

      <div className="campaign-list">
        {campaigns.map(c => {
          const id = String(c.id);
          const isSelected = selected.has(id);
          const total = c.campaignStats?.totalLeads ?? '?';
          return (
            <div
              key={id}
              className={`campaign-item ${isSelected ? 'selected' : ''}`}
              onClick={() => toggleCampaign(id)}
            >
              <input type="checkbox" checked={isSelected} onChange={() => toggleCampaign(id)} onClick={e => e.stopPropagation()} />
              <div className="campaign-info">
                <div className="campaign-name">{c.name}</div>
                <div className="campaign-meta">{total} leads</div>
                <div className="campaign-seat">{c._seatLabel}</div>
              </div>
            </div>
          );
        })}
      </div>

      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, margin: '16px 0', cursor: 'pointer', fontSize: 14 }}>
        <input
          type="checkbox"
          checked={includeReplied}
          onChange={e => setIncludeReplied(e.target.checked)}
          style={{ marginTop: 2, flexShrink: 0 }}
        />
        <span>
          <strong>Include replied leads</strong>
          <span style={{ display: 'block', color: '#6b7280', fontSize: 13, marginTop: 2 }}>
            Leads who already replied in Skylead will be added back into the campaign at their current step.
          </span>
        </span>
      </label>

      {emailPromptVisible && (
        <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, padding: '16px', marginBottom: 16 }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6, color: '#1e40af' }}>
            Email steps detected
          </div>
          <p style={{ fontSize: 13, color: '#374151', margin: '0 0 8px' }}>
            {campaignsWithEmail.length} campaign(s) contain email steps:{' '}
            {campaignsWithEmail.map(c => c.name).join(', ')}.
            Select the Salesrobot email account to use for these steps.
          </p>
          <select
            value={emailAccountUuid}
            onChange={e => setEmailAccountUuid(e.target.value)}
            style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #93c5fd', fontSize: 14 }}
          >
            <option value="">Skip email steps</option>
            {srEmailAccounts.map(acc => {
              const status = acc.tokenValid ? '✓' : '⚠';
              return (
                <option key={acc.emailUuid} value={acc.emailUuid}>
                  {status} {acc.email}
                </option>
              );
            })}
          </select>
        </div>
      )}

      <div className="btn-row">
        <button className="btn btn-secondary" onClick={onBack}>← Back</button>
        <button className="btn btn-primary" disabled={selected.size === 0 || checking} onClick={handleNext}>
          {checking
            ? <><span className="spinner" /> Checking…</>
            : `Migrate ${selected.size} campaign${selected.size !== 1 ? 's' : ''} →`}
        </button>
      </div>
    </div>
  );
}
