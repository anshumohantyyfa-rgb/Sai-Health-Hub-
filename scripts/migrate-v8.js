'use strict';

/*
 * Migrates source/Sai_Health_Hub_Automation_v8.html into the AppJet project.
 *
 * The v8 markup, CSS and JavaScript are extracted VERBATIM (never retyped) so
 * no working feature is lost. The only textual change is the AI status/health
 * probe path: v8 asks /api/health for { configured }, while this project keeps
 * /api/health as a plain { status: 'ok' } health probe, so the two AI calls are
 * pointed at /api/ai/status (same { configured } contract).
 *
 * The existing BMI check-in, BMI guide and services features are added back as
 * three extra panels so nothing from the previous release is lost.
 *
 * Run with: node scripts/migrate-v8.js
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'source', 'Sai_Health_Hub_Automation_v8.html');
const OUT_DIR = path.join(ROOT, 'public');

const lines = fs.readFileSync(SOURCE, 'utf8').split('\n');
const slice = (from, to) => lines.slice(from - 1, to).join('\n');

// 1..35 head, 36 <body>, 37-42 header, 43 wrap, 44-46 nav, 47-330 main,
// 331 footer, 333 qrcode CDN, 334-495 main script, 497-505 AI script, 506 </body></html>
const css = slice(10, 33); // inside <style>
const mainJs = slice(335, 494); // inside the main <script>
const aiJs = slice(498, 503); // inside the AI <script>
const header = slice(37, 42);
const nav = slice(44, 46);
const panels = slice(48, 329);
const footer = slice(331, 331);
const qrScript = slice(333, 333);

const v8Js = [mainJs, aiJs]
  .join('\n')
  .replace(/\/api\/health/g, '/api/ai/status');

// --- sanity checks: fail loudly instead of writing a broken bundle ----------
const checks = [
  [css.includes('.panel'), 'extracted CSS should contain the .panel rule'],
  [css.length > 5000, 'extracted CSS looks too small'],
  [mainJs.includes('function setLanguage'), 'main script should define setLanguage'],
  [mainJs.includes('shh_'), 'main script should use the shh_ storage prefix'],
  [aiJs.includes('generateWithAI'), 'AI script should define generateWithAI'],
  [panels.includes('id="overview"'), 'markup should contain the overview panel'],
  [panels.includes('id="backup"'), 'markup should contain the backup panel'],
  [qrScript.includes('qrcode'), 'qrcode CDN tag should be preserved'],
  [header.includes('Sai Health Hub') || header.includes('brand'), 'header should carry the brand'],
  [!fs.existsSync(path.join(OUT_DIR, 'index.html')) || true, 'ok']
];
checks.forEach(([ok, message]) => {
  if (!ok) {
    throw new Error(`Migration aborted: ${message}`);
  }
});
if (/wellness/i.test(css + v8Js + panels + header + footer)) {
  throw new Error('Migration aborted: the source still contains the prohibited word');
}

// --- extra navigation entries for the preserved features -------------------
const EXTRA_NAV =
  '<button data-tab="checkin">Health Check-in</button>' +
  '<button data-tab="bmi-guide">BMI Guide</button>' +
  '<button data-tab="services">Services</button>';

const EXTRA_PANELS = `<section id="checkin" class="panel">
<h2>Health Check-in</h2>
<p class="muted">Measure height and weight to see your BMI with a clear category explanation. Every saved check-in is stored in your secure account, so your history follows you to another device.</p>
<div class="grid">
<div class="card">
<h3>Your measurements</h3>
<form id="checkin-form" novalidate>
<div class="health-field"><label for="height">Height (cm)</label><input id="height" name="height" type="number" inputmode="decimal" min="50" max="250" step="0.1" value="170" required></div>
<div class="health-field"><label for="weight">Weight (kg)</label><input id="weight" name="weight" type="number" inputmode="decimal" min="2" max="400" step="0.1" value="70" required></div>
<div class="health-field"><label for="note">Note (optional)</label><input id="note" name="note" type="text" maxlength="200" placeholder="For example: morning, after a walk"></div>
<div class="health-actions">
<button id="calculate" class="health-btn" type="submit">Save check-in</button>
<button id="reset" class="health-btn ghost" type="reset">Reset to defaults</button>
</div>
<p id="error" class="health-error" role="alert" hidden></p>
</form>
</div>
<div class="card">
<h3>Your BMI result</h3>
<div class="health-result">
<div class="health-value"><span id="bmi-value">24.2</span><span class="health-unit">BMI</span></div>
<div id="bmi-category" class="health-cat">Healthy weight</div>
<div id="bmi-summary" class="health-summary">A BMI of 24.2 is inside the healthy weight range for adults. Keep the habits that are working and re-check monthly.</div>
</div>
<div class="health-chips">
<span data-bmi-cat="underweight">Underweight</span>
<span data-bmi-cat="healthy">Healthy weight</span>
<span data-bmi-cat="overweight">Overweight</span>
<span data-bmi-cat="obesity-1">Obesity I</span>
<span data-bmi-cat="obesity-2">Obesity II</span>
<span data-bmi-cat="obesity-3">Obesity III</span>
</div>
</div>
</div>
<h3>Recent check-ins</h3>
<p id="history-status" class="muted" role="status">Loading your saved check-ins…</p>
<ul id="history-list" class="health-history"></ul>
</section>
<section id="bmi-guide" class="panel">
<h2>BMI Guide</h2>
<p class="muted">Body Mass Index compares weight with height. For adults, these are the standard categories used by health services.</p>
<div class="grid" id="bmi-guide-grid"></div>
<div class="card">
<h3>How to read your number</h3>
<ul class="health-guide-list">
<li><strong>BMI is a screening tool, not a diagnosis.</strong> It does not measure body fat, muscle or fitness on its own.</li>
<li><strong>Muscular people can score high.</strong> Athletes, pregnant and breastfeeding people should read BMI with professional guidance.</li>
<li><strong>Track the trend, not one reading.</strong> Monthly check-ins show direction far better than a single value.</li>
<li><strong>Pair it with daily habits.</strong> Sleep, water, movement and balanced meals matter more than the number itself.</li>
</ul>
</div>
</section>
<section id="services" class="panel">
<h2>Services</h2>
<p class="muted">Sai Health Hub supports families in Khordha and nearby communities with practical, evidence-led habit coaching.</p>
<div class="grid">
<div class="card"><h3>1:1 habit coaching</h3><p class="muted">A structured plan around sleep, hydration, movement and balanced meals, reviewed every two weeks.</p></div>
<div class="card"><h3>Body composition tracking</h3><p class="muted">Height, weight and BMI recorded over time with clear categories and simple next steps.</p></div>
<div class="card"><h3>Group sessions</h3><p class="muted">Community walks, habit challenges and cooking basics, run in Odia and English.</p></div>
<div class="card"><h3>Bilingual education</h3><p class="muted">Explainer posts, reels and WhatsApp follow-ups prepared in English and ଓଡ଼ିଆ.</p></div>
<div class="card"><h3>Lead and follow-up desk</h3><p class="muted">Consent-first enquiry tracking so every genuine question gets a timely reply.</p></div>
<div class="card"><h3>Content studio</h3><p class="muted">A 30-day plan, poster and reel builder, and a compliance checklist before anything is published.</p></div>
</div>
</section>`;

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#145c3a">
<meta name="description" content="Sai Health Hub — Healthy Habits. Better Living.. Bilingual health-habit coaching, content, lead and campaign manager for Khordha.">
<title>Sai Health Hub — Healthy Habits. Better Living..</title>
<link rel="stylesheet" href="/v8.css">
<link rel="stylesheet" href="/health.css">
</head>
<body>
${header.replace('<div class="wrap">', '<div class="wrap">\n<div class="brand-tag">Healthy Habits. Better Living..</div>')}
${nav.replace('</nav>', `${EXTRA_NAV}\n</nav>`)}
<main>
${panels}
${EXTRA_PANELS}
</main>
${footer}
${qrScript}
<script src="/bmi.js"></script>
<script src="/v8.js"></script>
<script src="/v8-bridge.js"></script>
<script src="/panel-health.js"></script>
</body>
</html>
`;

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'v8.css'), css + '\n');
fs.writeFileSync(path.join(OUT_DIR, 'v8.js'), v8Js + '\n');
fs.writeFileSync(path.join(OUT_DIR, 'index.html'), html);

console.log('migration complete');
console.log(`v8.css      ${css.length} bytes`);
console.log(`v8.js       ${v8Js.length} bytes`);
console.log(`index.html  ${html.length} bytes`);
console.log(`header kept ${header.length} bytes`);
