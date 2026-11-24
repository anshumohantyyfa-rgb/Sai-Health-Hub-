'use strict';

/*
 * Sai Health Hub — check-in interactions and saved history.
 *
 * The page ships with the default result already rendered (170 cm / 70 kg => BMI
 * 24.2), so the panel is correct before any script runs and never shows 0.
 * This file keeps it live: recalculates as you type, validates on submit, saves
 * each check-in to the server and renders the stored history.
 */
(function () {
  var BmiCalc = window.BmiCalc;
  var form = document.getElementById('checkin-form');

  if (!form || !BmiCalc) {
    return;
  }

  var DEFAULTS = { height: 170, weight: 70 };
  var API = '/api/checkins';

  var heightInput = document.getElementById('height');
  var weightInput = document.getElementById('weight');
  var errorEl = document.getElementById('error');
  var resultEl = document.getElementById('result');
  var valueEl = document.getElementById('bmi-value');
  var categoryEl = document.getElementById('bmi-category');
  var summaryEl = document.getElementById('bmi-summary');
  var resetBtn = document.getElementById('reset');
  var historyList = document.getElementById('history-list');
  var historyStatus = document.getElementById('history-status');
  var categoryNodes = Array.prototype.slice.call(document.querySelectorAll('[data-bmi-cat]'));

  function clearError() {
    errorEl.textContent = '';
    errorEl.hidden = true;
  }

  function showError(message) {
    errorEl.textContent = message;
    errorEl.hidden = false;
  }

  function highlightCategory(id) {
    categoryNodes.forEach(function (node) {
      var isActive = node.getAttribute('data-bmi-cat') === id;
      node.classList.toggle('is-active', isActive);
      if (node.tagName === 'LI') {
        if (isActive) {
          node.setAttribute('aria-current', 'true');
        } else {
          node.removeAttribute('aria-current');
        }
      }
    });
  }

  function render(result) {
    valueEl.textContent = result.rounded.toFixed(1);
    categoryEl.textContent = result.category.label;
    summaryEl.textContent = result.category.summary;
    highlightCategory(result.category.id);
    resultEl.hidden = false;
    clearError();
  }

  function readInputs() {
    return {
      height: parseFloat(heightInput.value),
      weight: parseFloat(weightInput.value)
    };
  }

  function calculate(options) {
    var values = readInputs();
    var result = BmiCalc.computeBmi(values.height, values.weight);
    var strict = !options || options.strict !== false;

    if (!result.ok) {
      if (strict) {
        showError(result.error);
      }
      return false;
    }

    render(result);
    return true;
  }

  // ---------------------------------------------------------------- history --

  function setHistoryStatus(message, isError) {
    if (!historyStatus) {
      return;
    }
    historyStatus.textContent = message;
    historyStatus.classList.toggle('is-error', !!isError);
  }

  function formatDate(iso) {
    var date = new Date(iso);
    if (isNaN(date.getTime())) {
      return '';
    }
    try {
      return date.toLocaleString(undefined, {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch (err) {
      return date.toISOString().slice(0, 16).replace('T', ' ');
    }
  }

  function buildHistoryItem(item) {
    var li = document.createElement('li');
    li.className = 'history-item';

    var main = document.createElement('div');
    main.className = 'history-main';

    var value = document.createElement('span');
    value.className = 'history-value';
    value.textContent = Number(item.bmi).toFixed(1);

    var meta = document.createElement('span');
    meta.className = 'history-meta';
    meta.textContent =
      item.category.label + ' · ' + item.heightCm + ' cm · ' + item.weightKg + ' kg';

    main.appendChild(value);
    main.appendChild(meta);

    var when = document.createElement('span');
    when.className = 'history-when';
    when.textContent = formatDate(item.createdAt);

    var remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'history-delete';
    remove.setAttribute('data-delete-id', item.id);
    remove.setAttribute('aria-label', 'Delete check-in of ' + formatDate(item.createdAt));
    remove.textContent = 'Delete';

    li.appendChild(main);
    li.appendChild(when);
    li.appendChild(remove);

    if (item.note) {
      var note = document.createElement('p');
      note.className = 'history-note';
      note.textContent = item.note;
      li.appendChild(note);
    }

    return li;
  }

  function renderHistory(items) {
    if (!historyList) {
      return;
    }
    historyList.textContent = '';
    if (!items.length) {
      var empty = document.createElement('li');
      empty.className = 'history-empty';
      empty.textContent = 'No saved check-ins yet. Calculate your BMI to save the first one.';
      historyList.appendChild(empty);
      return;
    }
    items.forEach(function (item) {
      historyList.appendChild(buildHistoryItem(item));
    });
  }

  function loadHistory() {
    if (!historyList) {
      return;
    }
    setHistoryStatus('Loading your saved check-ins…');
    fetch(API, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
      .then(function (res) {
        if (!res.ok) {
          throw new Error('HTTP ' + res.status);
        }
        return res.json();
      })
      .then(function (data) {
        var items = data.items || [];
        renderHistory(items);
        var total = typeof data.total === 'number' ? data.total : items.length;
        setHistoryStatus(
          total
            ? total + (total === 1 ? ' check-in saved' : ' check-ins saved')
            : 'Nothing saved yet.'
        );
      })
      .catch(function () {
        setHistoryStatus(
          'Saved history is unavailable right now. Your calculation still works.',
          true
        );
      });
  }

  function saveCheckin(values) {
    setHistoryStatus('Saving…');
    fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ heightCm: values.height, weightKg: values.weight })
    })
      .then(function (res) {
        if (!res.ok) {
          throw new Error('HTTP ' + res.status);
        }
        return res.json();
      })
      .then(function () {
        loadHistory();
      })
      .catch(function () {
        setHistoryStatus('Could not save this check-in to the server.', true);
      });
  }

  if (historyList) {
    historyList.addEventListener('click', function (event) {
      var target = event.target;
      var button = target && target.closest ? target.closest('[data-delete-id]') : null;
      if (!button) {
        return;
      }
      var id = button.getAttribute('data-delete-id');
      button.disabled = true;
      fetch(API + '/' + encodeURIComponent(id), {
        method: 'DELETE',
        credentials: 'same-origin'
      })
        .then(function (res) {
          if (!res.ok && res.status !== 404) {
            throw new Error('HTTP ' + res.status);
          }
          loadHistory();
        })
        .catch(function () {
          button.disabled = false;
          setHistoryStatus('Could not delete that check-in.', true);
        });
    });
  }

  // ----------------------------------------------------------------- wiring --

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (calculate({ strict: true })) {
      saveCheckin(readInputs());
    }
  });

  // Keep the number live while the user types, without flashing errors at them.
  ['input', 'change'].forEach(function (eventName) {
    form.addEventListener(eventName, function () {
      calculate({ strict: false });
    });
  });

  if (resetBtn) {
    resetBtn.addEventListener('click', function () {
      heightInput.value = String(DEFAULTS.height);
      weightInput.value = String(DEFAULTS.weight);
      calculate({ strict: true });
      heightInput.focus();
    });
  }

  // Restore defaults for empty fields, then paint the result immediately.
  if (!heightInput.value) {
    heightInput.value = String(DEFAULTS.height);
  }
  if (!weightInput.value) {
    weightInput.value = String(DEFAULTS.weight);
  }
  calculate({ strict: false });
  loadHistory();
})();
