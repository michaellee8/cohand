import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useTasksStore } from '../stores/tasks-store';
import { useSettingsStore } from '../stores/settings-store';
import { useWizardStore } from '../stores/wizard-store';
import { TaskCard } from '../components/TaskCard';
import { TaskDetail } from '../components/TaskDetail';
import { NotificationFeed } from '../components/NotificationFeed';
import { CreateTaskWizard } from '../components/CreateTaskWizard';

interface TasksPageProps {
  onOpenSettings: () => void;
}

export function TasksPage({ onOpenSettings }: TasksPageProps) {
  const { t } = useTranslation();
  const { tasks, selectedTaskId, runs, scriptVersions, taskStates, notifications, loading, runningTaskId,
    fetchTasks, selectTask, runTask, deleteTask, updateTask, markNotificationRead } = useTasksStore();
  const { settings, hasApiKey, codexConnected } = useSettingsStore();
  const [showWizard, setShowWizard] = useState(false);
  const resetWizard = useWizardStore(state => state.reset);

  const llmConfigured = settings
    ? settings.llmProvider === 'chatgpt-subscription'
      ? codexConnected
      : hasApiKey
    : true;

  useEffect(() => {
    useTasksStore.getState().fetchTasks();
    useTasksStore.getState().fetchNotifications();
  }, []);

  const handleWizardComplete = () => {
    setShowWizard(false);
    resetWizard();
    fetchTasks();
  };

  const handleWizardCancel = () => {
    setShowWizard(false);
    resetWizard();
  };

  if (showWizard) {
    return <CreateTaskWizard onComplete={handleWizardComplete} onCancel={handleWizardCancel} />;
  }

  const selectedTask = tasks.find(t => t.id === selectedTaskId);

  const handleRevertVersion = async (taskId: string, version: number) => {
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;
    const updated = { ...task, activeScriptVersion: version, updatedAt: new Date().toISOString() };
    await updateTask(updated);
    // Refresh versions after revert
    useTasksStore.getState().fetchScriptVersions(taskId);
  };

  if (selectedTask) {
    return (
      <TaskDetail
        task={selectedTask}
        runs={runs[selectedTask.id] || []}
        scriptVersions={scriptVersions[selectedTask.id] || []}
        taskState={taskStates[selectedTask.id]}
        onClose={() => selectTask(null)}
        onDelete={deleteTask}
        onRevertVersion={handleRevertVersion}
        onUpdateTask={updateTask}
      />
    );
  }

  return (
    <div className="flex flex-col h-full">
      {!llmConfigured && (
        <div className="mx-4 mt-4 p-3 bg-yellow-50 border border-yellow-200 rounded-lg flex items-center justify-between">
          <p className="text-sm text-yellow-800">{t('tasks.noLlmWarning')}</p>
          <button
            onClick={onOpenSettings}
            className="bg-blue-500 text-white rounded-lg px-3 py-1.5 text-sm font-medium hover:bg-blue-600 transition-colors shrink-0 ml-3"
          >
            {t('tasks.goToSettings')}
          </button>
        </div>
      )}
      <div className="p-4 flex items-center justify-between">
        <h2 className="text-base font-semibold">{t('tasks.title')}</h2>
        <button
          onClick={() => setShowWizard(true)}
          className="bg-blue-500 text-white rounded-lg px-3 py-1.5 text-sm font-medium hover:bg-blue-600 transition-colors"
        >
          {t('tasks.newTask')}
        </button>
      </div>

      {loading ? (
        <div className="p-4 text-center text-gray-400 text-sm">{t('tasks.loading')}</div>
      ) : tasks.length === 0 ? (
        <div className="text-center text-gray-400 mt-12">
          <p className="text-sm">{t('tasks.noTasks')}</p>
          <p className="text-xs mt-1">{t('tasks.noTasksHint')}</p>
        </div>
      ) : (
        <div className="px-4 space-y-2 overflow-y-auto flex-1">
          {tasks.map(task => {
            const taskRuns = runs[task.id] || [];
            const lastRun = taskRuns.length > 0 ? taskRuns[0] : undefined;
            return (
              <TaskCard
                key={task.id}
                task={task}
                isSelected={task.id === selectedTaskId}
                lastRun={lastRun}
                isRunning={runningTaskId === task.id}
                onSelect={selectTask}
                onRun={runTask}
              />
            );
          })}
        </div>
      )}

      {notifications.length > 0 && (
        <div className="border-t border-gray-200 max-h-48 overflow-y-auto">
          <div className="px-4 py-2 text-xs font-medium text-gray-500">{t('notifications.title')}</div>
          <NotificationFeed notifications={notifications} onMarkRead={markNotificationRead} />
        </div>
      )}
    </div>
  );
}
