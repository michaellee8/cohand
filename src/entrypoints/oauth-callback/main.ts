const params = new URLSearchParams(window.location.search);
const code = params.get('code');
const state = params.get('state');

if (code && state) {
  chrome.runtime.sendMessage({ type: 'OAUTH_CALLBACK', code, state });
  document.body.textContent = 'Login successful! You can close this tab.';
} else {
  document.body.textContent = 'Login failed — missing authorization code.';
}
