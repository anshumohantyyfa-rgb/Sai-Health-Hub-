'use strict';

/*
 * Sai Health Hub — check-in interactions.
 *
 * The page ships with the default result already rendered (170 cm / 70 kg =>
 * BMI 24.2), so the panel is correct before any script runs and never shows 0.
 * This file keeps it live: recalculates as you type, validates on submit, and
 * highlights the matching BMI category.
 */
(function () {
  var BmiCalc = window.BmiCalc;
  var form = document.getElementById('checkin-form');

  if (!form || !BmiCalc) {
    return;
  }

  var DEFAULTS = { height: 170, weight: 70 };

  var heightInput = document.getElementById('height');
  var weightInput = document.getElementById('weight');
  var errorEl = document.getElementById('error');
  var resultEl = document.getElementById('result');
  var valueEl = document.getElementById('bmi-value');
  var categoryEl = document.getElementById('bmi-category');
  var summaryEl = document.getElementById('bmi-summary');
  var resetBtn = document.getElementById('reset');
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

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    calculate({ strict: true });
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
})();
