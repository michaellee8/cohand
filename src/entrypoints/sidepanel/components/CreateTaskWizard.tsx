import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useWizardStore, type WizardStep } from '../stores/wizard-store';
import { CodeBlock } from './CodeBlock';

const STEP_KEYS: { key: WizardStep; labelKey: string }[] = [
  { key: 'describe', labelKey: 'wizard.step.describe' },
  { key: 'domains', labelKey: 'wizard.step.domains' },
  { key: 'observe', labelKey: 'wizard.step.observe' },
  { key: 'review', labelKey: 'wizard.step.review' },
  { key: 'test', labelKey: 'wizard.step.test' },
  { key: 'schedule', labelKey: 'wizard.step.schedule' },
];

interface CreateTaskWizardProps {
  onComplete: () => void;
  onCancel: () => void;
}

export function CreateTaskWizard({ onComplete, onCancel }: CreateTaskWizardProps) {
  const { t } = useTranslation();
  const store = useWizardStore();

  const currentIdx = STEP_KEYS.findIndex(s => s.key === store.step);

  const handleCancel = () => {
    store.reset();
    onCancel();
  };

  return (
    <div className="flex flex-col h-full">
      {/* Step indicator */}
      <div className="px-4 pt-4 pb-2">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-base font-semibold">{t('wizard.newTask')}</h2>
          <button
            onClick={handleCancel}
            className="text-gray-400 hover:text-gray-600"
            aria-label={t('wizard.cancelAriaLabel')}
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="flex items-center gap-1">
          {STEP_KEYS.map((s, i) => (
            <div key={s.key} className="flex items-center flex-1">
              <div
                className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-medium ${
                  i < currentIdx
                    ? 'bg-blue-500 text-white'
                    : i === currentIdx
                      ? 'bg-blue-500 text-white ring-2 ring-blue-200'
                      : 'bg-gray-200 text-gray-500'
                }`}
              >
                {i < currentIdx ? (
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  i + 1
                )}
              </div>
              {i < STEP_KEYS.length - 1 && (
                <div className={`flex-1 h-0.5 mx-1 ${i < currentIdx ? 'bg-blue-500' : 'bg-gray-200'}`} />
              )}
            </div>
          ))}
        </div>
        <p className="text-xs text-gray-500 mt-1">
          {t('wizard.stepIndicator', { current: currentIdx + 1, label: t(STEP_KEYS[currentIdx].labelKey) })}
        </p>
      </div>

      {/* Error display */}
      {store.error && (
        <div className="mx-4 mb-2 px-3 py-2 bg-red-50 text-red-600 text-xs rounded-lg">
          {store.error}
        </div>
      )}

      {/* Step content */}
      <div className="flex-1 overflow-y-auto px-4 py-2">
        {store.step === 'describe' && <DescribeStep />}
        {store.step === 'domains' && <DomainsStep />}
        {store.step === 'observe' && <ObserveStep />}
        {store.step === 'review' && <ReviewStep />}
        {store.step === 'test' && <TestStep />}
        {store.step === 'schedule' && <ScheduleStep onComplete={onComplete} />}
      </div>

      {/* Navigation buttons */}
      <div className="p-4 border-t border-gray-200 flex items-center justify-between">
        <button
          onClick={handleCancel}
          className="text-sm text-gray-500 hover:text-gray-700 transition-colors"
        >
          {t('wizard.cancel')}
        </button>
        <div className="flex gap-2">
          {currentIdx > 0 && (
            <button
              onClick={store.prevStep}
              disabled={store.loading}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50"
            >
              {t('wizard.back')}
            </button>
          )}
          {store.step !== 'schedule' && store.step !== 'observe' && (
            <NextButton />
          )}
        </div>
      </div>
    </div>
  );
}

function NextButton() {
  const { t } = useTranslation();
  const { step, description, domains, nextStep, loading } = useWizardStore();

  const isDisabled = (() => {
    if (loading) return true;
    if (step === 'describe' && !description.trim()) return true;
    if (step === 'domains' && domains.length === 0) return true;
    return false;
  })();

  return (
    <button
      onClick={nextStep}
      disabled={isDisabled}
      className="bg-blue-500 text-white rounded-lg px-3 py-1.5 text-sm font-medium hover:bg-blue-600 transition-colors disabled:opacity-50"
    >
      {t('wizard.next')}
    </button>
  );
}

function DescribeStep() {
  const { t } = useTranslation();
  const { description, setDescription } = useWizardStore();

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          {t('wizard.describe.label')}
        </label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('wizard.describe.placeholder')}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
          rows={5}
          autoFocus
        />
      </div>
      <p className="text-xs text-gray-400">
        {t('wizard.describe.hint')}
      </p>
    </div>
  );
}

function DomainsStep() {
  const { t } = useTranslation();
  const { domains, currentTabUrl, addDomain, removeDomain } = useWizardStore();
  const [newDomain, setNewDomain] = useState('');

  useEffect(() => {
    useWizardStore.getState().detectCurrentTab();
  }, []);

  const handleAdd = () => {
    const trimmed = newDomain.trim();
    if (trimmed) {
      addDomain(trimmed);
      setNewDomain('');
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          {t('wizard.domains.label')}
        </label>
        <p className="text-xs text-gray-400 mb-2">
          {t('wizard.domains.hint')}
        </p>
      </div>

      {currentTabUrl && (
        <div className="text-xs text-gray-500 bg-gray-50 rounded-lg px-3 py-2">
          {t('wizard.domains.currentTab')} <span className="font-mono">{currentTabUrl}</span>
        </div>
      )}

      <div className="space-y-1.5">
        {domains.map(domain => (
          <div key={domain} className="flex items-center justify-between bg-blue-50 rounded-lg px-3 py-1.5">
            <span className="text-sm font-mono text-blue-700">{domain}</span>
            <button
              onClick={() => removeDomain(domain)}
              className="text-blue-400 hover:text-red-500 transition-colors"
              aria-label={t('wizard.domains.removeDomain', { domain })}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        ))}
      </div>

      <div className="flex gap-2">
        <input
          type="text"
          value={newDomain}
          onChange={(e) => setNewDomain(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
          placeholder={t('wizard.domains.placeholder')}
          className="flex-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        />
        <button
          onClick={handleAdd}
          disabled={!newDomain.trim()}
          className="bg-gray-100 text-gray-700 rounded-lg px-3 py-1.5 text-sm font-medium hover:bg-gray-200 transition-colors disabled:opacity-50"
        >
          {t('wizard.domains.add')}
        </button>
      </div>
    </div>
  );
}

function ObserveStep() {
  const { t } = useTranslation();
  const { loading, generatedScript } = useWizardStore();

  useEffect(() => {
    if (!useWizardStore.getState().generatedScript) {
      useWizardStore.getState().startObservation();
    }
  }, []);

  useEffect(() => {
    if (generatedScript && !loading) {
      useWizardStore.getState().nextStep();
    }
  }, [generatedScript, loading]);

  return (
    <div className="flex flex-col items-center justify-center py-12 space-y-4">
      <div className="w-10 h-10 border-4 border-blue-200 border-t-blue-500 rounded-full animate-spin" />
      <div className="text-center">
        <p className="text-sm font-medium text-gray-700">{t('wizard.observe.title')}</p>
        <p className="text-xs text-gray-400 mt-1">
          {t('wizard.observe.description')}
        </p>
      </div>
    </div>
  );
}

function ReviewStep() {
  const { t } = useTranslation();
  const { generatedScript, astValid, astErrors, securityPassed, securityReviewDetails } = useWizardStore();

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          {t('wizard.review.generatedScript')}
        </label>
        <div className="flex items-center gap-2 mb-2">
          <StatusBadge label={t('wizard.review.astLabel')} passed={astValid} />
          <StatusBadge label={t('wizard.review.securityLabel')} passed={securityPassed} />
        </div>
      </div>

      <div className="rounded-lg border border-gray-200 bg-gray-50 overflow-hidden">
        <CodeBlock code={generatedScript || t('wizard.review.noScript')} />
      </div>

      {!astValid && astErrors.length > 0 && (
        <div className="px-3 py-2 bg-red-50 text-red-700 text-xs rounded-lg space-y-1">
          <p className="font-medium">{t('wizard.review.astFailed')}</p>
          <ul className="list-disc list-inside space-y-0.5">
            {astErrors.map((err, i) => (
              <li key={i}>{err}</li>
            ))}
          </ul>
        </div>
      )}

      {!securityPassed && (
        <div className="px-3 py-2 bg-yellow-50 text-yellow-700 text-xs rounded-lg space-y-1">
          <p className="font-medium">{t('wizard.review.securityNotPassed')}</p>
          {securityReviewDetails.length > 0 ? (
            <ul className="list-disc list-inside space-y-0.5">
              {securityReviewDetails
                .filter(d => !d.approved)
                .flatMap(d => d.issues.map((issue, i) => (
                  <li key={`${d.model}-${i}`}>{issue}</li>
                )))}
            </ul>
          ) : (
            <p>{t('wizard.review.securityNotApproved')}</p>
          )}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ label, passed }: { label: string; passed: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${
        passed
          ? 'bg-green-100 text-green-700'
          : 'bg-red-100 text-red-700'
      }`}
    >
      {passed ? (
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      ) : (
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
        </svg>
      )}
      {label}
    </span>
  );
}

function TestStep() {
  const { t } = useTranslation();
  const { loading, testResult, runTest } = useWizardStore();

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          {t('wizard.test.label')}
        </label>
        <p className="text-xs text-gray-400 mb-3">
          {t('wizard.test.hint')}
        </p>
      </div>

      {!testResult && !loading && (
        <button
          onClick={runTest}
          className="w-full bg-blue-500 text-white rounded-lg px-4 py-2.5 text-sm font-medium hover:bg-blue-600 transition-colors"
        >
          {t('wizard.test.runTest')}
        </button>
      )}

      {loading && (
        <div className="flex items-center justify-center py-8 space-x-3">
          <div className="w-8 h-8 border-4 border-blue-200 border-t-blue-500 rounded-full animate-spin" />
          <span className="text-sm text-gray-600">{t('wizard.test.running')}</span>
        </div>
      )}

      {testResult && (
        <div
          className={`rounded-lg border p-3 ${
            testResult.success
              ? 'border-green-200 bg-green-50'
              : 'border-red-200 bg-red-50'
          }`}
        >
          <div className="flex items-center gap-2 mb-1">
            {testResult.success ? (
              <svg className="w-5 h-5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            ) : (
              <svg className="w-5 h-5 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            )}
            <span className={`text-sm font-medium ${testResult.success ? 'text-green-700' : 'text-red-700'}`}>
              {testResult.success ? t('wizard.test.passed') : t('wizard.test.failed')}
            </span>
          </div>

          {testResult.error && (
            <pre className="mt-2 text-xs font-mono text-red-600 whitespace-pre-wrap">{testResult.error}</pre>
          )}

          {testResult.result != null && (
            <pre className="mt-2 text-xs font-mono text-gray-600 whitespace-pre-wrap max-h-32 overflow-y-auto">
              {typeof testResult.result === 'string' ? testResult.result : JSON.stringify(testResult.result, null, 2)}
            </pre>
          )}

          <button
            onClick={runTest}
            className="mt-2 text-xs text-blue-500 hover:text-blue-700 transition-colors"
          >
            {t('wizard.test.rerun')}
          </button>
        </div>
      )}
    </div>
  );
}

function ScheduleStep({ onComplete }: { onComplete: () => void }) {
  const { t } = useTranslation();
  const { schedule, setSchedule, loading, createTask } = useWizardStore();
  const [intervalValue, setIntervalValue] = useState(
    schedule.type === 'interval' ? String(schedule.intervalMinutes) : '30'
  );

  const handleCreate = async () => {
    const success = await createTask();
    if (success) {
      onComplete();
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          {t('wizard.schedule.label')}
        </label>
        <p className="text-xs text-gray-400 mb-3">
          {t('wizard.schedule.hint')}
        </p>
      </div>

      <div className="space-y-2">
        <label className="flex items-center gap-3 p-3 rounded-lg border border-gray-200 cursor-pointer hover:bg-gray-50 transition-colors">
          <input
            type="radio"
            name="schedule"
            checked={schedule.type === 'manual'}
            onChange={() => setSchedule({ type: 'manual' })}
            className="w-4 h-4 text-blue-500"
          />
          <div>
            <p className="text-sm font-medium text-gray-700">{t('wizard.schedule.manual')}</p>
            <p className="text-xs text-gray-400">{t('wizard.schedule.manualDescription')}</p>
          </div>
        </label>

        <label className="flex items-start gap-3 p-3 rounded-lg border border-gray-200 cursor-pointer hover:bg-gray-50 transition-colors">
          <input
            type="radio"
            name="schedule"
            checked={schedule.type === 'interval'}
            onChange={() => setSchedule({ type: 'interval', intervalMinutes: Number(intervalValue) || 30 })}
            className="w-4 h-4 text-blue-500 mt-0.5"
          />
          <div className="flex-1">
            <p className="text-sm font-medium text-gray-700">{t('wizard.schedule.interval')}</p>
            <p className="text-xs text-gray-400 mb-2">{t('wizard.schedule.intervalDescription')}</p>
            {schedule.type === 'interval' && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500">{t('wizard.schedule.every')}</span>
                <input
                  type="number"
                  min="1"
                  value={intervalValue}
                  onChange={(e) => {
                    setIntervalValue(e.target.value);
                    const n = Number(e.target.value);
                    if (n > 0) setSchedule({ type: 'interval', intervalMinutes: n });
                  }}
                  className="w-20 rounded border border-gray-300 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
                <span className="text-xs text-gray-500">{t('wizard.schedule.minutes')}</span>
              </div>
            )}
          </div>
        </label>
      </div>

      <button
        onClick={handleCreate}
        disabled={loading}
        className="w-full bg-blue-500 text-white rounded-lg px-4 py-2.5 text-sm font-medium hover:bg-blue-600 transition-colors disabled:opacity-50"
      >
        {loading ? t('wizard.schedule.creating') : t('wizard.schedule.createTask')}
      </button>
    </div>
  );
}
