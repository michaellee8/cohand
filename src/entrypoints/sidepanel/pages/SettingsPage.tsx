import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18next from 'i18next';
import { useSettingsStore } from '../stores/settings-store';
import { UsageStats } from '../components/UsageStats';
import {
  exportTask,
  downloadBundle,
  validateImport,
  prepareForImport,
  type TaskExportBundle,
} from '../../../lib/export-import';
import type { Task, ScriptVersion, TaskState } from '../../../types';
import type { SupportedLocale } from '../../../i18n';

interface SettingsPageProps {
  onBack: () => void;
}

export function SettingsPage({ onBack }: SettingsPageProps) {
  const { t } = useTranslation();
  const {
    settings, domainPermissions, hasApiKey, loading, saving, error: storeError,
    codexConnected, codexAccountId,
    updateSettings, saveApiKey, clearApiKey, addDomain, removeDomain,
    startCodexLogin, logoutCodex, importCodexAuth,
  } = useSettingsStore();

  const [apiKeyInput, setApiKeyInput] = useState('');
  const [domainInput, setDomainInput] = useState('');
  const [showYoloWarning, setShowYoloWarning] = useState(false);
  const [showPasteJson, setShowPasteJson] = useState(false);
  const [pasteJsonInput, setPasteJsonInput] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [taskImportError, setTaskImportError] = useState<string | null>(null);
  const [taskImportSuccess, setTaskImportSuccess] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const taskImportRef = useRef<HTMLInputElement>(null);

  useEffect(() => { useSettingsStore.getState().load(); }, []);

  if (loading && !settings) {
    return (
      <div className="h-screen flex items-center justify-center text-gray-400 text-sm">
        {t('settings.loadingSettings')}
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="h-screen flex flex-col items-center justify-center gap-3 p-4">
        <p className="text-sm text-red-600">{t('settings.failedToLoad')}</p>
        <button
          onClick={() => useSettingsStore.getState().load()}
          className="text-sm text-blue-500 hover:text-blue-700"
        >
          {t('settings.retry')}
        </button>
      </div>
    );
  }

  const needsApiKey = settings.llmProvider !== 'chatgpt-subscription';
  const needsBaseUrl = settings.llmProvider === 'custom';

  const handleLanguageChange = async (lng: SupportedLocale) => {
    await i18next.changeLanguage(lng);
    updateSettings({ language: lng });
  };

  const handleExportTasks = async () => {
    setExportStatus(null);
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_TASKS' });
      const tasks: Task[] = response.tasks || [];
      if (tasks.length === 0) {
        setExportStatus('No tasks to export.');
        return;
      }
      let exportedCount = 0;
      for (const task of tasks) {
        const versionsResp = await chrome.runtime.sendMessage({ type: 'GET_SCRIPT_VERSIONS', taskId: task.id });
        const scripts: ScriptVersion[] = versionsResp.versions || [];
        const stateResp = await chrome.runtime.sendMessage({ type: 'GET_TASK_STATE', taskId: task.id });
        const state: TaskState | undefined = stateResp.state;
        const bundle = exportTask(task, scripts, state, false);
        downloadBundle(bundle);
        exportedCount++;
      }
      setExportStatus(`Exported ${exportedCount} task${exportedCount !== 1 ? 's' : ''}.`);
    } catch (err: unknown) {
      setExportStatus(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleImportTask = async (file: File) => {
    setTaskImportError(null);
    setTaskImportSuccess(null);
    try {
      const json = await file.text();

      // Validate
      const validation = await validateImport(json);
      if (!validation.valid) {
        setTaskImportError(`Validation failed: ${validation.errors.join('; ')}`);
        return;
      }

      // Prepare (reset IDs, security flags)
      const rawBundle: TaskExportBundle = JSON.parse(json);
      const prepared = prepareForImport(rawBundle);

      // Save task via service worker
      const latestScript = prepared.scripts.length > 0
        ? prepared.scripts[prepared.scripts.length - 1]
        : null;

      await chrome.runtime.sendMessage({
        type: 'CREATE_TASK',
        task: prepared.task,
        scriptSource: latestScript?.source,
        astValidationPassed: latestScript?.astValidationPassed ?? false,
        securityReviewPassed: false, // Always require re-review for imports
      });

      const warnings = validation.warnings.length > 0
        ? ` Warnings: ${validation.warnings.join('; ')}`
        : '';
      setTaskImportSuccess(`Imported "${prepared.task.name}" successfully.${warnings}`);
    } catch (err: unknown) {
      setTaskImportError(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className="h-screen bg-white text-gray-900 flex flex-col">
      <div className="flex items-center px-3 py-2.5 border-b border-gray-200">
        <button className="p-1 text-gray-500 hover:text-gray-700" onClick={onBack} aria-label={t('settings.backAriaLabel')}>
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18" />
          </svg>
        </button>
        <h1 className="ml-2 text-base font-semibold">{t('settings.title')}</h1>
        {saving && <span className="ml-auto text-xs text-gray-400">{t('settings.saving')}</span>}
      </div>

      {storeError && (
        <div className="mx-4 mt-2 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-700">
          {storeError}
        </div>
      )}
      <main className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* LLM Provider */}
        <section>
          <h2 className="text-sm font-semibold text-gray-700 mb-2">{t('settings.llmProvider')}</h2>
          <select
            value={settings.llmProvider}
            onChange={(e) => updateSettings({ llmProvider: e.target.value as any })}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="chatgpt-subscription">{t('settings.chatgptSubscription')}</option>
            <option value="openai">{t('settings.openaiApi')}</option>
            <option value="anthropic">{t('settings.anthropicClaude')}</option>
            <option value="gemini">{t('settings.googleGemini')}</option>
            <option value="custom">{t('settings.customProvider')}</option>
          </select>
        </section>

        {/* Model */}
        <section>
          <h2 className="text-sm font-semibold text-gray-700 mb-2">{t('settings.model')}</h2>
          <input
            type="text"
            value={settings.llmModel}
            onChange={(e) => updateSettings({ llmModel: e.target.value })}
            placeholder={t('settings.modelPlaceholder')}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </section>

        {/* Base URL (custom provider) */}
        {needsBaseUrl && (
          <section>
            <h2 className="text-sm font-semibold text-gray-700 mb-2">{t('settings.baseUrl')}</h2>
            <input
              type="url"
              value={settings.llmBaseUrl || ''}
              onChange={(e) => updateSettings({ llmBaseUrl: e.target.value || undefined })}
              placeholder={t('settings.baseUrlPlaceholder')}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </section>
        )}

        {/* API Key */}
        {needsApiKey && (
          <section>
            <h2 className="text-sm font-semibold text-gray-700 mb-2">{t('settings.apiKey')}</h2>
            {hasApiKey ? (
              <div className="flex items-center gap-2">
                <span className="text-sm text-green-600">{t('settings.keyConfigured')}</span>
                <button onClick={clearApiKey} className="text-xs text-red-500 hover:text-red-700">{t('settings.removeKey')}</button>
              </div>
            ) : (
              <div className="flex gap-2">
                <input
                  type="password"
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  placeholder={t('settings.apiKeyPlaceholder')}
                  className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button
                  onClick={() => { saveApiKey(apiKeyInput); setApiKeyInput(''); }}
                  disabled={!apiKeyInput}
                  className="bg-blue-500 text-white rounded-lg px-3 py-2 text-sm disabled:opacity-50"
                >
                  {t('settings.save')}
                </button>
              </div>
            )}
          </section>
        )}

        {/* ChatGPT Account */}
        {settings.llmProvider === 'chatgpt-subscription' && (
          <section>
            <h2 className="text-sm font-semibold text-gray-700 mb-2">{t('settings.chatgptAccount')}</h2>
            {codexConnected ? (
              <div className="flex items-center gap-2">
                <span className="text-sm text-green-600">{t('settings.connected')}{codexAccountId ? ` (${codexAccountId})` : ''}</span>
                <button onClick={logoutCodex} className="text-xs text-red-500 hover:text-red-700">{t('settings.logout')}</button>
              </div>
            ) : (
              <div className="space-y-3">
                <button
                  onClick={startCodexLogin}
                  className="w-full bg-green-500 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-green-600"
                >
                  {t('settings.loginWithChatGPT')}
                </button>
                <p className="text-xs text-gray-400 mt-1 text-center">
                  {t('settings.loginBlockedHint')}
                </p>

                <div className="flex items-center gap-2 text-xs text-gray-400">
                  <div className="flex-1 border-t border-gray-200" />
                  <span>{t('settings.or')}</span>
                  <div className="flex-1 border-t border-gray-200" />
                </div>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json"
                  className="hidden"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    try {
                      setImportError(null);
                      const text = await file.text();
                      await importCodexAuth(text);
                    } catch (err: unknown) {
                      setImportError(err instanceof Error ? err.message : String(err));
                    }
                    e.target.value = '';
                  }}
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full text-sm text-blue-600 hover:text-blue-800"
                >
                  {t('settings.importFromFile')}
                </button>

                {importError && (
                  <div className="px-3 py-2 bg-red-50 text-red-600 text-xs rounded-lg">
                    {importError}
                  </div>
                )}

                {!showPasteJson ? (
                  <button
                    onClick={() => setShowPasteJson(true)}
                    className="w-full text-xs text-gray-400 hover:text-gray-600"
                  >
                    {t('settings.pasteJsonManually')}
                  </button>
                ) : (
                  <div className="space-y-2">
                    <textarea
                      value={pasteJsonInput}
                      onChange={(e) => setPasteJsonInput(e.target.value)}
                      placeholder={t('settings.pasteJsonPlaceholder')}
                      rows={4}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={() => { setShowPasteJson(false); setPasteJsonInput(''); }}
                        className="flex-1 text-xs text-gray-500 hover:text-gray-700 py-1"
                      >
                        {t('settings.cancelPaste')}
                      </button>
                      <button
                        onClick={async () => {
                          try {
                            setImportError(null);
                            await importCodexAuth(pasteJsonInput);
                            setPasteJsonInput('');
                            setShowPasteJson(false);
                          } catch (err: unknown) {
                            setImportError(err instanceof Error ? err.message : String(err));
                          }
                        }}
                        disabled={!pasteJsonInput.trim()}
                        className="flex-1 bg-blue-500 text-white rounded-lg py-1 text-xs disabled:opacity-50"
                      >
                        {t('settings.import')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {/* Domain Permissions */}
        <section>
          <h2 className="text-sm font-semibold text-gray-700 mb-2">{t('settings.domainPermissions')}</h2>
          <div className="space-y-1 mb-2">
            {domainPermissions.length === 0 ? (
              <p className="text-xs text-gray-400">{t('settings.noDomains')}</p>
            ) : (
              domainPermissions.map(p => (
                <div key={p.domain} className="flex items-center justify-between text-sm p-1.5 bg-gray-50 rounded">
                  <span>{p.domain}</span>
                  <button onClick={() => removeDomain(p.domain)} className="text-xs text-red-500">{t('settings.removeDomain')}</button>
                </div>
              ))
            )}
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={domainInput}
              onChange={(e) => setDomainInput(e.target.value)}
              placeholder={t('settings.domainPlaceholder')}
              className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && domainInput.trim()) {
                  addDomain(domainInput.trim());
                  setDomainInput('');
                }
              }}
            />
            <button
              onClick={() => { addDomain(domainInput.trim()); setDomainInput(''); }}
              disabled={!domainInput.trim()}
              className="bg-gray-100 text-gray-700 rounded-lg px-3 py-2 text-sm disabled:opacity-50"
            >
              {t('settings.addDomain')}
            </button>
          </div>
        </section>

        {/* Export / Import Tasks */}
        <section>
          <h2 className="text-sm font-semibold text-gray-700 mb-2">{t('settings.exportImportTasks')}</h2>
          <div className="space-y-2">
            <button
              onClick={handleExportTasks}
              className="w-full bg-gray-100 text-gray-700 rounded-lg px-4 py-2 text-sm font-medium hover:bg-gray-200 transition-colors"
            >
              {t('settings.exportAllTasks')}
            </button>
            {exportStatus && (
              <p className="text-xs text-gray-500">{exportStatus}</p>
            )}

            <input
              ref={taskImportRef}
              type="file"
              accept=".json"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                await handleImportTask(file);
                e.target.value = '';
              }}
            />
            <button
              onClick={() => taskImportRef.current?.click()}
              className="w-full bg-gray-100 text-gray-700 rounded-lg px-4 py-2 text-sm font-medium hover:bg-gray-200 transition-colors"
            >
              {t('settings.importTask')}
            </button>
            {taskImportError && (
              <div className="px-3 py-2 bg-red-50 text-red-600 text-xs rounded-lg">
                {taskImportError}
              </div>
            )}
            {taskImportSuccess && (
              <div className="px-3 py-2 bg-green-50 text-green-600 text-xs rounded-lg">
                {taskImportSuccess}
              </div>
            )}
          </div>
        </section>

        {/* LLM Usage Stats */}
        <section>
          <h2 className="text-sm font-semibold text-gray-700 mb-2">{t('settings.llmUsage')}</h2>
          <UsageStats />
        </section>

        {/* YOLO Mode */}
        <section>
          <h2 className="text-sm font-semibold text-gray-700 mb-2">{t('settings.advanced')}</h2>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={settings.yoloMode}
              onChange={(e) => {
                if (e.target.checked && !settings.yoloMode) {
                  setShowYoloWarning(true);
                } else {
                  updateSettings({ yoloMode: false });
                }
              }}
              className="rounded"
            />
            <span>{t('settings.yoloMode')}</span>
          </label>
          {showYoloWarning && (
            <div className="mt-2 p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
              <p className="text-xs text-yellow-800">
                {t('settings.yoloWarning')}
              </p>
              <div className="flex gap-2 mt-2">
                <button
                  onClick={() => { updateSettings({ yoloMode: true }); setShowYoloWarning(false); }}
                  className="text-xs bg-yellow-500 text-white rounded px-2 py-1"
                >
                  {t('settings.enable')}
                </button>
                <button
                  onClick={() => setShowYoloWarning(false)}
                  className="text-xs text-gray-500"
                >
                  {t('settings.cancelYolo')}
                </button>
              </div>
            </div>
          )}
        </section>

        {/* Language */}
        <section>
          <h2 className="text-sm font-semibold text-gray-700 mb-2">{t('settings.language')}</h2>
          <select
            value={settings.language}
            onChange={(e) => handleLanguageChange(e.target.value as SupportedLocale)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="en">English</option>
            <option value="zh-TW">{'\u7E41\u9AD4\u4E2D\u6587'}</option>
            <option value="zh-CN">{'\u7B80\u4F53\u4E2D\u6587'}</option>
          </select>
        </section>
      </main>
    </div>
  );
}
