/**
 * Service worker keepalive utilities.
 *
 * During active script execution the service worker must stay alive.
 * Two complementary strategies:
 *
 * 1. **Port keepalive**: Send a lightweight ping message on the RPC port
 *    every 25 seconds. This resets the 30-second idle timer.
 *
 * 2. **Alarm keepalive**: Register a chrome.alarms alarm as a backup.
 *    Alarms fire at minimum 1-minute granularity and will wake the
 *    service worker if it was somehow suspended.
 */

const KEEPALIVE_INTERVAL_MS = 25_000; // 25 seconds — under 30s idle limit
const KEEPALIVE_ALARM_NAME = 'cohand-keepalive';

let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
let activePort: chrome.runtime.Port | null = null;

/**
 * Start keepalive signalling for the duration of a script execution.
 *
 * @param port  The long-lived RPC port to ping.
 */
export function startKeepalive(port: chrome.runtime.Port): void {
  stopKeepalive(); // clear any previous session

  activePort = port;

  // Strategy 1: periodic port ping
  keepaliveTimer = setInterval(() => {
    try {
      activePort?.postMessage({ type: 'keepalive' });
    } catch {
      // Port disconnected — stop pinging
      stopKeepalive();
    }
  }, KEEPALIVE_INTERVAL_MS);

  // Strategy 2: chrome.alarms backup
  try {
    chrome.alarms.create(KEEPALIVE_ALARM_NAME, {
      periodInMinutes: 1, // minimum granularity
    });
  } catch {
    // alarms API not available in this context (tests)
  }
}

/**
 * Stop keepalive signalling.  Call when execution completes or is cancelled.
 */
export function stopKeepalive(): void {
  if (keepaliveTimer !== null) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
  activePort = null;

  try {
    chrome.alarms.clear(KEEPALIVE_ALARM_NAME);
  } catch {
    // alarms API not available
  }
}

/**
 * Whether keepalive is currently active.
 */
export function isKeepaliveActive(): boolean {
  return keepaliveTimer !== null;
}
