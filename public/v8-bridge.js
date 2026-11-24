'use strict';

/*
 * Bridges the v8 app's browser storage to the secure server store.
 *
 * v8 reads and writes 16 collections synchronously through localStorage
 * (prefix "shh_"). Rewriting every call site would risk breaking working code,
 * so instead this bridge:
 *   1. wraps Storage.prototype.setItem, write-throughing every shh_ key to
 *      PUT /api/state (debounced, so rapid edits send one request);
 *   2. hydrates localStorage from GET /api/state on load, then re-runs the v8
 *      render functions so the UI shows the server's copy;
 *   3. uploads any local-only key that the server does not have yet, so data
 *      saved in the old browser-only build is migrated on first visit.
 *
 * Data is scoped per browser by the server's HttpOnly anonymous cookie.
 */

(function () {
  const PREFIX = 'shh_';
  const originalSetItem = Storage.prototype.setItem;
  const pending = new Map();
  let hydrating = false;
  let timer = null;

  const RENDERERS = [
    'renderPlan',
    'renderContent',
    'renderLeads',
    'renderMetrics',
    'renderIdDocs',
    'renderCustomerOptions',
    'renderCustomerProgress',
    'renderMediaList',
    'renderBusinessDesk',
    'renderQAChecks',
    'renderFollowups',
    'renderConsultations',
    'renderConsentEvents',
    'renderMasterProfiles',
    'makeWaDraft',
    'makePoster'
  ];

  function queue(key, rawValue) {
    if (hydrating) {
      return;
    }
    pending.set(key, rawValue);
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(flush, 400);
  }

  function flush() {
    timer = null;
    const entries = Array.from(pending.entries());
    pending.clear();
    entries.forEach(([key, rawValue]) => {
      let value;
      try {
        value = JSON.parse(rawValue);
      } catch (err) {
        value = rawValue;
      }
      fetch('/api/state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ key: key.slice(PREFIX.length), value }),
        keepalive: true
      }).catch(() => {
        /* offline: the local copy still holds the data */
      });
    });
  }

  // Write-through: every v8 set() call still works synchronously.
  Storage.prototype.setItem = function setItem(key, value) {
    originalSetItem.call(this, key, value);
    if (typeof key === 'string' && key.indexOf(PREFIX) === 0) {
      queue(key, value);
    }
  };

  function rerender() {
    RENDERERS.forEach((name) => {
      if (typeof window[name] === 'function') {
        try {
          window[name]();
        } catch (err) {
          console.warn('Could not re-render', name, err && err.message);
        }
      }
    });
    if (typeof window.setLanguage === 'function') {
      try {
        window.setLanguage();
      } catch (err) {
        console.warn('Could not re-apply language', err && err.message);
      }
    }
    document.dispatchEvent(new CustomEvent('shh:hydrated'));
  }

  function localKeys() {
    const keys = [];
    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (typeof key === 'string' && key.indexOf(PREFIX) === 0) {
          keys.push(key);
        }
      }
    } catch (err) {
      /* storage unavailable */
    }
    return keys;
  }

  const ready = (async function hydrate() {
    try {
      const response = await fetch('/api/state', { headers: { Accept: 'application/json' } });
      if (!response.ok) {
        throw new Error(`state endpoint returned ${response.status}`);
      }
      const payload = await response.json();
      const data = (payload && payload.data) || {};
      const serverKeys = Object.keys(data);

      hydrating = true;
      let restored = 0;
      serverKeys.forEach((key) => {
        const value = data[key];
        if (value === null || value === undefined) {
          return;
        }
        const raw = typeof value === 'string' ? value : JSON.stringify(value);
        originalSetItem.call(localStorage, PREFIX + key, raw);
        restored += 1;
      });
      hydrating = false;

      if (restored > 0) {
        rerender();
      }

      // Push data that only exists in this browser up to the server.
      localKeys().forEach((key) => {
        if (!serverKeys.includes(key.slice(PREFIX.length))) {
          queue(key, localStorage.getItem(key) || '');
        }
      });
      if (pending.size) {
        flush();
      }

      document.documentElement.setAttribute('data-state-sync', 'ready');
      return true;
    } catch (err) {
      hydrating = false;
      document.documentElement.setAttribute('data-state-sync', 'local-only');
      console.warn('Server storage unavailable, continuing with this browser only:', err.message);
      return false;
    }
  })();

  window.SHHState = { ready, flush, rerender };
})();
