import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { Task, ScriptRun, ScriptVersion, TaskState } from '../../../types';

// ---------------------------------------------------------------------------
// Simple line-by-line diff
// ---------------------------------------------------------------------------

interface DiffLine {
  type: 'added' | 'removed' | 'unchanged';
  content: string;
  lineNum?: number;
}

function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const result: DiffLine[] = [];

  // Simple LCS-based diff
  const m = oldLines.length;
  const n = newLines.length;

  // Build LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to produce diff
  const diffOps: Array<{ type: 'added' | 'removed' | 'unchanged'; line: string }> = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      diffOps.unshift({ type: 'unchanged', line: oldLines[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      diffOps.unshift({ type: 'added', line: newLines[j - 1] });
      j--;
    } else {
      diffOps.unshift({ type: 'removed', line: oldLines[i - 1] });
      i--;
    }
  }

  let lineNum = 1;
  for (const op of diffOps) {
    result.push({ type: op.type, content: op.line, lineNum: op.type !== 'removed' ? lineNum++ : undefined });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function CollapsibleSection({
  title,
  defaultOpen = false,
  badge,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  badge?: string | number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      <button
        className="w-full flex items-center justify-between px-3 py-2 text-sm font-medium bg-gray-50 hover:bg-gray-100 transition-colors text-left"
        onClick={() => setOpen(!open)}
      >
        <span className="flex items-center gap-2">
          <svg
            className={`w-3.5 h-3.5 text-gray-400 transition-transform ${open ? 'rotate-90' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="m9 5 7 7-7 7" />
          </svg>
          {title}
        </span>
        {badge !== undefined && (
          <span className="text-xs bg-gray-200 text-gray-600 rounded-full px-2 py-0.5">{badge}</span>
        )}
      </button>
      {open && <div className="px-3 py-2">{children}</div>}
    </div>
  );
}

function DiffView({ oldSource, newSource }: { oldSource: string; newSource: string }) {
  const { t } = useTranslation();
  const lines = useMemo(() => computeLineDiff(oldSource, newSource), [oldSource, newSource]);

  if (oldSource === newSource) {
    return <p className="text-xs text-gray-400 italic py-2">{t('taskDetail.noDifferences')}</p>;
  }

  return (
    <div className="max-h-64 overflow-auto rounded border border-gray-200">
      <pre className="text-[11px] font-mono leading-relaxed">
        {lines.map((line, idx) => (
          <div
            key={idx}
            className={
              line.type === 'added'
                ? 'bg-green-50 text-green-800'
                : line.type === 'removed'
                  ? 'bg-red-50 text-red-800'
                  : 'text-gray-600'
            }
          >
            <span className="inline-block w-5 text-right mr-2 select-none text-gray-400">
              {line.lineNum ?? ' '}
            </span>
            <span className="inline-block w-3 select-none">
              {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
            </span>
            {line.content}
          </div>
        ))}
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Script Versions Section
// ---------------------------------------------------------------------------

function ScriptVersionsSection({
  versions,
  activeVersion,
  onRevert,
}: {
  versions: ScriptVersion[];
  activeVersion: number;
  onRevert: (version: number) => void;
}) {
  const { t } = useTranslation();
  const [selectedVersionNum, setSelectedVersionNum] = useState<number | null>(null);
  const sorted = useMemo(
    () => [...versions].sort((a, b) => b.version - a.version),
    [versions],
  );

  const activeScript = sorted.find(v => v.version === activeVersion);
  const selectedScript = sorted.find(v => v.version === selectedVersionNum);

  return (
    <div className="space-y-2">
      {sorted.length === 0 ? (
        <p className="text-xs text-gray-400">{t('taskDetail.noVersions')}</p>
      ) : (
        <div className="space-y-1">
          {sorted.map(sv => {
            const isActive = sv.version === activeVersion;
            const isSelected = sv.version === selectedVersionNum;
            return (
              <div
                key={sv.id}
                onClick={() => setSelectedVersionNum(isSelected ? null : sv.version)}
                className={`text-xs rounded p-2 cursor-pointer transition-colors ${
                  isActive
                    ? 'bg-blue-50 border border-blue-200'
                    : isSelected
                      ? 'bg-gray-100 border border-gray-300'
                      : 'bg-gray-50 border border-transparent hover:border-gray-200'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">v{sv.version}</span>
                    {isActive && (
                      <span className="text-[10px] bg-blue-500 text-white rounded px-1.5 py-0.5">
                        {t('taskDetail.active')}
                      </span>
                    )}
                    <span className="text-gray-400">{sv.generatedBy}</span>
                  </div>
                  <span className="text-gray-400">
                    {new Date(sv.createdAt).toLocaleDateString()}
                  </span>
                </div>
                <div className="mt-1 text-[11px] text-gray-400 font-mono truncate">
                  {sv.checksum.slice(0, 16)}...
                </div>

                {isSelected && !isActive && (
                  <div className="mt-2 space-y-2">
                    {activeScript && (
                      <DiffView oldSource={activeScript.source} newSource={sv.source} />
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); onRevert(sv.version); }}
                      className="text-xs bg-amber-500 text-white rounded px-2.5 py-1 hover:bg-amber-600 transition-colors"
                    >
                      {t('taskDetail.revertTo', { version: sv.version })}
                    </button>
                  </div>
                )}

                {isSelected && isActive && (
                  <div className="mt-2">
                    <pre className="text-[11px] font-mono bg-white rounded border border-gray-200 p-2 max-h-48 overflow-auto whitespace-pre-wrap">
                      {sv.source}
                    </pre>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// State Inspector Section
// ---------------------------------------------------------------------------

function StateInspectorSection({ taskState }: { taskState?: TaskState }) {
  const { t } = useTranslation();

  if (!taskState) {
    return <p className="text-xs text-gray-400">{t('taskDetail.noState')}</p>;
  }

  const stateJson = JSON.stringify(taskState.state, null, 2);
  const sizeBytes = new Blob([JSON.stringify(taskState.state)]).size;
  const sizeLabel =
    sizeBytes < 1024
      ? `${sizeBytes} B`
      : sizeBytes < 1024 * 1024
        ? `${(sizeBytes / 1024).toFixed(1)} KB`
        : `${(sizeBytes / (1024 * 1024)).toFixed(2)} MB`;

  const sizePercent = Math.min(100, (sizeBytes / (1024 * 1024)) * 100);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-gray-500">
        <span>
          {t('taskDetail.lastUpdated')}{' '}
          {new Date(taskState.updatedAt).toLocaleString()}
        </span>
        <span className="flex items-center gap-1.5">
          <span>{sizeLabel}</span>
          <div className="w-16 h-1.5 bg-gray-200 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full ${
                sizePercent > 80 ? 'bg-red-500' : sizePercent > 50 ? 'bg-amber-500' : 'bg-green-500'
              }`}
              style={{ width: `${sizePercent}%` }}
            />
          </div>
        </span>
      </div>
      <pre className="text-[11px] font-mono bg-gray-50 rounded border border-gray-200 p-2 max-h-64 overflow-auto whitespace-pre-wrap break-words">
        {stateJson}
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TaskDetail (main)
// ---------------------------------------------------------------------------

interface TaskDetailProps {
  task: Task;
  runs: ScriptRun[];
  scriptVersions?: ScriptVersion[];
  taskState?: TaskState;
  onClose: () => void;
  onDelete: (taskId: string) => void;
  onRevertVersion?: (taskId: string, version: number) => void;
  onUpdateTask?: (task: Task) => void;
}

export function TaskDetail({
  task,
  runs,
  scriptVersions = [],
  taskState,
  onClose,
  onDelete,
  onRevertVersion,
  onUpdateTask,
}: TaskDetailProps) {
  const { t } = useTranslation();

  const handleRevert = (version: number) => {
    if (onRevertVersion) {
      onRevertVersion(task.id, version);
    }
  };

  const handleToggleNotify = () => {
    if (onUpdateTask) {
      onUpdateTask({
        ...task,
        notifyEnabled: !task.notifyEnabled,
        updatedAt: new Date().toISOString(),
      });
    }
  };

  const scheduleDisplay = task.schedule.type === 'interval'
    ? t('taskDetail.scheduleInterval', { minutes: task.schedule.intervalMinutes })
    : t('taskDetail.scheduleManual');

  return (
    <div className="p-4 space-y-4 overflow-y-auto h-full">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">{task.name}</h2>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <p className="text-sm text-gray-600">{task.description}</p>

      <div className="space-y-1">
        <h3 className="text-sm font-medium">{t('taskDetail.details')}</h3>
        <div className="text-xs text-gray-500 space-y-0.5">
          <p>{t('taskDetail.domains', { domains: task.allowedDomains.join(', ') })}</p>
          <p>{t('taskDetail.activeVersion', { version: task.activeScriptVersion })}</p>
          <p>{t('taskDetail.schedule', { schedule: scheduleDisplay })}</p>
          <p>{t('taskDetail.created', { date: new Date(task.createdAt).toLocaleDateString() })}</p>
        </div>
      </div>

      {/* Notification Toggle */}
      <div className="space-y-1">
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={task.notifyEnabled !== false}
            onChange={handleToggleNotify}
            className="rounded"
          />
          <span className="text-gray-700">{t('taskDetail.enableNotifications')}</span>
        </label>
        <p className="text-xs text-gray-400 ml-6">
          {t('taskDetail.notificationHint')}
        </p>
      </div>

      {/* Script Versions */}
      <CollapsibleSection
        title={t('taskDetail.scriptVersions')}
        badge={scriptVersions.length}
        defaultOpen={false}
      >
        <ScriptVersionsSection
          versions={scriptVersions}
          activeVersion={task.activeScriptVersion}
          onRevert={handleRevert}
        />
      </CollapsibleSection>

      {/* State Inspector */}
      <CollapsibleSection title={t('taskDetail.stateInspector')} defaultOpen={false}>
        <StateInspectorSection taskState={taskState} />
      </CollapsibleSection>

      {/* Recent Runs */}
      <CollapsibleSection
        title={t('taskDetail.recentRuns')}
        badge={runs.length}
        defaultOpen={true}
      >
        {runs.length === 0 ? (
          <p className="text-xs text-gray-400">{t('taskDetail.noRuns')}</p>
        ) : (
          <div className="space-y-1">
            {runs.map(run => (
              <div key={run.id} className="text-xs rounded bg-gray-50">
                <div className="flex items-center gap-2 p-1.5">
                  <span className={run.success ? 'text-green-500' : 'text-red-500'}>
                    {run.success ? t('taskDetail.pass') : t('taskDetail.fail')}
                  </span>
                  <span className="text-gray-400">v{run.version}</span>
                  <span className="text-gray-400">{run.durationMs}ms</span>
                  <span className="text-gray-400 ml-auto">
                    {new Date(run.ranAt).toLocaleTimeString()}
                  </span>
                </div>
                {!run.success && run.error && (
                  <div className="px-1.5 pb-1.5">
                    <pre className="text-[11px] font-mono text-red-600 bg-red-50 rounded px-2 py-1 whitespace-pre-wrap break-words">
                      {run.error}
                    </pre>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </CollapsibleSection>

      <button
        className="mt-4 flex items-center gap-1.5 rounded border border-red-300 px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 transition-colors"
        onClick={() => {
          if (window.confirm(t('taskDetail.deleteConfirm', { name: task.name }))) {
            onDelete(task.id);
          }
        }}
      >
        {t('taskDetail.deleteTask')}
      </button>
    </div>
  );
}
