'use strict';
/*
 * Sai Health Hub — mobile app shell behaviour.
 *
 * Implements the recommended mobile design without touching the desktop layout
 * or any existing module:
 *   1. a branded header that turns solid green (with a close icon) on All Modules,
 *   2. a Home dashboard whose cards open the real panels,
 *   3. an All Modules page whose two-column grid is generated from the existing
 *      #nav buttons, so every module and tab stays reachable and in sync,
 *   4. a fixed bottom navigation bar (Home, Customers, WhatsApp, Reports, More).
 *
 * Tab switching reuses the existing #nav click handlers, so routing, panels,
 * stored data and AI features behave exactly as before.
 */
(function () {
  const ALL_MODULES = 'all-modules';
  const HOME = 'mHome';
  const BOTTOM_TABS = [HOME, 'customers', 'whatsapp', 'metrics', ALL_MODULES];
  const MOBILE_QUERY = '(max-width: 820px), (max-height: 480px)';

  /* Colour-coded icon per module, matching the approved design language. */
  const ICONS = {
    overview: { color: '#1B7A36', tint: '#E8F5E9', path: '<rect x="3" y="3" width="7" height="7" rx="1.6"/><rect x="14" y="3" width="7" height="7" rx="1.6"/><rect x="3" y="14" width="7" height="7" rx="1.6"/><rect x="14" y="14" width="7" height="7" rx="1.6"/>' },
    calendar: { color: '#1976D2', tint: '#E3F0FB', path: '<rect x="3" y="5" width="18" height="16" rx="2.2"/><path d="M8 3v4M16 3v4M3 10h18"/>' },
    content: { color: '#8E24AA', tint: '#F3E5F8', path: '<path d="M12 3l1.7 4.4L18 9.1l-4.3 1.7L12 15.2l-1.7-4.4L6 9.1l4.3-1.7z"/><path d="M18 14.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>' },
    creator: { color: '#D32F2F', tint: '#FBE4E4', path: '<rect x="3" y="9" width="18" height="12" rx="2"/><path d="M3 9l2.6-4.2 3.8 1.5L7 9M10.4 9L13 4.8l3.8 1.5L14.4 9"/>' },
    identity: { color: '#1976D2', tint: '#E3F0FB', path: '<path d="M7 17.5a4 4 0 01.3-8 5 5 0 019.5-1.2A3.6 3.6 0 0117 17.5"/><path d="M12 20v-6M9.5 16.5L12 14l2.5 2.5"/>' },
    customers: { color: '#FF9800', tint: '#FFF1DE', path: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 20a5.5 5.5 0 0111 0"/><circle cx="17.5" cy="9.5" r="2.4"/><path d="M15.5 20a4.8 4.8 0 015.5-4.4"/>' },
    leads: { color: '#1B7A36', tint: '#E8F5E9', path: '<circle cx="10" cy="8" r="3.4"/><path d="M4 20a6 6 0 0112 0M18 8v6M15 11h6"/>' },
    whatsapp: { color: '#1B7A36', tint: '#E8F5E9', path: '<path d="M20.5 11.8a8.4 8.4 0 01-12.4 7.4L4 20.5l1.4-4.1a8.4 8.4 0 1115.1-4.6z"/><path d="M9.2 9.4c.2 3.1 2.2 5.1 5.3 5.4.8.1 1.2-.9.7-1.4l-1-.9-1.3.9c-1-.5-1.8-1.3-2.2-2.3l.9-1.3-.9-1c-.5-.5-1.5-.2-1.5.6z"/>' },
    businessdesk: { color: '#1976D2', tint: '#E3F0FB', path: '<rect x="3" y="7" width="18" height="13" rx="2.2"/><path d="M9 7V5.2A1.7 1.7 0 0110.7 3.5h2.6A1.7 1.7 0 0115 5.2V7M3 12.5h18"/>' },
    datahosting: { color: '#8E24AA', tint: '#F3E5F8', path: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>' },
    finalqa: { color: '#1B7A36', tint: '#E8F5E9', path: '<path d="M12 3l7 2.8v6.1c0 4.1-3 7.4-7 9.1-4-1.7-7-5-7-9.1V5.8z"/><path d="M9 12l2.1 2.1 4.1-4.2"/>' },
    compliance: { color: '#1976D2', tint: '#E3F0FB', path: '<path d="M12 4v16M6.5 8h11M8.5 8l-3 6h6zM15.5 8l-3 6h6z"/><path d="M8.5 20h7"/>' },
    metrics: { color: '#FF9800', tint: '#FFF1DE', path: '<path d="M4 20v-6M9.5 20v-9M15 20v-4"/><path d="M17 9.5l4-4M17 5.5h4v4"/>' },
    backup: { color: '#1B7A36', tint: '#E8F5E9', path: '<rect x="4.5" y="10" width="15" height="10" rx="2.2"/><path d="M8 10V7.5a4 4 0 018 0V10"/>' },
    checkin: { color: '#D32F2F', tint: '#FBE4E4', path: '<path d="M12 20.5S4.5 16 4.5 10.6A4.1 4.1 0 0112 8a4.1 4.1 0 017.5 2.6c0 5.4-7.5 9.9-7.5 9.9z"/><path d="M6.5 12h2l1.2-2.2 1.8 4.2 1.3-2h2.7"/>' },
    'bmi-guide': { color: '#8E24AA', tint: '#F3E5F8', path: '<rect x="5" y="3" width="14" height="18" rx="2.2"/><path d="M8 7h8M8.5 12h1.5M12 12h1.5M15.5 12h.01M8.5 16.5h1.5M12 16.5h1.5M15.5 16.5h.01"/>' },
    services: { color: '#1B7A36', tint: '#E8F5E9', path: '<path d="M4.5 13.5v-1.2a7.5 7.5 0 0115 0v1.2"/><path d="M4.5 13.5H7v6H5.7a1.2 1.2 0 01-1.2-1.2zM19.5 13.5H17v6h1.3a1.2 1.2 0 001.2-1.2z"/>' },
    owner: { color: '#14602a', tint: '#E8F5E9', path: '<circle cx="12" cy="8" r="3.3"/><path d="M5 20a7 7 0 0114 0"/><path d="M17.5 15.5l1.2 1.2 2.3-2.4"/>' },
  };

  const grid = document.getElementById('m-modules-grid');
  const menuBtn = document.getElementById('mMenuBtn');
  const langBtn = document.getElementById('mLangBtn');
  const bottomNav = document.getElementById('mBottomNav');
  const topbar = document.getElementById('mTopbar');
  const home = document.getElementById('mHome');
  const backHome = document.getElementById('mBackHome');
  if (!grid || !menuBtn || !bottomNav) return;

  let lastTab = HOME;

  function navButtons() {
    return Array.from(document.querySelectorAll('#nav button[data-tab]'));
  }

  function activePanelId() {
    const panel = document.querySelector('.panel.active');
    return panel ? panel.id : '';
  }

  function iconMarkup(tab) {
    const icon = ICONS[tab] || ICONS.overview;
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + icon.path + '</svg>';
  }

  /** Paint every [data-ico] placeholder (home cards, banner, quick access). */
  function paintIcons() {
    document.querySelectorAll('[data-ico]').forEach((slot) => {
      const icon = ICONS[slot.dataset.ico];
      if (!icon) return;
      slot.innerHTML = iconMarkup(slot.dataset.ico);
      if (slot.classList.contains('m-feat-ico') || slot.classList.contains('m-banner-ico')) {
        slot.style.color = icon.color;
        slot.style.background = icon.tint;
      }
    });
  }

  /** Label for a module, honouring the current English/Odia choice. */
  function labelFor(button) {
    const english = button.dataset.en || button.textContent.trim();
    if (document.documentElement.lang === 'or') {
      return (button.dataset.or || button.textContent.trim() || english).trim();
    }
    return english.trim();
  }

  /** Show a panel directly, without going through the desktop tab strip. */
  function showPanel(tab) {
    document.querySelectorAll('#nav button').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    const panel = document.getElementById(tab);
    if (panel) panel.classList.add('active');
  }

  /** Show one panel, reusing the real nav handler when the tab has one. */
  function activate(tab) {
    if (tab === HOME || tab === ALL_MODULES) {
      showPanel(tab);
    } else {
      const source = document.querySelector('#nav button[data-tab="' + tab + '"]');
      if (source) {
        source.click();
      } else {
        showPanel(tab);
      }
    }
    if (tab !== ALL_MODULES) lastTab = tab;
    syncActive();
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  /** Keep the bottom bar, header state and aria attributes in step. */
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
    if (topbar) topbar.classList.toggle('is-modules', open);
    menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    menuBtn.setAttribute('aria-label', open ? 'Close all modules' : 'Open all modules');
  }

  /** Build the All Modules grid from the live nav, so nothing can go missing. */
  function renderModules() {
    const buttons = navButtons();
    const fragment = document.createDocumentFragment();
    buttons.forEach((button) => {
      const tab = button.dataset.tab;
      const label = labelFor(button);
      const icon = ICONS[tab] || ICONS.overview;
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'm-mod-card';
      card.dataset.tab = tab;
      card.setAttribute('aria-label', label);

      const iconSlot = document.createElement('span');
      iconSlot.className = 'm-ico';
      iconSlot.setAttribute('aria-hidden', 'true');
      iconSlot.style.color = icon.color;
      iconSlot.style.background = icon.tint;
      iconSlot.innerHTML = iconMarkup(tab);

      const text = document.createElement('span');
      text.className = 'm-lbl';
      text.textContent = label;

      card.append(iconSlot, text);
      card.addEventListener('click', () => activate(tab));
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

  /* Home dashboard cards open the real module panels. */
  if (home) {
    home.addEventListener('click', (event) => {
      const target = event.target.closest('[data-tab]');
      if (target) activate(target.dataset.tab);
    });
  }

  if (backHome) {
    backHome.addEventListener('click', () => activate(HOME));
  }

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

  paintIcons();
  renderModules();

  // Phones start on the designed Home dashboard; desktop keeps its own layout.
  if (home && window.matchMedia(MOBILE_QUERY).matches) {
    showPanel(HOME);
    lastTab = HOME;
  }
  syncActive();
})();
