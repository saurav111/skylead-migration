import { useState, useEffect } from 'react';

export default function StepCampaignSelect({ credentials, accountMappings, seats, onBack, onDone }) {
  const [campaigns, setCampaigns] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

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
  }

  function toggleAll() {
    if (selected.size === campaigns.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(campaigns.map(c => String(c.id))));
    }
  }

  function handleNext() {
    if (selected.size === 0) return;
    onDone({ campaigns, selectedIds: [...selected] });
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

      <div className="btn-row">
        <button className="btn btn-secondary" onClick={onBack}>← Back</button>
        <button className="btn btn-primary" disabled={selected.size === 0} onClick={handleNext}>
          Migrate {selected.size} campaign{selected.size !== 1 ? 's' : ''} →
        </button>
      </div>
    </div>
  );
}
