import { useState } from 'react';
import StepConnect from './components/StepConnect';
import StepAccountMapping from './components/StepAccountMapping';
import StepCampaignSelect from './components/StepCampaignSelect';
import StepProgress from './components/StepProgress';
import StepSummary from './components/StepSummary';

const STEPS = ['Connect', 'Map Accounts', 'Select Campaigns', 'Migrate', 'Done'];

export default function App() {
  const [step, setStep] = useState(0);
  const [credentials, setCredentials] = useState(null);
  const [seats, setSeats] = useState([]);
  const [srAccounts, setSrAccounts] = useState([]);
  const [srEmailAccounts, setSrEmailAccounts] = useState([]);
  const [accountMappings, setAccountMappings] = useState([]);
  const [allCampaigns, setAllCampaigns] = useState([]);
  const [selectedCampaignIds, setSelectedCampaignIds] = useState([]);
  const [includeReplied, setIncludeReplied] = useState(false);
  const [emailAccountUuid, setEmailAccountUuid] = useState('');
  const [summary, setSummary] = useState(null);

  function goTo(s) { setStep(s); }

  return (
    <div className="app">
      <div className="header">
        <h1>Skylead → Salesrobot Migration</h1>
        <p>Move your campaigns and leads in one click</p>
      </div>

      <Stepper current={step} steps={STEPS} />

      {step === 0 && (
        <StepConnect
          onDone={({ creds, seats, srAccounts, srEmailAccounts }) => {
            setCredentials(creds);
            setSeats(seats);
            setSrAccounts(srAccounts);
            setSrEmailAccounts(srEmailAccounts || []);
            goTo(1);
          }}
        />
      )}

      {step === 1 && (
        <StepAccountMapping
          seats={seats}
          srAccounts={srAccounts}
          onBack={() => goTo(0)}
          onDone={(mappings) => {
            setAccountMappings(mappings);
            goTo(2);
          }}
        />
      )}

      {step === 2 && (
        <StepCampaignSelect
          credentials={credentials}
          accountMappings={accountMappings}
          seats={seats}
          srEmailAccounts={srEmailAccounts}
          onBack={() => goTo(1)}
          onDone={({ campaigns, selectedIds, includeReplied: ir, emailAccountUuid: eu }) => {
            setAllCampaigns(campaigns);
            setSelectedCampaignIds(selectedIds);
            setIncludeReplied(ir);
            setEmailAccountUuid(eu || '');
            goTo(3);
          }}
        />
      )}

      {step === 3 && (
        <StepProgress
          credentials={credentials}
          accountMappings={accountMappings}
          selectedCampaignIds={selectedCampaignIds}
          includeReplied={includeReplied}
          emailAccountUuid={emailAccountUuid}
          onDone={(s) => { setSummary(s); goTo(4); }}
        />
      )}

      {step === 4 && (
        <StepSummary
          summary={summary}
          onReset={() => {
            setStep(0);
            setCredentials(null);
            setSeats([]);
            setSrAccounts([]);
            setSrEmailAccounts([]);
            setAccountMappings([]);
            setAllCampaigns([]);
            setSelectedCampaignIds([]);
            setIncludeReplied(false);
            setEmailAccountUuid('');
            setSummary(null);
          }}
        />
      )}
    </div>
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
