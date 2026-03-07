interface SettingsPageProps {
  onBack: () => void;
}

export function SettingsPage({ onBack }: SettingsPageProps) {
  return (
    <div className="h-screen bg-white text-gray-900 flex flex-col">
      <div className="flex items-center px-3 py-2.5 border-b border-gray-200">
        <button
          className="p-1 text-gray-500 hover:text-gray-700 transition-colors"
          onClick={onBack}
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18" />
          </svg>
        </button>
        <h1 className="ml-2 text-base font-semibold">Settings</h1>
      </div>
      <main className="flex-1 overflow-y-auto p-4 space-y-6">
        <section>
          <h2 className="text-sm font-semibold text-gray-700 mb-2">LLM Provider</h2>
          <select className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
            <option value="chatgpt-subscription">ChatGPT Subscription</option>
            <option value="openai">OpenAI API</option>
            <option value="anthropic">Anthropic Claude</option>
            <option value="gemini">Google Gemini</option>
            <option value="custom">Custom (OpenAI-compatible)</option>
          </select>
        </section>
        <section>
          <h2 className="text-sm font-semibold text-gray-700 mb-2">Domain Permissions</h2>
          <p className="text-xs text-gray-400">No domains configured</p>
        </section>
        <section>
          <h2 className="text-sm font-semibold text-gray-700 mb-2">Advanced</h2>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="rounded" />
            <span>YOLO Mode (auto-approve domain requests)</span>
          </label>
        </section>
      </main>
    </div>
  );
}
