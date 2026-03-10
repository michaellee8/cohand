// src/entrypoints/sidepanel/components/LiveStepList.tsx
import { useEffect, useRef } from 'react';
import { useRecordingStore } from '../stores/recording-store';

const ACTION_ICONS: Record<string, string> = {
  click: '🖱️',
  type: '⌨️',
  navigate: '🌐',
  narration: '🎤',
};

export function LiveStepList() {
  const { session, removeStep } = useRecordingStore();
  const endRef = useRef<HTMLDivElement>(null);
  const steps = session?.steps ?? [];

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [steps.length]);

  if (!steps.length) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
        Interact with the page to capture steps...
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-3 space-y-2">
      {steps.map((step, i) => (
        <div
          key={step.id}
          className="group flex items-start gap-2 p-2 bg-gray-50 rounded-lg animate-[slideIn_0.2s_ease-out]"
        >
          <span className="text-base mt-0.5">{ACTION_ICONS[step.action] ?? '❓'}</span>
          <div className="flex-1 min-w-0">
            <span className="text-xs text-gray-400 mr-1">{i + 1}.</span>
            <span className="text-sm text-gray-800">
              {step.description ?? (
                <span className="inline-block bg-gray-200 rounded h-4 w-32 animate-pulse" />
              )}
            </span>
            {step.selector && (
              <div className="text-xs text-gray-400 truncate font-mono mt-0.5">{step.selector}</div>
            )}
          </div>
          <button
            onClick={() => removeStep(step.id)}
            className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 text-xs p-1 transition-opacity"
            title="Remove step"
          >
            ✕
          </button>
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}
