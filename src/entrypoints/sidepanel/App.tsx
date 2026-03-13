import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { TabBar, type Tab } from './components/TabBar';
import { useTasksStore } from './stores/tasks-store';
import { useSettingsStore } from './stores/settings-store';

const ChatPage = lazy(() => import('./pages/ChatPage').then(m => ({ default: m.ChatPage })));
const TasksPage = lazy(() => import('./pages/TasksPage').then(m => ({ default: m.TasksPage })));
const SettingsPage = lazy(() => import('./pages/SettingsPage').then(m => ({ default: m.SettingsPage })));

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[Cohand] UI error:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return <ErrorFallback error={this.state.error} onReload={() => { this.setState({ hasError: false, error: null }); window.location.reload(); }} />;
    }
    return this.props.children;
  }
}

function ErrorFallback({ error, onReload }: { error: Error | null; onReload: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="h-screen flex flex-col items-center justify-center gap-4 p-6 text-center">
      <p className="text-lg font-semibold text-gray-900">{t('app.somethingWentWrong')}</p>
      <p className="text-sm text-gray-500">{error?.message}</p>
      <button
        onClick={onReload}
        className="bg-blue-500 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-blue-600"
      >
        {t('app.reload')}
      </button>
    </div>
  );
}

export function App() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<Tab>('chat');
  const [showSettings, setShowSettings] = useState(false);
  const unreadCount = useTasksStore(state => state.unreadCount);

  useEffect(() => {
    useTasksStore.getState().fetchUnreadCount();
    useSettingsStore.getState().load();
  }, []);

  if (showSettings) {
    return (
      <ErrorBoundary>
        <Suspense fallback={<div className="flex items-center justify-center h-screen text-gray-400 text-sm">{t('app.loading')}</div>}>
          <SettingsPage onBack={() => setShowSettings(false)} />
        </Suspense>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <div className="h-screen bg-white text-gray-900 flex flex-col">
        <TabBar
          activeTab={activeTab}
          onTabChange={setActiveTab}
          onSettingsClick={() => setShowSettings(true)}
          unreadCount={unreadCount}
        />
        <main className="flex-1 overflow-y-auto">
          <Suspense fallback={<div className="flex items-center justify-center h-full text-gray-400 text-sm">{t('app.loading')}</div>}>
            {activeTab === 'chat' && <ChatPage onOpenSettings={() => setShowSettings(true)} />}
            {activeTab === 'tasks' && <TasksPage onOpenSettings={() => setShowSettings(true)} />}
          </Suspense>
        </main>
      </div>
    </ErrorBoundary>
  );
}
