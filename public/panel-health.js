'use strict';

/*
 * Health Check-in, BMI Guide and Services panels.
 *
 * BMI maths lives in public/bmi.js (shared with the server), so the number a
 * visitor sees and the number the server stores come from one implementation.
 * Check-ins are persisted through /api/checkins and scoped per browser.
 */

(function () {
  const BmiCalc = window.BmiCalc;
  const $ = (id) => document.getElementById(id);

  function setText(element, value) {
    if (element) {
      element.textContent = value;
    }
  }

  function setError(message) {
    const element = $('error');
    if (!element) {
      return;
    }
    if (message) {
      element.textContent = message;
      element.hidden = false;
    } else {
      element.textContent = '';
      element.hidden = true;
    }
  }

  function setStatus(message) {
    setText($('history-status'), message);
  }

  function highlightCategory(id) {
    document.querySelectorAll('[data-bmi-cat]').forEach((chip) => {
      chip.classList.toggle('active', chip.getAttribute('data-bmi-cat') === id);
    });
  }

  function paint(result) {
    if (!result || !result.ok) {
      setText($('bmi-value'), '—');
      setText($('bmi-category'), 'Add valid measurements');
      setText(
        $('bmi-summary'),
        (result && result.error) || 'Enter your height and weight to calculate BMI.'
      );
      highlightCategory(null);
      return;
    }
    setText($('bmi-value'), result.rounded.toFixed(1));
    setText($('bmi-category'), result.category.label);
    setText($('bmi-summary'), `${result.category.range} · ${result.category.summary}`);
    highlightCategory(result.category.id);
  }

  function readInputs() {
    const height = Number($('height') ? $('height').value : NaN);
    const weight = Number($('weight') ? $('weight').value : NaN);
    return { height, weight };
  }

  function calculate() {
    const { height, weight } = readInputs();
    const result = BmiCalc.computeBmi(height, weight);
    paint(result);
    return result;
  }

  function formatDate(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
      return '';
    }
    return date.toLocaleString(undefined, {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function buildHistoryItem(record) {
    const item = document.createElement('li');

    const main = document.createElement('div');
    main.className = 'h-main';

    const bmi = document.createElement('span');
    bmi.className = 'h-bmi';
    bmi.textContent = Number(record.bmi).toFixed(1);

    const category = document.createElement('span');
    category.className = 'h-cat';
    category.textContent = record.category ? record.category.label : '';

    const meta = document.createElement('span');
    meta.className = 'h-meta';
    const measurements = `${record.heightCm} cm · ${record.weightKg} kg`;
    const when = formatDate(record.createdAt);
    meta.textContent = record.note ? `${measurements} · ${when} · ${record.note}` : `${measurements} · ${when}`;

    main.append(bmi, category, meta);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'h-delete';
    remove.textContent = 'Delete';
    remove.addEventListener('click', () => removeRecord(record.id, remove));

    item.append(main, remove);
    return item;
  }

  function renderHistory(items) {
    const list = $('history-list');
    if (!list) {
      return;
    }
    list.textContent = '';
    items.forEach((record) => list.appendChild(buildHistoryItem(record)));
  }

  async function removeRecord(id, button) {
    if (button) {
      button.disabled = true;
      button.textContent = 'Deleting…';
    }
    try {
      const response = await fetch(`/api/checkins/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { Accept: 'application/json' }
      });
      if (!response.ok && response.status !== 204) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || `Could not delete (${response.status}).`);
      }
      await loadHistory();
    } catch (err) {
      setStatus(err.message);
      if (button) {
        button.disabled = false;
        button.textContent = 'Delete';
      }
    }
  }

  async function loadHistory() {
    setStatus('Loading your saved check-ins…');
    try {
      const response = await fetch('/api/checkins?limit=20', {
        headers: { Accept: 'application/json' }
      });
      if (!response.ok) {
        throw new Error(`Could not load your history (${response.status}).`);
      }
      const payload = await response.json();
      const items = Array.isArray(payload.items) ? payload.items : [];
      renderHistory(items);
      const total = Number(payload.total) || items.length;
      setStatus(
        total > 0
          ? `${total} saved check-in${total === 1 ? '' : 's'}, newest first.`
          : 'No saved check-ins yet. Save your first one above.'
      );
    } catch (err) {
      setStatus(err.message);
    }
  }

  async function save(event) {
    if (event) {
      event.preventDefault();
    }
    const result = calculate();
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError('');

    const button = $('calculate');
    if (button) {
      button.disabled = true;
      button.textContent = 'Saving…';
    }

    try {
      const { height, weight } = readInputs();
      const note = $('note') && $('note').value ? $('note').value.trim() : '';
      const response = await fetch('/api/checkins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          heightCm: height,
          weightKg: weight,
          note,
          lang: (document.documentElement.lang || 'en').slice(0, 2).toLowerCase()
        })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || `Could not save this check-in (${response.status}).`);
      }
      await loadHistory();
    } catch (err) {
      setError(err.message);
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = 'Save check-in';
      }
    }
  }

  function renderGuide() {
    const grid = $('bmi-guide-grid');
    if (!grid || !BmiCalc || !Array.isArray(BmiCalc.CATEGORIES)) {
      return;
    }
    grid.textContent = '';
    BmiCalc.CATEGORIES.forEach((category) => {
      const card = document.createElement('div');
      card.className = 'card';

      const title = document.createElement('h3');
      title.textContent = category.label;

      const range = document.createElement('div');
      range.className = 'kpi';
      range.textContent = category.range;

      const summary = document.createElement('p');
      summary.className = 'muted';
      summary.textContent = category.summary;

      card.append(title, range, summary);
      grid.appendChild(card);
    });
  }

  function init() {
    renderGuide();

    const form = $('checkin-form');
    if (form) {
      form.addEventListener('submit', save);
      form.addEventListener('input', () => {
        calculate();
        setError('');
      });
      form.addEventListener('reset', () => {
        // The value attributes restore 170 cm / 70 kg, so recalculate after them.
        setTimeout(() => {
          calculate();
          setError('');
        }, 0);
      });
    }

    if ($('height') && $('weight')) {
      calculate();
    }

    loadHistory();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
