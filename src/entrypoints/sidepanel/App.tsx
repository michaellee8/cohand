import { useState } from 'react';
import { TabBar, type Tab } from './components/TabBar';
import { ChatPage } from './pages/ChatPage';
import { TasksPage } from './pages/TasksPage';
import { SettingsPage } from './pages/SettingsPage';

export function App() {
  const [activeTab, setActiveTab] = useState<Tab>('chat');
  const [showSettings, setShowSettings] = useState(false);

  if (showSettings) {
    return <SettingsPage onBack={() => setShowSettings(false)} />;
  }

  return (
    <div className="h-screen bg-white text-gray-900 flex flex-col">
      <TabBar
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onSettingsClick={() => setShowSettings(true)}
      />
      <main className="flex-1 overflow-y-auto">
        {activeTab === 'chat' && <ChatPage />}
        {activeTab === 'tasks' && <TasksPage />}
      </main>
    </div>
  );
}
