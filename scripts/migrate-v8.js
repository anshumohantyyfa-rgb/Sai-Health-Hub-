'use strict';

/*
 * Migrates source/Sai_Health_Hub_Automation_v8.html into the AppJet project.
 *
 * The v8 markup, CSS and JavaScript are extracted VERBATIM (never retyped) so
 * no working feature is lost. Extraction is marker-based (<style>, <script>,
 * <main>, ...) rather than line-number based, so it cannot silently slice the
 * wrong region.
 *
 * The only textual change is the AI status probe: v8 asks /api/health for
 * { configured }, while this project keeps /api/health as a plain health probe,
 * so those two calls are pointed at /api/ai/status (same { configured } shape).
 *
 * The existing Health Check-in (BMI), BMI Guide and Services features are added
 * back as three extra panels so nothing from the previous release is lost.
 *
 * Run with: node scripts/migrate-v8.js
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'source', 'Sai_Health_Hub_Automation_v8.html');
const OUT_DIR = path.join(ROOT, 'public');

const raw = fs.readFileSync(SOURCE, 'utf8');

function between(text, startMarker, endMarker, from) {
  const start = text.indexOf(startMarker, from || 0);
  if (start === -1) {
    throw new Error(`Migration aborted: missing start marker ${startMarker}`);
  }
  const contentStart = start + startMarker.length;
  const end = text.indexOf(endMarker, contentStart);
  if (end === -1) {
    throw new Error(`Migration aborted: missing end marker ${endMarker}`);
  }
  return text.slice(contentStart, end).trim();
}

const css = between(raw, '<style>', '</style>');
const headerInner = between(raw, '<header>', '</header>');
const navInner = between(raw, '<nav id="nav">', '</nav>');
const panels = between(raw, '<main>', '</main>');

const footerStart = raw.indexOf('<footer');
const footerEnd = raw.indexOf('</footer>', footerStart);
if (footerStart === -1 || footerEnd === -1) {
  throw new Error('Migration aborted: footer not found');
}
const footer = raw.slice(footerStart, footerEnd + '</footer>'.length).trim();

// Script tags: the external qrcode CDN tag is preserved, and the two inline
// blocks are the app script and the AI prompt script, in document order.
const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/g;
const externalTags = [];
const inlineBlocks = [];
let match;
while ((match = scriptRe.exec(raw)) !== null) {
  if (/\bsrc=/.test(match[1])) {
    externalTags.push(match[0]);
  } else if (match[2].trim()) {
    inlineBlocks.push(match[2]);
  }
}

const qrScript = externalTags.filter((tag) => /qrcode/i.test(tag)).join('\n') || externalTags[0] || '';
const mainJs = inlineBlocks[0] || '';
const aiJs = inlineBlocks[1] || '';

// v8's AI status probe expects { configured }; /api/ai/status provides it.
// The copy patches keep the UI honest about which provider answered and turn a
// provider outage into an actionable message instead of a silently dead button.
function applyAiCopyPatches(source) {
  const patches = [
    [
      "el.textContent=j.configured?'AI backend connected · Gemini text generation available.':'Backend is online, but GEMINI_API_KEY is not configured yet.';",
      "el.textContent=j.configured?'AI backend connected · '+(j.model||'AI model')+' ready via '+(j.provider||'server')+'.':'Backend is online, but no AI provider is configured yet.';"
    ],
    [
      "status.textContent='Sending your creative brief to Gemini…';",
      "status.textContent='Sending your creative brief to the AI service…';"
    ],
    [
      "catch(e){status.textContent='Could not generate: '+e.message;}",
      "catch(e){status.textContent='Could not generate: '+e.message+' Your brief is unchanged, so you can press Generate again.';}"
    ],
    [
      "'AI not connected: '+e.message+' This feature needs the secure server endpoint; the standalone HTML does not contain an AI model or API key.'",
      "'AI not connected: '+e.message+' The server-side AI service could not be reached. Try again in a moment.'"
    ]
  ];
  return patches.reduce((text, [from, to]) => {
    if (!text.includes(from)) {
      throw new Error(`Migration aborted: AI copy anchor not found (${from.slice(0, 50)}...)`);
    }
    return text.split(from).join(to);
  }, source);
}

const v8Js = applyAiCopyPatches(
  [mainJs, aiJs].join('\n').replace(/\/api\/health/g, '/api/ai/status')
);

// --- sanity checks: fail loudly instead of writing a broken bundle ----------
const checks = [
  [css.includes('.panel'), 'extracted CSS should contain the .panel rule'],
  [css.length > 2500, 'extracted CSS looks too small'],
  [mainJs.includes('function setLanguage'), 'main script should define setLanguage'],
  [mainJs.includes('shh_'), 'main script should use the shh_ storage prefix'],
  [aiJs.includes('generateWithAI'), 'AI script should define generateWithAI'],
  [panels.includes('id="overview"'), 'markup should contain the overview panel'],
  [panels.includes('id="backup"'), 'markup should contain the backup panel'],
  [panels.includes('id="metrics"'), 'markup should contain the metrics panel'],
  [qrScript.includes('qrcode'), 'qrcode CDN tag should be preserved'],
  [navInner.includes('data-tab="overview"'), 'navigation should keep the overview tab'],
  [/sai health hub/i.test(headerInner), 'header should carry the brand name'],
  [/Healthy Habits\. Better Living\.\./.test(headerInner), 'header should carry the approved tagline'],
  [mainJs.length > 40000, 'main script looks too small'],
  [aiJs.length > 1000, 'AI script looks too small']
];
checks.forEach(([ok, message]) => {
  if (!ok) {
    throw new Error(`Migration aborted: ${message}`);
  }
});
if (/wellness/i.test(css + v8Js + panels + headerInner + footer + navInner)) {
  throw new Error('Migration aborted: the source still contains the prohibited word');
}

// --- extra navigation entries for the preserved features -------------------
// v8 styles a .toptools language switch and calls $('langEn') / $('langOr'), but
// that markup was missing from the v8 file itself, so setLanguage() threw on
// load. Restoring the control (styled by v8's own .toptools rules) repairs the
// bilingual toggle.
const LANG_TOOLS =
  '<div class="toptools"><span>Language</span>' +
  '<button id="langEn" type="button" class="langactive" onclick="setLanguage(\'en\')">English</button>' +
  '<button id="langOr" type="button" onclick="setLanguage(\'or\')">ଓଡ଼ିଆ</button></div>';

const EXTRA_NAV =
  '<button data-tab="checkin" data-en="Health Check-in" data-or="ସ୍ୱାସ୍ଥ୍ୟ ଯାଞ୍ଚ">Health Check-in</button>' +
  '<button data-tab="bmi-guide" data-en="BMI Guide" data-or="BMI ମାର୍ଗଦର୍ଶିକା">BMI Guide</button>' +
  '<button data-tab="services" data-en="Services" data-or="ସେବାଗୁଡ଼ିକ">Services</button>';

const EXTRA_PANELS = `<section id="checkin" class="panel">
<h2>Health Check-in</h2>
<p class="muted">Measure height and weight to see your BMI with a clear category explanation. Every saved check-in is stored on the server, so your history is there when you return.</p>
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

// The v8 header prints the brand in caps and already carries the approved
// tagline on its .tag line, so only the casing of the name is normalised.
const headerHtml = headerInner
  .replace(/>SAI HEALTH HUB</, '>Sai Health Hub<')
  .replace(/<\/div>$/, `${LANG_TOOLS}</div>`);
if (!headerHtml.includes('Sai Health Hub')) {
  throw new Error('Migration aborted: brand name missing from the header');
}
if (!headerHtml.includes('id="langEn"') || !headerHtml.includes('id="langOr"')) {
  throw new Error('Migration aborted: the language switch was not inserted');
}

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
<header>
${headerHtml}
</header>
<nav id="nav">
${navInner}
${EXTRA_NAV}
</nav>
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
console.log(`panels      ${(panels.match(/<section /g) || []).length} migrated + 3 preserved`);
