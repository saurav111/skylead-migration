function downloadCSV(filename, headers, rows) {
  const csv = [headers, ...rows]
    .map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function DownloadBtn({ color = '#16a34a', onClick }) {
  return (
    <button
      onClick={onClick}
      style={{ marginTop: 10, fontSize: 12, padding: '4px 10px', cursor: 'pointer', border: `1px solid ${color}`, borderRadius: 6, background: 'transparent', color, fontWeight: 600 }}
    >
      ↓ Download CSV
    </button>
  );
}

export default function StepPauseSummary({ summary, onReset }) {
  if (!summary) return null;

  const {
    accountsProcessed = 0,
    skyleadCampaignsScanned = 0,
    pausedLeadsFound = 0,
    matchedProspects = 0,
    prospectsPaused = 0,
    errors = [],
    pausedProspects = [],
    campaignsNotFoundInSR = [],
  } = summary;

  return (
    <div className="card">
      <h2>Paused prospects complete</h2>
      <p className="subtitle">
        Leads paused in Skylead were paused in every Salesrobot campaign sharing the same name.
      </p>

      <div className="summary-grid">
        <div className="stat-card green" style={{ position: 'relative' }}>
          <div className="num">{prospectsPaused}</div>
          <div className="label">Prospects paused in Salesrobot</div>
          {pausedProspects.length > 0 && (
            <DownloadBtn onClick={() => downloadCSV(
              'paused-prospects.csv',
              ['Seat', 'Campaign', 'Name', 'Profile URL', 'Email', 'Prospect UUID'],
              pausedProspects.map(p => [p.seat, p.campaignName, p.name, p.profileUrl, p.email, p.prospectUuid])
            )} />
          )}
        </div>
        <div className="stat-card">
          <div className="num">{pausedLeadsFound}</div>
          <div className="label">Paused leads found in Skylead</div>
        </div>
        <div className="stat-card">
          <div className="num">{matchedProspects}</div>
          <div className="label">Matched Salesrobot prospects</div>
        </div>
        <div className="stat-card">
          <div className="num">{skyleadCampaignsScanned}</div>
          <div className="label">Skylead campaigns scanned</div>
        </div>
        {campaignsNotFoundInSR.length > 0 && (
          <div className="stat-card yellow" style={{ position: 'relative' }}>
            <div className="num">{campaignsNotFoundInSR.length}</div>
            <div className="label">Campaigns with no Salesrobot match</div>
            <DownloadBtn
              color="#d97706"
              onClick={() => downloadCSV('campaigns-without-sr-match.csv', ['Seat', 'Campaign'], campaignsNotFoundInSR.map(c => [c.seat, c.campaignName]))}
            />
          </div>
        )}
        <div className="stat-card">
          <div className="num">{accountsProcessed}</div>
          <div className="label">Accounts processed</div>
        </div>
      </div>

      {campaignsNotFoundInSR.length > 0 && (
        <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '12px 16px', marginBottom: 16, fontSize: 13, color: '#92400e' }}>
          <strong>{campaignsNotFoundInSR.length} Skylead campaign(s)</strong> had paused leads but no Salesrobot campaign with a matching name, so those leads were not paused. Download the CSV to review them.
        </div>
      )}

      {errors.length > 0 && (
        <div className="error-list">
          <h4>Errors ({errors.length})</h4>
          <ul>
            {errors.map((e, i) => <li key={i}>{e}</li>)}
          </ul>
        </div>
      )}

      <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 24 }}>
        <button className="btn btn-secondary" onClick={onReset}>
          Run again
        </button>
        <a
          className="btn btn-primary"
          href="https://app.salesrobot.co"
          target="_blank"
          rel="noopener noreferrer"
        >
          Open Salesrobot →
        </a>
      </div>
    </div>
  );
}
