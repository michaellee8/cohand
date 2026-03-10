// src/entrypoints/sidepanel/components/RecordingStartModal.tsx
import { useState, useEffect } from 'react';
import { useRecordingStore } from '../stores/recording-store';
import { checkMicPermission, requestMicPermission } from '../../../lib/recording/speech';

interface Props {
  onClose: () => void;
}

export function RecordingStartModal({ onClose }: Props) {
  const { startRecording } = useRecordingStore();
  const [micState, setMicState] = useState<PermissionState>('prompt');
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    checkMicPermission().then(setMicState).catch(() => {});
  }, []);

  const handleStart = async () => {
    setStarting(true);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('No active tab');
      await startRecording(tab.id);
      onClose();
    } catch {
      setStarting(false);
    }
  };

  const handleRequestMic = async () => {
    const granted = await requestMicPermission();
    setMicState(granted ? 'granted' : 'denied');
  };

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-2">Teach Cohand your workflow</h2>
        <p className="text-sm text-gray-600 mb-4">
          Go through the steps as if you're teaching a new teammate.
          Cohand will learn the process and repeat it for you.
        </p>

        {micState === 'denied' && (
          <div className="text-xs text-amber-600 bg-amber-50 rounded-lg p-2 mb-3">
            Recording without voice narration (microphone denied)
          </div>
        )}

        {micState === 'prompt' && (
          <button onClick={handleRequestMic} className="w-full text-sm text-blue-600 hover:text-blue-800 mb-3">
            Enable microphone for voice narration
          </button>
        )}

        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 text-sm text-gray-500 hover:text-gray-700 py-2">
            Cancel
          </button>
          <button
            onClick={handleStart}
            disabled={starting}
            className="flex-1 bg-blue-500 text-white rounded-lg py-2 text-sm font-medium hover:bg-blue-600 disabled:opacity-50"
          >
            {starting ? 'Starting...' : 'Start recording'}
          </button>
        </div>
      </div>
    </div>
  );
}
