'use strict';

(function () {
  var form = document.getElementById('checkin-form');
  var heightInput = document.getElementById('height');
  var weightInput = document.getElementById('weight');
  var errorEl = document.getElementById('error');
  var resultEl = document.getElementById('result');
  var valueEl = document.getElementById('bmi-value');
  var categoryEl = document.getElementById('bmi-category');

  if (!form) {
    return;
  }

  function categoryFor(bmi) {
    if (bmi < 18.5) return 'Underweight';
    if (bmi < 25) return 'Healthy range';
    if (bmi < 30) return 'Overweight';
    return 'Obese';
  }

  function showError(message) {
    errorEl.textContent = message;
    errorEl.hidden = false;
    resultEl.hidden = true;
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();

    var height = parseFloat(heightInput.value);
    var weight = parseFloat(weightInput.value);

    if (!isFinite(height) || !isFinite(weight)) {
      showError('Please enter both your height and weight.');
      return;
    }
    if (height < 50 || height > 260) {
      showError('Height must be between 50 and 260 cm.');
      return;
    }
    if (weight < 20 || weight > 400) {
      showError('Weight must be between 20 and 400 kg.');
      return;
    }

    var metres = height / 100;
    var bmi = weight / (metres * metres);
    var rounded = Math.round(bmi * 10) / 10;

    errorEl.hidden = true;
    valueEl.textContent = rounded.toFixed(1);
    categoryEl.textContent = categoryFor(rounded);
    resultEl.hidden = false;
  });
})();
