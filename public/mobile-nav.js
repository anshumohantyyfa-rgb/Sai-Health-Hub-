'use strict';
/*
 * Sai Health Hub — mobile navigation behaviour.
 *
 * Adds three small pieces of mobile chrome without touching the desktop layout
 * or any existing module:
 *   1. a compact top bar with a hamburger that opens "All Modules",
 *   2. an All Modules page whose two-column grid is generated from the existing
 *      #nav buttons, so every module and tab stays reachable and in sync,
 *   3. a fixed bottom navigation bar (Home, Customers, WhatsApp, Reports, More).
 *
 * Tab switching reuses the existing #nav click handlers, so routing, panels,
 * stored data and AI features behave exactly as before.
 */
(function () {
  const ALL_MODULES = 'all-modules';
  const BOTTOM_TABS = ['overview', 'customers', 'whatsapp', 'metrics', ALL_MODULES];

  const grid = document.getElementById('m-modules-grid');
  const menuBtn = document.getElementById('mMenuBtn');
  const langBtn = document.getElementById('mLangBtn');
  const bottomNav = document.getElementById('mBottomNav');
  if (!grid || !menuBtn || !bottomNav) return;

  let lastTab = 'overview';

  function navButtons() {
    return Array.from(document.querySelectorAll('#nav button[data-tab]'));
  }

  function activePanelId() {
    const panel = document.querySelector('.panel.active');
    return panel ? panel.id : '';
  }

  /** Label for a module, honouring the current English/Odia choice. */
  function labelFor(button) {
    const english = button.dataset.en || button.textContent.trim();
    if (document.documentElement.lang === 'or') {
      return (button.dataset.or || button.textContent.trim() || english).trim();
    }
    return english.trim();
  }

  /** Show one panel, reusing the real nav handler when the tab has one. */
  function activate(tab) {
    const source = document.querySelector('#nav button[data-tab="' + tab + '"]');
    if (source) {
      source.click();
    } else {
      // "All Modules" has no entry in the desktop strip; switch panels directly.
      document.querySelectorAll('#nav button').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
      const panel = document.getElementById(tab);
      if (panel) panel.classList.add('active');
    }
    syncActive();
    if (tab !== ALL_MODULES) lastTab = tab;
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  /** Keep the bottom bar, hamburger state and aria attributes in step. */
  function syncActive() {
    const current = activePanelId();
    bottomNav.querySelectorAll('.m-tab').forEach((tab) => {
      const isActive = tab.dataset.tab === current;
      tab.classList.toggle('active', isActive);
      if (isActive) {
        tab.setAttribute('aria-current', 'page');
      } else {
        tab.removeAttribute('aria-current');
      }
    });
    const open = current === ALL_MODULES;
    menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    menuBtn.setAttribute('aria-label', open ? 'Close all modules' : 'Open all modules');
  }

  /** Build the All Modules grid from the live nav, so nothing can go missing. */
  function renderModules() {
    const buttons = navButtons();
    const fragment = document.createDocumentFragment();
    buttons.forEach((button) => {
      const label = labelFor(button);
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'm-mod-card';
      card.dataset.tab = button.dataset.tab;
      card.setAttribute('aria-label', label);

      const icon = document.createElement('span');
      icon.className = 'm-ico';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = label.slice(0, 1).toUpperCase();

      const text = document.createElement('span');
      text.className = 'm-lbl';
      text.textContent = label;

      card.append(icon, text);
      card.addEventListener('click', () => activate(button.dataset.tab));
      fragment.append(card);
    });
    grid.replaceChildren(fragment);
    syncActive();
  }

  bottomNav.addEventListener('click', (event) => {
    const tab = event.target.closest('.m-tab');
    if (tab) activate(tab.dataset.tab);
  });

  menuBtn.addEventListener('click', () => {
    activate(activePanelId() === ALL_MODULES ? lastTab : ALL_MODULES);
  });

  if (langBtn) {
    langBtn.addEventListener('click', () => {
      const next = document.documentElement.lang === 'or' ? 'en' : 'or';
      if (typeof window.setLanguage === 'function') {
        window.setLanguage(next);
      }
      langBtn.textContent = next === 'or' ? 'English' : 'ଓଡ଼ିଆ';
    });
  }

  // Keep card labels in sync when the language toggle rewrites the nav labels.
  if (typeof window.setLanguage === 'function') {
    const originalSetLanguage = window.setLanguage;
    window.setLanguage = function (lang) {
      const result = originalSetLanguage.apply(this, arguments);
      renderModules();
      if (langBtn) langBtn.textContent = lang === 'or' ? 'English' : 'ଓଡ଼ିଆ';
      return result;
    };
  }

  renderModules();
  syncActive();
})();
