'use strict';

// Reports the persistence and AI facts that the server actually observes, so the
// interface never claims server storage or AI connectivity that is not working.
// Everything here is read-only and public: no secrets and no record contents.
(function () {
  function box() {
    return document.getElementById('storageStatus');
  }

  function setText(text, tone) {
    const el = box();
    if (!el) return;
    el.textContent = text;
    el.dataset.tone = tone || 'neutral';
  }

  async function readJson(url) {
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error((payload && payload.error) || `HTTP ${response.status}`);
    return payload;
  }

  async function refreshStorageStatus() {
    if (!box()) return;
    setText('Checking where records are stored…', 'neutral');
    let storage = null;
    let ai = null;
    try {
      storage = await readJson('/api/storage');
    } catch (error) {
      setText(
        'Server storage could not be reached (' + error.message + '). Treat any saved record as not persisted.',
        'warn'
      );
      return;
    }

    const parts = [];
    if (storage && storage.driver) {
      const count =
        typeof storage.records === 'number' ? ` (${storage.records} stored items)` : '';
      let where;
      if (storage.driver === 'memory') {
        where = 'memory only — records are lost on restart';
      } else if (storage.survivesRedeploy) {
        where = `server-side ${storage.driver} store — durable, survives redeploys`;
      } else {
        where = `server-side ${storage.driver} store — survives page reloads, erased when the app is redeployed`;
      }
      let line = `Records: ${where}${count}`;
      if (storage.supabaseConfigured && storage.supabaseActive === false) {
        line += ' · the remote database was unreachable, so this run uses local storage';
      }
      if (storage.pending) {
        line += ` · ${storage.pending} change(s) still syncing`;
      }
      if (storage.lastError) {
        line += ` · last sync error: ${storage.lastError}`;
      }
      parts.push(line);
    }

    try {
      ai = await readJson('/api/ai/status');
    } catch (_) {
      ai = null;
    }
    if (ai && ai.configured) {
      parts.push(`AI: connected server-side via ${ai.provider}${ai.model ? ` (${ai.model})` : ''}`);
    } else if (ai) {
      parts.push('AI: backend reachable but no provider is configured');
    } else {
      parts.push('AI: status unavailable');
    }

    const tone =
      storage &&
      (storage.driver === 'memory' ||
        (storage.supabaseConfigured && storage.supabaseActive === false))
        ? 'warn'
        : 'ok';
    setText(parts.join(' · '), tone);
  }

  window.refreshStorageStatus = refreshStorageStatus;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', refreshStorageStatus);
  } else {
    refreshStorageStatus();
  }
})();
