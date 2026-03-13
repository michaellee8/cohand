// src/entrypoints/sidepanel/components/RecordingStartModal.tsx
import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useRecordingStore } from '../stores/recording-store';
import { checkMicPermission, requestMicPermission } from '../../../lib/recording/speech';

interface Props {
  onClose: () => void;
}

export function RecordingStartModal({ onClose }: Props) {
  const { t } = useTranslation();
  const { startRecording } = useRecordingStore();
  const [micState, setMicState] = useState<PermissionState>('prompt');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    checkMicPermission().then(setMicState).catch(() => {});
  }, []);

  const handleStart = async () => {
    setStarting(true);
    setError(null);
    try {
      // Find the active non-extension tab to record.
      // Filter out chrome-extension:// pages (e.g. side panel opened as tab in tests).
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs.find(t => t.url && !t.url.startsWith('chrome-extension://')) ?? tabs[0];
      if (!tab?.id) throw new Error('No active tab');
      await startRecording(tab.id);
      onClose();
    } catch (err: unknown) {
      setStarting(false);
      setError(err instanceof Error ? err.message : t('recording.failedToStart'));
    }
  };

  const handleRequestMic = async () => {
    const granted = await requestMicPermission();
    setMicState(granted ? 'granted' : 'denied');
  };

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-2">{t('recording.title')}</h2>
        <p className="text-sm text-gray-600 mb-4">
          {t('recording.description')}
        </p>

        {micState === 'denied' && (
          <div className="text-xs text-amber-600 bg-amber-50 rounded-lg p-2 mb-3">
            {t('recording.micDenied')}
          </div>
        )}

        {micState === 'prompt' && (
          <button onClick={handleRequestMic} className="w-full text-sm text-blue-600 hover:text-blue-800 mb-3">
            {t('recording.enableMic')}
          </button>
        )}

        {error && (
          <div className="text-xs text-red-600 bg-red-50 rounded-lg p-2 mb-3">
            {error}
          </div>
        )}

        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 text-sm text-gray-500 hover:text-gray-700 py-2">
            {t('recording.cancel')}
          </button>
          <button
            onClick={handleStart}
            disabled={starting}
            className="flex-1 bg-blue-500 text-white rounded-lg py-2 text-sm font-medium hover:bg-blue-600 disabled:opacity-50"
          >
            {starting ? t('recording.starting') : t('recording.startRecording')}
          </button>
        </div>
      </div>
    </div>
  );
}
