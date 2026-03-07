import { useEffect, useState } from 'react';
import { useTasksStore } from '../stores/tasks-store';
import { useWizardStore } from '../stores/wizard-store';
import { TaskCard } from '../components/TaskCard';
import { TaskDetail } from '../components/TaskDetail';
import { NotificationFeed } from '../components/NotificationFeed';
import { CreateTaskWizard } from '../components/CreateTaskWizard';

export function TasksPage() {
  const { tasks, selectedTaskId, runs, notifications, loading,
    fetchTasks, selectTask, fetchNotifications, runTask, deleteTask, markNotificationRead } = useTasksStore();
  const [showWizard, setShowWizard] = useState(false);
  const resetWizard = useWizardStore(state => state.reset);

  useEffect(() => {
    fetchTasks();
    fetchNotifications();
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

  if (selectedTask) {
    return (
      <TaskDetail
        task={selectedTask}
        runs={runs.get(selectedTask.id) || []}
        onClose={() => selectTask(null)}
        onDelete={deleteTask}
      />
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 flex items-center justify-between">
        <h2 className="text-base font-semibold">Tasks</h2>
        <button
          onClick={() => setShowWizard(true)}
          className="bg-blue-500 text-white rounded-lg px-3 py-1.5 text-sm font-medium hover:bg-blue-600 transition-colors"
        >
          + New Task
        </button>
      </div>

      {loading ? (
        <div className="p-4 text-center text-gray-400 text-sm">Loading...</div>
      ) : tasks.length === 0 ? (
        <div className="text-center text-gray-400 mt-12">
          <p className="text-sm">No tasks yet</p>
          <p className="text-xs mt-1">Create your first automation task</p>
        </div>
      ) : (
        <div className="px-4 space-y-2 overflow-y-auto flex-1">
          {tasks.map(task => (
            <TaskCard
              key={task.id}
              task={task}
              isSelected={task.id === selectedTaskId}
              onSelect={selectTask}
              onRun={runTask}
            />
          ))}
        </div>
      )}

      {notifications.length > 0 && (
        <div className="border-t border-gray-200 max-h-48 overflow-y-auto">
          <div className="px-4 py-2 text-xs font-medium text-gray-500">Notifications</div>
          <NotificationFeed notifications={notifications} onMarkRead={markNotificationRead} />
        </div>
      )}
    </div>
  );
}
