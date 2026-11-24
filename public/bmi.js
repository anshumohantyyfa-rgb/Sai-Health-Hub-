'use strict';

/*
 * BMI calculation and category definitions for Sai Health Hub.
 *
 * Shared by the browser (window.BmiCalc) and the Node smoke test
 * (module.exports) so the number shown on screen and the number asserted
 * in tests always come from the same code path.
 */
(function (root, factory) {
  var api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.BmiCalc = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Ordered low to high. `min` is inclusive, `max` is exclusive, so a value
  // rounds into exactly one category with no gaps.
  var CATEGORIES = [
    {
      id: 'underweight',
      label: 'Underweight',
      range: 'Below 18.5',
      min: 0,
      max: 18.5,
      summary:
        'Below the range usually linked with good health for your height. A check-up can rule out simple causes such as recent illness or low food intake, and a plan can focus on nutrient-dense meals and strength work.'
    },
    {
      id: 'healthy',
      label: 'Healthy weight',
      range: '18.5 – 24.9',
      min: 18.5,
      max: 25,
      summary:
        'Your weight sits in the range linked with the lowest health risk for most adults. Keep the habits that got you here: regular meals, steady movement and consistent sleep.'
    },
    {
      id: 'overweight',
      label: 'Overweight',
      range: '25.0 – 29.9',
      min: 25,
      max: 30,
      summary:
        'Above the healthy range. Losing a small amount — around 5% of body weight — often improves blood pressure, blood sugar and energy levels.'
    },
    {
      id: 'obesity-1',
      label: 'Obesity class I',
      range: '30.0 – 34.9',
      min: 30,
      max: 35,
      summary:
        'This range raises the risk of type 2 diabetes, high blood pressure and joint strain. A clinician can help set a realistic target and choose support that fits your routine.'
    },
    {
      id: 'obesity-2',
      label: 'Obesity class II',
      range: '35.0 – 39.9',
      min: 35,
      max: 40,
      summary:
        'A higher risk of weight-related conditions. Structured support — nutrition guidance, activity planning and medical review — is worth arranging early.'
    },
    {
      id: 'obesity-3',
      label: 'Obesity class III',
      range: '40.0 and above',
      min: 40,
      max: Infinity,
      summary:
        'The highest BMI category and the highest health risk. Speak with a healthcare professional about supervised options rather than starting an extreme diet alone.'
    }
  ];

  var LIMITS = {
    minHeight: 50,
    maxHeight: 260,
    minWeight: 20,
    maxWeight: 400
  };

  function isNumber(value) {
    return typeof value === 'number' && isFinite(value);
  }

  function categoryFor(bmi) {
    for (var i = 0; i < CATEGORIES.length; i += 1) {
      if (bmi >= CATEGORIES[i].min && bmi < CATEGORIES[i].max) {
        return CATEGORIES[i];
      }
    }
    return CATEGORIES[CATEGORIES.length - 1];
  }

  function validate(heightCm, weightKg) {
    if (!isNumber(heightCm) || !isNumber(weightKg)) {
      return 'Please enter both your height and weight.';
    }
    if (heightCm < LIMITS.minHeight || heightCm > LIMITS.maxHeight) {
      return 'Height must be between 50 and 260 cm.';
    }
    if (weightKg < LIMITS.minWeight || weightKg > LIMITS.maxWeight) {
      return 'Weight must be between 20 and 400 kg.';
    }
    return null;
  }

  function computeBmi(heightCm, weightKg) {
    var problem = validate(heightCm, weightKg);
    if (problem) {
      return { ok: false, error: problem };
    }

    var metres = heightCm / 100;
    var bmi = weightKg / (metres * metres);
    var rounded = Math.round(bmi * 10) / 10;

    return {
      ok: true,
      bmi: bmi,
      rounded: rounded,
      category: categoryFor(rounded)
    };
  }

  return {
    CATEGORIES: CATEGORIES,
    LIMITS: LIMITS,
    computeBmi: computeBmi,
    categoryFor: categoryFor,
    validate: validate
  };
});
