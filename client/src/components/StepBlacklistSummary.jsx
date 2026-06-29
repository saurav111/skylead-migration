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

export default function StepBlacklistSummary({ summary, onReset }) {
  if (!summary) return null;

  const {
    accountsProcessed = 0,
    companyNamesImported = 0,
    profileUrlsImported = 0,
    fullNamesMatched = 0,
    fullNamesUnmatched = 0,
    unsupportedSkipped = 0,
    errors = [],
    unmatchedNames = [],
    unsupportedTypes = [],
    companyNamesList = [],
    profileUrlsList = [],
    resolvedNames = [],
  } = summary;

  return (
    <div className="card">
      <h2>Blacklist import complete</h2>
      <p className="subtitle">
        Company names and profile URLs were added to the matching Salesrobot LinkedIn accounts' blocklist.
      </p>

      <div className="summary-grid">
        <div className="stat-card green" style={{ position: 'relative' }}>
          <div className="num">{companyNamesImported}</div>
          <div className="label">Company names imported</div>
          {companyNamesList.length > 0 && (
            <DownloadBtn onClick={() => downloadCSV('imported-company-names.csv', ['Seat', 'Company Name'], companyNamesList.map(c => [c.seat, c.companyName]))} />
          )}
        </div>
        <div className="stat-card green" style={{ position: 'relative' }}>
          <div className="num">{profileUrlsImported}</div>
          <div className="label">Profile URLs imported</div>
          {profileUrlsList.length > 0 && (
            <DownloadBtn onClick={() => downloadCSV('imported-profile-urls.csv', ['Seat', 'Profile URL'], profileUrlsList.map(p => [p.seat, p.profileUrl]))} />
          )}
        </div>
        <div className="stat-card green" style={{ position: 'relative' }}>
          <div className="num">{fullNamesMatched}</div>
          <div className="label">Full names resolved to a profile URL</div>
          {resolvedNames.length > 0 && (
            <DownloadBtn onClick={() => downloadCSV('resolved-full-names.csv', ['Seat', 'Full Name', 'Profile URL'], resolvedNames.map(r => [r.seat, r.name, r.profileUrl]))} />
          )}
        </div>
        {fullNamesUnmatched > 0 && (
          <div className="stat-card yellow" style={{ position: 'relative' }}>
            <div className="num">{fullNamesUnmatched}</div>
            <div className="label">Full names with no matching lead</div>
            {unmatchedNames.length > 0 && (
              <button
                onClick={() => downloadCSV('unmatched-blacklist-names.csv', ['Seat', 'Full Name'], unmatchedNames.map(n => [n.seat, n.name]))}
                style={{ marginTop: 10, fontSize: 12, padding: '4px 10px', cursor: 'pointer', border: '1px solid #d97706', borderRadius: 6, background: 'transparent', color: '#d97706', fontWeight: 600 }}
              >
                ↓ Download CSV
              </button>
            )}
          </div>
        )}
        {unsupportedSkipped > 0 && (
          <div className="stat-card yellow" style={{ position: 'relative' }}>
            <div className="num">{unsupportedSkipped}</div>
            <div className="label">Entries skipped (unsupported type)</div>
            {unsupportedTypes.length > 0 && (
              <button
                onClick={() => downloadCSV('skipped-blacklist-types.csv', ['Seat', 'Type', 'Count'], unsupportedTypes.map(t => [t.seat, t.type, t.count]))}
                style={{ marginTop: 10, fontSize: 12, padding: '4px 10px', cursor: 'pointer', border: '1px solid #d97706', borderRadius: 6, background: 'transparent', color: '#d97706', fontWeight: 600 }}
              >
                ↓ Download CSV
              </button>
            )}
          </div>
        )}
        <div className="stat-card">
          <div className="num">{accountsProcessed}</div>
          <div className="label">Accounts processed</div>
        </div>
      </div>

      {unsupportedSkipped > 0 && (
        <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '12px 16px', marginBottom: 16, fontSize: 13, color: '#92400e' }}>
          <strong>{unsupportedSkipped} entr(ies)</strong> used a keyword type Salesrobot's blocklist doesn't support (e.g. job title, email, domain) and were skipped. Salesrobot only blocks by company name or profile URL.
        </div>
      )}

      {fullNamesUnmatched > 0 && (
        <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, padding: '12px 16px', marginBottom: 16, fontSize: 13, color: '#1e40af' }}>
          <strong>{fullNamesUnmatched} blacklisted full name(s)</strong> had no matching lead in any campaign under that seat, so no profile URL could be found. Download the CSV to review them.
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
          Import another blacklist
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
