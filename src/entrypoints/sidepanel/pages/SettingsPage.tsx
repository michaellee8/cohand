import { useEffect, useRef, useState } from 'react';
import { useSettingsStore } from '../stores/settings-store';

interface SettingsPageProps {
  onBack: () => void;
}

export function SettingsPage({ onBack }: SettingsPageProps) {
  const {
    settings, domainPermissions, hasApiKey, loading, saving,
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
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { useSettingsStore.getState().load(); }, []);

  if (loading || !settings) {
    return (
      <div className="h-screen flex items-center justify-center text-gray-400 text-sm">
        Loading settings...
      </div>
    );
  }

  const needsApiKey = settings.llmProvider !== 'chatgpt-subscription';
  const needsBaseUrl = settings.llmProvider === 'custom';

  return (
    <div className="h-screen bg-white text-gray-900 flex flex-col">
      <div className="flex items-center px-3 py-2.5 border-b border-gray-200">
        <button className="p-1 text-gray-500 hover:text-gray-700" onClick={onBack}>
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18" />
          </svg>
        </button>
        <h1 className="ml-2 text-base font-semibold">Settings</h1>
        {saving && <span className="ml-auto text-xs text-gray-400">Saving...</span>}
      </div>

      <main className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* LLM Provider */}
        <section>
          <h2 className="text-sm font-semibold text-gray-700 mb-2">LLM Provider</h2>
          <select
            value={settings.llmProvider}
            onChange={(e) => updateSettings({ llmProvider: e.target.value as any })}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="chatgpt-subscription">ChatGPT Subscription</option>
            <option value="openai">OpenAI API</option>
            <option value="anthropic">Anthropic Claude</option>
            <option value="gemini">Google Gemini</option>
            <option value="custom">Custom (OpenAI-compatible)</option>
          </select>
        </section>

        {/* Model */}
        <section>
          <h2 className="text-sm font-semibold text-gray-700 mb-2">Model</h2>
          <input
            type="text"
            value={settings.llmModel}
            onChange={(e) => updateSettings({ llmModel: e.target.value })}
            placeholder="e.g., gpt-5.4"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </section>

        {/* Base URL (custom provider) */}
        {needsBaseUrl && (
          <section>
            <h2 className="text-sm font-semibold text-gray-700 mb-2">Base URL</h2>
            <input
              type="url"
              value={settings.llmBaseUrl || ''}
              onChange={(e) => updateSettings({ llmBaseUrl: e.target.value || undefined })}
              placeholder="https://api.example.com/v1"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </section>
        )}

        {/* API Key */}
        {needsApiKey && (
          <section>
            <h2 className="text-sm font-semibold text-gray-700 mb-2">API Key</h2>
            {hasApiKey ? (
              <div className="flex items-center gap-2">
                <span className="text-sm text-green-600">Key configured</span>
                <button onClick={clearApiKey} className="text-xs text-red-500 hover:text-red-700">Remove</button>
              </div>
            ) : (
              <div className="flex gap-2">
                <input
                  type="password"
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  placeholder="sk-..."
                  className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button
                  onClick={() => { saveApiKey(apiKeyInput); setApiKeyInput(''); }}
                  disabled={!apiKeyInput}
                  className="bg-blue-500 text-white rounded-lg px-3 py-2 text-sm disabled:opacity-50"
                >
                  Save
                </button>
              </div>
            )}
          </section>
        )}

        {/* ChatGPT Account */}
        {settings.llmProvider === 'chatgpt-subscription' && (
          <section>
            <h2 className="text-sm font-semibold text-gray-700 mb-2">ChatGPT Account</h2>
            {codexConnected ? (
              <div className="flex items-center gap-2">
                <span className="text-sm text-green-600">Connected{codexAccountId ? ` (${codexAccountId})` : ''}</span>
                <button onClick={logoutCodex} className="text-xs text-red-500 hover:text-red-700">Logout</button>
              </div>
            ) : (
              <div className="space-y-3">
                <button
                  onClick={startCodexLogin}
                  className="w-full bg-green-500 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-green-600"
                >
                  Login with ChatGPT
                </button>

                <div className="flex items-center gap-2 text-xs text-gray-400">
                  <div className="flex-1 border-t border-gray-200" />
                  <span>or</span>
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
                    } catch (err: any) {
                      setImportError(err?.message ?? String(err));
                    }
                    e.target.value = '';
                  }}
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full text-sm text-blue-600 hover:text-blue-800"
                >
                  Import from ~/.codex/auth.json
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
                    Paste JSON manually
                  </button>
                ) : (
                  <div className="space-y-2">
                    <textarea
                      value={pasteJsonInput}
                      onChange={(e) => setPasteJsonInput(e.target.value)}
                      placeholder='Paste contents of ~/.codex/auth.json...'
                      rows={4}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={() => { setShowPasteJson(false); setPasteJsonInput(''); }}
                        className="flex-1 text-xs text-gray-500 hover:text-gray-700 py-1"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={async () => {
                          try {
                            setImportError(null);
                            await importCodexAuth(pasteJsonInput);
                            setPasteJsonInput('');
                            setShowPasteJson(false);
                          } catch (err: any) {
                            setImportError(err?.message ?? String(err));
                          }
                        }}
                        disabled={!pasteJsonInput.trim()}
                        className="flex-1 bg-blue-500 text-white rounded-lg py-1 text-xs disabled:opacity-50"
                      >
                        Import
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
          <h2 className="text-sm font-semibold text-gray-700 mb-2">Domain Permissions</h2>
          <div className="space-y-1 mb-2">
            {domainPermissions.length === 0 ? (
              <p className="text-xs text-gray-400">No domains configured</p>
            ) : (
              domainPermissions.map(p => (
                <div key={p.domain} className="flex items-center justify-between text-sm p-1.5 bg-gray-50 rounded">
                  <span>{p.domain}</span>
                  <button onClick={() => removeDomain(p.domain)} className="text-xs text-red-500">Remove</button>
                </div>
              ))
            )}
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={domainInput}
              onChange={(e) => setDomainInput(e.target.value)}
              placeholder="example.com"
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
              Add
            </button>
          </div>
        </section>

        {/* YOLO Mode */}
        <section>
          <h2 className="text-sm font-semibold text-gray-700 mb-2">Advanced</h2>
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
            <span>YOLO Mode (auto-approve domain requests)</span>
          </label>
          {showYoloWarning && (
            <div className="mt-2 p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
              <p className="text-xs text-yellow-800">
                YOLO mode will automatically approve domain access for all tasks without asking.
                This does NOT bypass security review of scripts.
              </p>
              <div className="flex gap-2 mt-2">
                <button
                  onClick={() => { updateSettings({ yoloMode: true }); setShowYoloWarning(false); }}
                  className="text-xs bg-yellow-500 text-white rounded px-2 py-1"
                >
                  Enable
                </button>
                <button
                  onClick={() => setShowYoloWarning(false)}
                  className="text-xs text-gray-500"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </section>

        {/* Language */}
        <section>
          <h2 className="text-sm font-semibold text-gray-700 mb-2">Language</h2>
          <input
            type="text"
            value={settings.language}
            onChange={(e) => updateSettings({ language: e.target.value })}
            placeholder="en"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </section>
      </main>
    </div>
  );
}
