function downloadSkippedCSV(skippedLeads) {
  const headers = ['Campaign', 'First Name', 'Last Name', 'Full Name', 'Email', 'Company', 'Occupation', 'LinkedIn URL (raw)', 'Profile Identifiers'];
  const rows = skippedLeads.map(l => [
    l.campaignName, l.firstName, l.lastName, l.fullName,
    l.email, l.company, l.occupation, l.linkedinUrl, l.profileIdentifiers,
  ]);
  const csv = [headers, ...rows]
    .map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'skipped-leads.csv';
  a.click();
  URL.revokeObjectURL(url);
}

export default function StepSummary({ summary, onReset }) {
  if (!summary) return null;

  const {
    campaignsCreated = 0,
    leadsImported = 0,
    leadsSkippedNoUrl = 0,
    leadsSkippedReplied = 0,
    branchesDropped = 0,
    errors = [],
    skippedLeads = [],
  } = summary;

  return (
    <div className="card">
      <h2>Migration complete</h2>
      <p className="subtitle">
        All migrated campaigns are paused in Salesrobot. Review the sequence copy then start each campaign.
      </p>

      <div className="summary-grid">
        <div className="stat-card green">
          <div className="num">{campaignsCreated}</div>
          <div className="label">Campaigns created</div>
        </div>
        <div className="stat-card green">
          <div className="num">{leadsImported}</div>
          <div className="label">Leads imported at correct step</div>
        </div>
        {leadsSkippedReplied > 0 && (
          <div className="stat-card yellow">
            <div className="num">{leadsSkippedReplied}</div>
            <div className="label">Replied leads skipped</div>
          </div>
        )}
        <div className="stat-card yellow" style={{ position: 'relative' }}>
          <div className="num">{leadsSkippedNoUrl}</div>
          <div className="label">Leads skipped (no LinkedIn URL)</div>
          {skippedLeads.length > 0 && (
            <button
              onClick={() => downloadSkippedCSV(skippedLeads)}
              style={{ marginTop: 10, fontSize: 12, padding: '4px 10px', cursor: 'pointer', border: '1px solid #d97706', borderRadius: 6, background: 'transparent', color: '#d97706', fontWeight: 600 }}
            >
              ↓ Download CSV
            </button>
          )}
        </div>
      </div>

      {branchesDropped > 0 && (
        <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '12px 16px', marginBottom: 16, fontSize: 13, color: '#92400e' }}>
          <strong>{branchesDropped} conditional branch(es)</strong> were not migrated — Salesrobot uses linear sequences. Review your campaigns and add any branch logic manually.
        </div>
      )}

      {leadsSkippedReplied > 0 && (
        <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, padding: '12px 16px', marginBottom: 16, fontSize: 13, color: '#1e40af' }}>
          <strong>{leadsSkippedReplied} replied lead(s)</strong> were not migrated. These are live conversations — handle them in your Salesrobot inbox after connecting the LinkedIn account.
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
          Start a new migration
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
