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

function downloadSkippedCSV(skippedLeads) {
  downloadCSV(
    'skipped-leads.csv',
    ['Campaign', 'First Name', 'Last Name', 'Full Name', 'Email', 'Company', 'Occupation', 'LinkedIn URL (raw)', 'Profile Identifiers'],
    skippedLeads.map(l => [
      l.campaignName, l.firstName, l.lastName, l.fullName,
      l.email, l.company, l.occupation, l.linkedinUrl, l.profileIdentifiers,
    ]),
  );
}

function downloadDuplicateCSV(duplicateLeads) {
  downloadCSV(
    'duplicate-profiles.csv',
    ['Campaign', 'Skylead Lead ID', 'Step', 'Profile URL', 'First Name', 'Last Name', 'Full Name', 'Email', 'Company', 'Occupation', 'LinkedIn URL (raw)', 'Profile Identifiers'],
    duplicateLeads.map(l => [
      l.campaignName, l.skyleadLeadId, l.step, l.profileUrl,
      l.firstName, l.lastName, l.fullName, l.email, l.company, l.occupation,
      l.linkedinUrl, l.profileIdentifiers,
    ]),
  );
}

function downloadFinishedCSV(finishedLeads) {
  downloadCSV(
    'finished-leads.csv',
    ['Campaign', 'Skylead Lead ID', 'Next Step', 'Profile URL', 'First Name', 'Last Name', 'Full Name', 'Email', 'Company', 'Occupation', 'LinkedIn URL (raw)', 'Profile Identifiers'],
    finishedLeads.map(l => [
      l.campaignName, l.skyleadLeadId, l.nextStep, l.profileUrl,
      l.firstName, l.lastName, l.fullName, l.email, l.company, l.occupation,
      l.linkedinUrl, l.profileIdentifiers,
    ]),
  );
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
    duplicateLeads = [],
    leadsSkippedDuplicate = 0,
    finishedLeads = [],
    prospectsIdentifierType2 = 0,
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
        {leadsSkippedDuplicate > 0 && (
          <div className="stat-card yellow" style={{ position: 'relative' }}>
            <div className="num">{leadsSkippedDuplicate}</div>
            <div className="label">Duplicate profiles skipped</div>
            {duplicateLeads.length > 0 && (
              <button
                onClick={() => downloadDuplicateCSV(duplicateLeads)}
                style={{ marginTop: 10, fontSize: 12, padding: '4px 10px', cursor: 'pointer', border: '1px solid #d97706', borderRadius: 6, background: 'transparent', color: '#d97706', fontWeight: 600 }}
              >
                ↓ Download CSV
              </button>
            )}
          </div>
        )}
        <div className="stat-card green">
          <div className="num">{prospectsIdentifierType2}</div>
          <div className="label">Prospects with Sales Navigator identifier (type 2)</div>
        </div>
        {finishedLeads.length > 0 && (
          <div className="stat-card green" style={{ position: 'relative' }}>
            <div className="num">{finishedLeads.length}</div>
            <div className="label">Leads finished in Skylead</div>
            <button
              onClick={() => downloadFinishedCSV(finishedLeads)}
              style={{ marginTop: 10, fontSize: 12, padding: '4px 10px', cursor: 'pointer', border: '1px solid #16a34a', borderRadius: 6, background: 'transparent', color: '#16a34a', fontWeight: 600 }}
            >
              ↓ Download CSV
            </button>
          </div>
        )}
      </div>

      {finishedLeads.length > 0 && (
        <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, padding: '12px 16px', marginBottom: 16, fontSize: 13, color: '#1e40af' }}>
          <strong>{finishedLeads.length} finished lead(s)</strong> were imported as prospects. Use the <strong>Paused Prospects</strong> tab to pause finished and paused-in-Skylead prospects in Salesrobot before starting campaigns.
        </div>
      )}

      {branchesDropped > 0 && (
        <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '12px 16px', marginBottom: 16, fontSize: 13, color: '#92400e' }}>
          <strong>{branchesDropped} conditional branch(es)</strong> were not migrated — Salesrobot uses linear sequences. Review your campaigns and add any branch logic manually.
        </div>
      )}

      {leadsSkippedDuplicate > 0 && (
        <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '12px 16px', marginBottom: 16, fontSize: 13, color: '#92400e' }}>
          <strong>{leadsSkippedDuplicate} duplicate profile(s)</strong> were not imported — the same LinkedIn URL appeared in multiple Skylead steps and only the first occurrence was kept. Download the CSV for the full list.
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
