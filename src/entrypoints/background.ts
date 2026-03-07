import { MessageRouter } from '../lib/message-router';

export default defineBackground(() => {
  console.log('[Cohand] Service worker started');
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

  const router = new MessageRouter();

  // Register placeholder handlers — real implementations come in later tasks
  router.on('GET_TASKS', async () => ({ tasks: [] }));
  router.on('GET_UNREAD_COUNT', async () => ({ count: 0 }));
  router.on('ENSURE_OFFSCREEN', async () => ({ ok: true as const }));

  router.listen();
});
