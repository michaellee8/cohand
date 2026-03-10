// src/entrypoints/sidepanel/components/RecordingToolbar.tsx
import { useEffect, useState } from 'react';
import { useRecordingStore } from '../stores/recording-store';

export function RecordingToolbar() {
  const { isRecording, isPaused, voiceEnabled, session, stopRecording, togglePause, toggleVoice } = useRecordingStore();
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!isRecording || isPaused) return;
    const start = session?.startedAt ? new Date(session.startedAt).getTime() : Date.now();
    const interval = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(interval);
  }, [isRecording, isPaused, session?.startedAt]);

  if (!isRecording) return null;

  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  const stepCount = session?.steps.length ?? 0;

  return (
    <div className="flex items-center gap-3 px-3 py-2 bg-red-50 border-t border-red-200">
      <span className="relative flex h-3 w-3">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
        <span className="relative inline-flex rounded-full h-3 w-3 bg-red-500" />
      </span>
      <span className="text-sm font-mono text-red-700">
        {String(mins).padStart(2, '0')}:{String(secs).padStart(2, '0')}
      </span>
      <span className="text-xs text-red-600 bg-red-100 rounded-full px-2 py-0.5">
        {stepCount} step{stepCount !== 1 ? 's' : ''}
      </span>
      <div className="flex-1" />
      <button onClick={togglePause} className="text-sm text-red-600 hover:text-red-800" title={isPaused ? 'Resume' : 'Pause'}>
        {isPaused ? '▶' : '⏸'}
      </button>
      <button onClick={toggleVoice} className={`text-sm ${voiceEnabled ? 'text-red-600' : 'text-gray-400'} hover:text-red-800`} title="Toggle voice">
        🎤
      </button>
      <button onClick={stopRecording} className="bg-red-500 text-white text-sm rounded-lg px-3 py-1 hover:bg-red-600">
        Stop
      </button>
    </div>
  );
}
