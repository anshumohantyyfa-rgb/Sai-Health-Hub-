'use strict';

/*
 * Mobile navigation regression check for Sai Health Hub.
 *
 * Verifies the mobile redesign at the widths the brief calls out (360, 375,
 * 393, 412 px in portrait and landscape) plus the desktop breakpoint:
 *   - no horizontal scrolling or right-side overflow,
 *   - compact top bar with a hamburger,
 *   - designed Home dashboard (hero, feature grid, banner, Quick Access) as the
 *     default mobile view, with cards that open the real panels,
 *   - All Modules page with a two-column card grid covering every tab,
 *     Back to Home and the footer note,
 *   - fixed bottom navigation: Home, Customers, WhatsApp, Reports, More,
 *   - More and the hamburger both open All Modules,
 *   - tab switching still activates the real panels,
 *   - desktop keeps its original header and tab strip.
 */

const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 4399;
const BASE = `http://127.0.0.1:${PORT}`;
const REPO = path.join(__dirname, '..');

function loadPlaywright() {
  const candidates = [
    'playwright',
    '/opt/appjet/browser/node_modules/playwright',
    '/opt/appjet/browser/node_modules/playwright-core',
  ];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (err) {
      /* try the next location */
    }
  }
  throw new Error('Playwright is not available for the mobile navigation check');
}

function waitForServer(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start in time')), timeoutMs);
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early with code ${code}`));
    });
  });
}

const PORTRAIT = [
  { width: 360, height: 800, name: '360x800 portrait' },
  { width: 375, height: 812, name: '375x812 portrait' },
  { width: 393, height: 851, name: '393x851 portrait' },
  { width: 412, height: 915, name: '412x915 portrait' },
];

const LANDSCAPE = PORTRAIT.map((v) => ({
  width: v.height,
  height: v.width,
  name: `${v.width}x${v.height} landscape`,
}));

async function overflowReport(page) {
  return page.evaluate(() => {
    const viewport = window.innerWidth;
    const docWidth = document.documentElement.scrollWidth;
    const bodyWidth = document.body.scrollWidth;
    const offenders = [];
    document.querySelectorAll('body *').forEach((el) => {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.position === 'fixed') return;
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.right > viewport + 1) {
        offenders.push(`${el.tagName.toLowerCase()}#${el.id}.${el.className}`.slice(0, 90));
      }
    });
    return { viewport, docWidth, bodyWidth, offenders: offenders.slice(0, 5) };
  });
}

async function checkViewport(browser, viewport) {
  const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.waitForSelector('.m-bottomnav', { state: 'visible' });
  await page.waitForTimeout(250);

  // 1. No horizontal scrolling at rest.
  let report = await overflowReport(page);
  assert.ok(
    report.docWidth <= report.viewport + 1,
    `${viewport.name}: document scrolls horizontally (${report.docWidth} > ${report.viewport})`
  );
  assert.ok(
    report.bodyWidth <= report.viewport + 1,
    `${viewport.name}: body wider than viewport (${report.bodyWidth} > ${report.viewport})`
  );
  assert.deepStrictEqual(report.offenders, [], `${viewport.name}: elements overflow the right edge`);

  // 2. Compact top bar with hamburger and the exact tagline.
  assert.ok(await page.locator('#mTopbar').isVisible(), `${viewport.name}: compact top bar is hidden`);
  assert.ok(await page.locator('#mMenuBtn').isVisible(), `${viewport.name}: hamburger is hidden`);
  assert.strictEqual(
    (await page.locator('#mTopbar .m-brand span').textContent()).trim(),
    'Healthy Habits. Better Living..',
    `${viewport.name}: tagline changed`
  );
  assert.ok(!(await page.locator('#nav').isVisible()), `${viewport.name}: desktop tab strip should be hidden`);
  assert.ok(!(await page.locator('header').isVisible()), `${viewport.name}: tall hero header should be hidden`);

  // 2b. The designed Home dashboard is the default mobile view.
  assert.ok(await page.locator('#mHome').isVisible(), `${viewport.name}: designed Home is not shown by default`);
  assert.strictEqual(
    (await page.locator('#mHome .m-hero-title').innerText()).replace(/\s+/g, ' ').trim(),
    'Your Health Our Priority',
    `${viewport.name}: hero heading text changed`
  );
  assert.ok(await page.locator('#mHome .m-hero-art').isVisible(), `${viewport.name}: hero artwork is missing`);
  assert.strictEqual(await page.locator('#mHome .m-feat').count(), 4, `${viewport.name}: feature grid must have 4 cards`);
  assert.strictEqual(
    await page.locator('#mHome .m-feat .m-feat-ico svg').count(),
    4,
    `${viewport.name}: feature cards are missing their icons`
  );
  assert.strictEqual(
    await page.locator('#mHome .m-quick-card').count(),
    4,
    `${viewport.name}: Quick Access must have 4 cards`
  );
  assert.ok(await page.locator('#mHome .m-banner').isVisible(), `${viewport.name}: business banner is missing`);
  assert.strictEqual(
    (await page.locator('#mHome .m-banner b').innerText()).trim(),
    'Grow Your Business',
    `${viewport.name}: business banner text changed`
  );
  assert.ok(
    await page.locator('.m-bottomnav .m-tab[data-tab="mHome"]').evaluate((el) => el.classList.contains('active')),
    `${viewport.name}: Home tab is not marked active on load`
  );

  // Home cards route to the real module panels.
  await page.locator('#mHome .m-feat[data-tab="content"]').click();
  await page.waitForSelector('#content.active', { state: 'visible' });
  await page.locator('.m-bottomnav .m-tab[data-tab="mHome"]').click();
  await page.waitForSelector('#mHome.active', { state: 'visible' });

  // 3. Fixed bottom navigation with five labelled targets.
  const tabs = page.locator('.m-bottomnav .m-tab');
  assert.strictEqual(await tabs.count(), 5, `${viewport.name}: bottom nav must have 5 tabs`);
  for (const label of ['Home', 'Customers', 'WhatsApp', 'Reports', 'More']) {
    assert.ok(
      await page.locator('.m-bottomnav .m-tab', { hasText: label }).isVisible(),
      `${viewport.name}: bottom tab "${label}" is missing`
    );
  }
  const tabBox = await page.locator('.m-bottomnav .m-tab').first().boundingBox();
  assert.ok(tabBox && tabBox.height >= 44, `${viewport.name}: bottom tab touch target under 44px`);

  // 4. "More" opens All Modules with a two-column grid of every tab.
  await page.locator('.m-bottomnav .m-tab[data-tab="all-modules"]').click();
  await page.waitForSelector('#all-modules.active', { state: 'visible' });
  const navCount = await page.locator('#nav button[data-tab]').count();
  const cardCount = await page.locator('.m-mod-card').count();
  assert.strictEqual(cardCount, navCount, `${viewport.name}: All Modules must list all ${navCount} tabs`);

  const grid = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.m-mod-card')];
    const rects = cards.map((c) => c.getBoundingClientRect());
    return {
      columns: window.getComputedStyle(document.querySelector('.m-modules')).gridTemplateColumns.split(' ').length,
      sameRow: Math.abs(rects[0].top - rects[1].top) < 2,
      secondIsRight: rects[1].left > rects[0].left,
      minHeight: Math.min(...rects.map((r) => r.height)),
    };
  });
  assert.strictEqual(grid.columns, 2, `${viewport.name}: All Modules grid must be two columns`);
  assert.ok(grid.sameRow && grid.secondIsRight, `${viewport.name}: cards are not laid out two per row`);
  assert.ok(grid.minHeight >= 44, `${viewport.name}: module card touch target under 44px`);
  assert.strictEqual(
    await page.locator('.m-mod-card .m-ico svg').count(),
    navCount,
    `${viewport.name}: every module card must show its icon`
  );
  assert.ok(await page.locator('.m-back-home').isVisible(), `${viewport.name}: Back to Home is missing`);
  assert.ok(
    (await page.locator('.m-am-note').innerText()).includes('All modules are easily accessible'),
    `${viewport.name}: All Modules footer note changed`
  );
  assert.ok(
    await page.locator('#mTopbar').evaluate((el) => el.classList.contains('is-modules')),
    `${viewport.name}: header did not switch to the All Modules style`
  );

  report = await overflowReport(page);
  assert.ok(report.docWidth <= report.viewport + 1, `${viewport.name}: All Modules page scrolls horizontally`);
  assert.deepStrictEqual(report.offenders, [], `${viewport.name}: All Modules overflows the right edge`);

  // 5. A card opens the real module panel, and the bottom bar keeps working.
  const bmiCard = page.locator('.m-mod-card', { hasText: 'BMI Guide' });
  await bmiCard.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await bmiCard.click();
  await page.waitForSelector('#bmi-guide.active', { state: 'visible' });
  assert.ok(
    await page.locator('#bmi-guide h2').isVisible(),
    `${viewport.name}: BMI Guide panel did not render`
  );
  assert.ok(
    await page.locator('.m-bottomnav .m-tab[data-tab="mHome"]').isVisible(),
    `${viewport.name}: bottom nav disappeared after navigation`
  );

  // 6. Bottom tabs switch panels; hamburger reopens All Modules.
  await page.locator('.m-bottomnav .m-tab[data-tab="customers"]').click();
  await page.waitForSelector('#customers.active', { state: 'visible' });
  await page.locator('.m-bottomnav .m-tab[data-tab="whatsapp"]').click();
  await page.waitForSelector('#whatsapp.active', { state: 'visible' });
  await page.locator('.m-bottomnav .m-tab[data-tab="metrics"]').click();
  await page.waitForSelector('#metrics.active', { state: 'visible' });
  await page.locator('.m-bottomnav .m-tab[data-tab="mHome"]').click();
  await page.waitForSelector('#mHome.active', { state: 'visible' });
  await page.locator('#mMenuBtn').click();
  await page.waitForSelector('#all-modules.active', { state: 'visible' });

  // 6b. Back to Home returns to the dashboard, and the header returns to normal.
  await page.locator('.m-back-home').click();
  await page.waitForSelector('#mHome.active', { state: 'visible' });
  assert.ok(
    await page.locator('#mTopbar').evaluate((el) => !el.classList.contains('is-modules')),
    `${viewport.name}: header stayed in the All Modules style after leaving it`
  );

  // 7. Branding guard: the prohibited word never appears.
  const text = (await page.locator('body').innerText()).toLowerCase();
  assert.ok(!text.includes('wellness'), `${viewport.name}: prohibited word found in page text`);

  assert.deepStrictEqual(pageErrors, [], `${viewport.name}: page errors: ${pageErrors.join(' | ')}`);
  await page.close();
  return `${viewport.name}: ok`;
}

async function checkDesktop(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.waitForSelector('#nav', { state: 'visible' });

  assert.ok(await page.locator('header').isVisible(), 'desktop: hero header must stay visible');
  assert.ok(await page.locator('#nav').isVisible(), 'desktop: tab strip must stay visible');
  assert.ok(!(await page.locator('.m-bottomnav').isVisible()), 'desktop: bottom nav must stay hidden');
  assert.ok(!(await page.locator('#mTopbar').isVisible()), 'desktop: compact top bar must stay hidden');
  assert.ok(!(await page.locator('#mHome').isVisible()), 'desktop: mobile Home dashboard must stay hidden');
  assert.ok(await page.locator('#overview.active').isVisible(), 'desktop: overview panel must stay the default');

  const report = await overflowReport(page);
  assert.ok(report.docWidth <= report.viewport + 1, `desktop: page scrolls horizontally (${report.docWidth})`);
  assert.strictEqual(
    (await page.locator('header .tag').textContent()).trim(),
    'Healthy Habits. Better Living..',
    'desktop: tagline changed'
  );

  await page.locator('#nav button[data-tab="checkin"]').click();
  await page.waitForSelector('#checkin.active', { state: 'visible' });
  await page.close();
  return 'desktop 1280x900: ok';
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shh-mobile-'));
  const server = spawn(process.execPath, ['server.js'], {
    cwd: REPO,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let browser;
  try {
    await waitForServer(server, 15000);
    const { chromium } = loadPlaywright();
    browser = await chromium.launch();

    const results = [];
    for (const viewport of [...PORTRAIT, ...LANDSCAPE]) {
      results.push(await checkViewport(browser, viewport));
    }
    results.push(await checkDesktop(browser));
    results.forEach((line) => console.log('PASS ' + line));
    console.log(`\nMobile navigation check passed for ${results.length} viewports.`);
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error('FAIL ' + err.message);
  process.exit(1);
});
