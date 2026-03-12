import { createRoot } from 'react-dom/client';
import { App } from './App';
import './main.css';

// Bootstrap from URL parameters (scheduler opens sidepanel with ?taskId=...&mode=execute)
const params = new URLSearchParams(window.location.search);
const bootstrapTaskId = params.get('taskId');
const bootstrapMode = params.get('mode');

// Store bootstrap params for the app to read
if (bootstrapTaskId) {
  (window as any).__cohandBootstrap = { taskId: bootstrapTaskId, mode: bootstrapMode };
}

createRoot(document.getElementById('root')!).render(<App />);
