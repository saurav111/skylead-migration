import { useState } from 'react';
import StepBlacklistConnect from './StepBlacklistConnect';
import StepAccountMapping from './StepAccountMapping';
import StepBlacklistProgress from './StepBlacklistProgress';
import StepBlacklistSummary from './StepBlacklistSummary';

const BLACKLIST_STEPS = ['Session', 'Map Accounts', 'Import', 'Done'];

export default function BlacklistTab({ credentials, seats, srAccounts }) {
  const [step, setStep] = useState(0);
  const [cookie, setCookie] = useState('');
  const [appUrl, setAppUrl] = useState('');
  const [accountMappings, setAccountMappings] = useState([]);
  const [summary, setSummary] = useState(null);

  function reset() {
    setStep(0);
    setAccountMappings([]);
    setSummary(null);
  }

  return (
    <>
      <Stepper current={step} steps={BLACKLIST_STEPS} />

      {step === 0 && (
        <StepBlacklistConnect
          initialCookie={cookie}
          initialAppUrl={appUrl || undefined}
          onDone={({ cookie: c, appUrl: a }) => {
            setCookie(c);
            setAppUrl(a);
            setStep(1);
          }}
        />
      )}

      {step === 1 && (
        <StepAccountMapping
          seats={seats}
          srAccounts={srAccounts}
          onBack={() => setStep(0)}
          nextLabel="Import blacklist →"
          onDone={(mappings) => {
            setAccountMappings(mappings);
            setStep(2);
          }}
        />
      )}

      {step === 2 && (
        <StepBlacklistProgress
          credentials={credentials}
          accountMappings={accountMappings}
          skyleadCookie={cookie}
          appBaseUrl={appUrl}
          onDone={(s) => { setSummary(s); setStep(3); }}
        />
      )}

      {step === 3 && (
        <StepBlacklistSummary summary={summary} onReset={reset} />
      )}
    </>
  );
}

function Stepper({ current, steps }) {
  return (
    <div className="stepper">
      {steps.map((label, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center' }}>
          <div className={`step-item ${i === current ? 'active' : i < current ? 'done' : ''}`}>
            <div className="step-num">
              {i < current ? '✓' : i + 1}
            </div>
            <span>{label}</span>
          </div>
          {i < steps.length - 1 && (
            <div className={`step-connector ${i < current ? 'done' : ''}`} />
          )}
        </div>
      ))}
    </div>
  );
}
