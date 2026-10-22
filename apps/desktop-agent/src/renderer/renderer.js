const $ = (id) => document.getElementById(id);
const PERMISSION_TEXT = { granted: 'Granted', denied: 'Denied: open System Settings to allow it', 'not-determined': 'Not yet requested', restricted: 'Restricted by your administrator', unknown: 'Unknown' };
let forcePairing = false;

function render(status) {
  const showPair = forcePairing || (!status.paired && !status.disconnected);
  $('pair').hidden = !showPair;
  $('connected').hidden = showPair || !status.paired;
  $('revoked').hidden = showPair || !status.disconnected;
  if (!status.paired) return;
  $('state').textContent = status.text;
  $('state').dataset.capturing = String(status.capturing);
  $('who').textContent = status.member ? `${status.member.name} · ${status.organization?.name ?? ''}` : status.serverUrl;
  $('last').textContent = status.lastCaptureAt ? new Date(status.lastCaptureAt).toLocaleString() : 'None yet';
  $('queue').textContent = status.queue.depth ? `${status.queue.depth} (${Math.ceil(status.queue.bytes / 1024)} KB)` : 'Nothing';
  $('permission').textContent = PERMISSION_TEXT[status.osPermission] ?? status.osPermission;
  $('grant').hidden = status.osPermission === 'granted';
  $('error').textContent = status.lastError ?? '';
}

$('pair-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('pair-error').textContent = '';
  const button = event.submitter;
  button.disabled = true;
  const result = await window.orbit.pair($('server').value, $('code').value);
  button.disabled = false;
  if (!result.ok) {
    $('pair-error').textContent = result.message;
    return;
  }
  forcePairing = false;
  render(await window.orbit.getStatus());
});

$('grant').addEventListener('click', async () => render(await window.orbit.requestPermission()));
$('open-page').addEventListener('click', () => window.orbit.openMonitoringPage());
$('disconnect').addEventListener('click', async () => {
  if (!window.confirm('Disconnect this computer? Screenshots waiting to upload will be deleted.')) return;
  await window.orbit.disconnect();
  forcePairing = true;
  render(await window.orbit.getStatus());
});
$('reconnect').addEventListener('click', async () => {
  forcePairing = true;
  render(await window.orbit.getStatus());
});
$('notify').addEventListener('change', (event) => window.orbit.setPreference('showCaptureNotifications', event.target.checked));

window.orbit.onStatus(render);
window.orbit.getStatus().then(render);
window.orbit.getPreferences().then((prefs) => {
  $('notify').checked = prefs.showCaptureNotifications;
});
