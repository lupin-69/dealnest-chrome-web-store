const $ = (id) => document.getElementById(id);
const list = (s) => [...new Set(s.split(/[\s,]+/).map((x) => x.replace(/^@/, '').trim()).filter(Boolean))];
const FIELDS = ['token', 'igUserId', 'graphVersion', 'limit'];

function readSettings() {
  const settings = {
    token: $('token').value.trim(),
    igUserId: $('igUserId').value.trim(),
    graphVersion: $('graphVersion').value.trim() || 'v26.0',
    limit: Math.min(100, Math.max(1, Number($('limit').value) || 50)),
    igUsers: list($('igUsers').value),
    fbPages: list($('fbPages').value),
  };
  if (!/^v\d+\.\d+$/.test(settings.graphVersion)) throw new Error('Graph API version must look like v26.0.');
  if (settings.igUserId && !/^\d+$/.test(settings.igUserId)) throw new Error('Instagram Professional account ID must contain digits only.');
  if (settings.igUsers.some((user) => !/^[A-Za-z0-9._]{1,30}$/.test(user))) {
    throw new Error('Instagram usernames may contain only letters, numbers, periods, and underscores (up to 30 characters).');
  }
  if (settings.fbPages.some((page) => !/^[A-Za-z0-9._-]{1,100}$/.test(page))) {
    throw new Error('Facebook Page IDs/usernames may contain only letters, numbers, periods, underscores, and hyphens.');
  }
  return settings;
}

async function saveSettings() {
  const settings = readSettings();
  await chrome.storage.local.set({ settings });
}

function showTestResult(result) {
  if (result.error) {
    $('msg').textContent = result.error;
    return;
  }
  $('msg').textContent = result.results.map((entry) => {
    const lines = [`${entry.source}: ${entry.error || `${entry.posts} post(s) returned.`}`];
    if (entry.warnings?.length) lines.push(...entry.warnings.map((warning) => `  ${warning}`));
    return lines.join('\n');
  }).join('\n');
}

(async () => {
  const { settings = {} } = await chrome.storage.local.get('settings');
  for (const f of FIELDS) if (settings[f] !== undefined) $(f).value = settings[f];
  $('igUsers').value = (settings.igUsers || []).join('\n');
  $('fbPages').value = (settings.fbPages || []).join('\n');
})();

$('save').addEventListener('click', async () => {
  try {
    await saveSettings();
    $('msg').textContent = 'Settings saved locally.';
  } catch (e) {
    $('msg').textContent = e.message;
  }
});

$('test').addEventListener('click', async () => {
  $('test').disabled = true;
  $('msg').textContent = 'Saving settings and checking Meta…';
  try {
    await saveSettings();
    showTestResult(await chrome.runtime.sendMessage({ type: 'testMeta' }));
  } catch (e) {
    $('msg').textContent = `Meta connection test failed: ${e.message}`;
  } finally {
    $('test').disabled = false;
  }
});
