'use strict';

/*
 * Owner console.
 *
 * Everything here talks to authenticated, server-side endpoints:
 *   /api/owner/session, /login, /setup, /logout
 *   /api/owner/records/:collection  (customers, checkins, leads, followups)
 *   /api/owner/reminders            (computed follow-up work queue)
 *   /api/owner/whatsapp/draft       (AI draft + wa.me handoff link)
 *
 * Customer data is only rendered for a signed-in owner. When no session exists
 * the console shows the sign-in card and never fetches records.
 */

(function () {
  const root = () => document.getElementById('ownerRoot');
  const lang = () => {
    try {
      return JSON.parse(localStorage.getItem('shh_language') || '"en"');
    } catch (err) {
      return 'en';
    }
  };
  const t = (en, or) => (lang() === 'or' ? or : en);
  const esc = (value) =>
    String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[ch]));

  const state = {
    session: { authenticated: false, passwordConfigured: false, source: 'none' },
    customers: [],
    checkins: [],
    leads: [],
    followups: [],
    reminders: [],
    summary: null,
    editingCustomer: null,
    draft: null,
    message: '',
    messageKind: ''
  };

  async function api(path, options) {
    const opts = Object.assign({ credentials: 'same-origin', headers: { Accept: 'application/json' } }, options || {});
    if (opts.body && typeof opts.body !== 'string') {
      opts.body = JSON.stringify(opts.body);
    }
    if (opts.body && !opts.headers['Content-Type']) {
      opts.headers = Object.assign({}, opts.headers, { 'Content-Type': 'application/json' });
    }
    const res = await fetch(path, opts);
    let payload = {};
    try {
      payload = await res.json();
    } catch (err) {
      payload = {};
    }
    if (!res.ok) {
      const error = new Error(payload.error || `Request failed (${res.status}).`);
      error.status = res.status;
      throw error;
    }
    return payload;
  }

  function setMessage(text, kind) {
    state.message = text || '';
    state.messageKind = kind || '';
  }

  /* ---------------------------------------------------------------- rendering */

  function signInCard() {
    const setup = !state.session.passwordConfigured;
    return `
      <div class="owner-card owner-lock">
        <h3>${setup ? t('Create owner password', 'ମାଲିକ ପାସୱାର୍ଡ ତିଆରି କରନ୍ତୁ') : t('Owner sign in', 'ମାଲିକ ସାଇନ ଇନ')}</h3>
        <p class="owner-hint">${
          setup
            ? t('No owner password is configured yet. Create one now — customer records stay hidden until you sign in.', 'ଏପର୍ଯ୍ୟନ୍ତ କୌଣସି ମାଲିକ ପାସୱାର୍ଡ ସେଟ ହୋଇନାହିଁ। ଏବେ ଗୋଟିଏ ତିଆରି କରନ୍ତୁ — ସାଇନ ଇନ ନହେବା ପର୍ଯ୍ୟନ୍ତ ଗ୍ରାହକ ତଥ୍ୟ ଦେଖାଯିବ ନାହିଁ।')
            : t('Enter the owner password to open customer records, reminders and WhatsApp drafts.', 'ଗ୍ରାହକ ତଥ୍ୟ, ସ୍ମରଣ ଓ WhatsApp ଡ୍ରାଫ୍ଟ ଖୋଲିବା ପାଇଁ ମାଲିକ ପାସୱାର୍ଡ ଦିଅନ୍ତୁ।')
        }</p>
        <form data-act="${setup ? 'setup' : 'login'}" autocomplete="off">
          <label class="owner-field">${t('Password', 'ପାସୱାର୍ଡ')}
            <input type="password" name="password" minlength="8" required autocomplete="${setup ? 'new-password' : 'current-password'}">
          </label>
          ${
            setup
              ? `<label class="owner-field" style="margin-top:10px">${t('Confirm password', 'ପାସୱାର୍ଡ ନିଶ୍ଚିତ କରନ୍ତୁ')}
                   <input type="password" name="confirm" minlength="8" required autocomplete="new-password">
                 </label>`
              : ''
          }
          <div class="owner-actions"><button class="owner-btn" type="submit">${setup ? t('Create and sign in', 'ତିଆରି କରି ସାଇନ ଇନ') : t('Sign in', 'ସାଇନ ଇନ')}</button></div>
        </form>
        <p class="owner-note" style="margin-top:12px">${
          setup
            ? t('For stricter control, set OWNER_PASSWORD in Settings → Environment variables instead; that value always takes priority.', 'କଡ଼ା ନିୟନ୍ତ୍ରଣ ପାଇଁ Settings → Environment variables ରେ OWNER_PASSWORD ସେଟ କରନ୍ତୁ; ସେହି ମୂଲ୍ୟ ସର୍ବଦା ପ୍ରାଥମିକ।')
            : t('Sessions last 8 hours and the password is stored only as a scrypt hash on the server.', 'ସେସନ ୮ ଘଣ୍ଟା ରହେ ଏବଂ ପାସୱାର୍ଡ ସର୍ଭରରେ କେବଳ scrypt ହ୍ୟାସ ଭାବରେ ରହେ।')
        }</p>
        ${messageHtml()}
      </div>`;
  }

  function messageHtml() {
    if (!state.message) return '<p class="owner-msg"></p>';
    const cls = state.messageKind === 'error' ? 'error' : state.messageKind === 'ok' ? 'ok' : '';
    return `<p class="owner-msg ${cls}" role="status">${esc(state.message)}</p>`;
  }

  function statsCard() {
    const s = state.summary || {};
    const counts = s.counts || {};
    const items = [
      [t('Customers', 'ଗ୍ରାହକ'), counts.customers || 0],
      [t('Coaching check-ins', 'କୋଚିଂ ଯାଞ୍ଚ'), counts.checkins || 0],
      [t('BMI check-ins (server)', 'BMI ଯାଞ୍ଚ (ସର୍ଭର)'), s.bmiCheckins || 0],
      [t('Open leads', 'ଖୋଲା ଲିଡ'), s.openLeads || 0],
      [t('Follow-ups due', 'ସମୟ ହୋଇଥିବା ଫଲୋଅପ'), s.remindersDue || 0]
    ];
    return `<div class="owner-card"><h3>${t('Owner overview', 'ମାଲିକ ସାରାଂଶ')}</h3>
      <p class="owner-hint">${t('Live counts from the server store, not this browser.', 'ଏହି ବ୍ରାଉଜର ନୁହେଁ, ସର୍ଭର ଷ୍ଟୋରରୁ ଲାଇଭ ଗଣନା।')}</p>
      <div class="owner-stats">${items
        .map(([label, value]) => `<div class="owner-stat"><b>${esc(value)}</b><span>${esc(label)}</span></div>`)
        .join('')}</div></div>`;
  }

  function customerForm() {
    const c = state.customers.find((x) => String(x.id) === String(state.editingCustomer)) || null;
    return `<div class="owner-card">
      <h3>${c ? t('Edit customer', 'ଗ୍ରାହକ ସମ୍ପାଦନ') : t('Add customer', 'ଗ୍ରାହକ ଯୋଡ଼ନ୍ତୁ')}</h3>
      <p class="owner-hint">${t('Saved to the server database. Consent is required before storing coaching details.', 'ସର୍ଭର ଡାଟାବେସରେ ସେଭ ହୁଏ। କୋଚିଂ ବିବରଣୀ ରଖିବା ପୂର୍ବରୁ ସମ୍ମତି ଆବଶ୍ୟକ।')}</p>
      <form data-act="customer-save">
        <div class="owner-grid">
          <label class="owner-field">${t('Name', 'ନାମ')}<input type="text" name="name" required maxlength="80" value="${esc(c ? c.name : '')}"></label>
          <label class="owner-field">${t('WhatsApp number', 'WhatsApp ନମ୍ବର')}<input type="text" name="contact" maxlength="20" value="${esc(c ? c.contact || '' : '')}"></label>
          <label class="owner-field">${t('Language', 'ଭାଷା')}
            <select name="language">
              <option value="English"${c && c.language === 'English' ? ' selected' : ''}>English</option>
              <option value="Odia"${c && c.language === 'Odia' ? ' selected' : ''}>ଓଡ଼ିଆ</option>
            </select>
          </label>
          <label class="owner-field">${t('Goal', 'ଲକ୍ଷ୍ୟ')}<input type="text" name="goal" maxlength="120" value="${esc(c ? c.goal || '' : '')}"></label>
        </div>
        <label class="owner-field" style="margin-top:10px;display:flex;gap:8px;align-items:center">
          <input type="checkbox" name="consent"${c && c.consent ? ' checked' : ''} style="width:auto">
          <span>${t('Customer agreed to this record being stored.', 'ଗ୍ରାହକ ଏହି ରେକର୍ଡ ସଂରକ୍ଷଣରେ ସମ୍ମତ ହୋଇଛନ୍ତି।')}</span>
        </label>
        <div class="owner-actions">
          <button class="owner-btn" type="submit">${c ? t('Save changes', 'ପରିବର୍ତ୍ତନ ସେଭ') : t('Add customer', 'ଗ୍ରାହକ ଯୋଡ଼ନ୍ତୁ')}</button>
          ${c ? `<button class="owner-btn secondary" type="button" data-act="customer-cancel">${t('Cancel', 'ବାତିଲ')}</button>` : ''}
        </div>
      </form>
      ${messageHtml()}
    </div>`;
  }

  function customersCard() {
    const rows = state.customers
      .map((c) => {
        const checks = state.checkins.filter((x) => String(x.customerId) === String(c.id)).length;
        return `<tr>
          <td><strong>${esc(c.name)}</strong><div class="muted">${esc(c.contact || '—')}</div></td>
          <td>${esc(c.language || 'English')}</td>
          <td>${esc(c.goal || '—')}</td>
          <td>${checks}</td>
          <td><span class="owner-pill${c.consent ? '' : ' warn'}">${c.consent ? t('Consented', 'ସମ୍ମତ') : t('No consent', 'ସମ୍ମତି ନାହିଁ')}</span></td>
          <td style="white-space:nowrap">
            <button class="owner-btn secondary" data-act="customer-edit" data-id="${esc(c.id)}">${t('Edit', 'ସମ୍ପାଦନ')}</button>
            <button class="owner-btn danger" data-act="customer-delete" data-id="${esc(c.id)}">${t('Delete', 'ଡିଲିଟ')}</button>
          </td>
        </tr>`;
      })
      .join('');
    return `<div class="owner-card">
      <h3>${t('Customers', 'ଗ୍ରାହକ')}</h3>
      <p class="owner-hint">${t('Stored on the server, so records survive reloads and other devices.', 'ସର୍ଭରରେ ସଂରକ୍ଷିତ, ତେଣୁ ରିଲୋଡ ଓ ଅନ୍ୟ ଡିଭାଇସରେ ରେକର୍ଡ ରହେ।')}</p>
      ${
        state.customers.length
          ? `<div class="owner-table-wrap"><table class="owner-table"><thead><tr>
               <th>${t('Customer', 'ଗ୍ରାହକ')}</th><th>${t('Language', 'ଭାଷା')}</th><th>${t('Goal', 'ଲକ୍ଷ୍ୟ')}</th>
               <th>${t('Check-ins', 'ଯାଞ୍ଚ')}</th><th>${t('Consent', 'ସମ୍ମତି')}</th><th>${t('Actions', 'କାର୍ଯ୍ୟ')}</th>
             </tr></thead><tbody>${rows}</tbody></table></div>`
          : `<p class="owner-empty">${t('No customers yet. Add the first one above.', 'ଏପର୍ଯ୍ୟନ୍ତ ଗ୍ରାହକ ନାହିଁ। ଉପରେ ପ୍ରଥମ ଯୋଡ଼ନ୍ତୁ।')}</p>`
      }
    </div>`;
  }

  function remindersCard() {
    const items = state.reminders
      .map(
        (r) => `<div class="owner-item">
          <strong>${esc(r.name)}</strong>
          <div class="muted">${esc(r.reason)}</div>
          <div class="owner-badge-row">
            <span class="owner-pill${r.daysOverdue > 0 ? ' due' : r.daysOverdue === 0 ? ' warn' : ''}">${
              r.daysOverdue > 0
                ? t(`${r.daysOverdue} day(s) overdue`, `${r.daysOverdue} ଦିନ ବିଳମ୍ବ`)
                : r.daysOverdue === 0
                ? t('Due today', 'ଆଜି ଦେୟ')
                : t(`In ${Math.abs(r.daysOverdue)} day(s)`, `${Math.abs(r.daysOverdue)} ଦିନରେ`)
            }</span>
            ${r.contact ? `<span class="owner-pill">${esc(r.contact)}</span>` : ''}
          </div>
          <div class="owner-actions">
            ${
              r.consent
                ? `<button class="owner-btn secondary" data-act="draft-wa" data-kind="${esc(r.type)}" data-id="${esc(r.id)}">${t('Draft WhatsApp message', 'WhatsApp ସନ୍ଦେଶ ଡ୍ରାଫ୍ଟ')}</button>`
                : `<span class="owner-note">${t('Follow-up disabled: no consent recorded.', 'ଫଲୋଅପ ବନ୍ଦ: ସମ୍ମତି ନାହିଁ।')}</span>`
            }
            ${r.followupId ? `<button class="owner-btn" data-act="reminder-done" data-id="${esc(r.followupId)}">${t('Mark done', 'ସମ୍ପୂର୍ଣ୍ଣ ଚିହ୍ନଟ')}</button>` : ''}
          </div>
        </div>`
      )
      .join('');
    return `<div class="owner-card">
      <h3>${t('Follow-up reminders', 'ଫଲୋଅପ ସ୍ମରଣ')}</h3>
      <p class="owner-hint">${t('Computed on the server from follow-up dates, lead age and check-in gaps. Nothing is sent automatically.', 'ଫଲୋଅପ ତାରିଖ, ଲିଡ ବୟସ ଓ ଯାଞ୍ଚ ଅନ୍ତରରୁ ସର୍ଭରରେ ଗଣନା। କିଛି ସ୍ୱୟଂଚାଳିତ ପଠାଯାଏ ନାହିଁ।')}</p>
      ${items ? `<div class="owner-list">${items}</div>` : `<p class="owner-empty">${t('Nothing due right now.', 'ବର୍ତ୍ତମାନ କିଛି ଦେୟ ନାହିଁ।')}</p>`}
    </div>`;
  }

  function whatsappCard() {
    const draft = state.draft;
    return `<div class="owner-card">
      <h3>${t('WhatsApp message generator', 'WhatsApp ସନ୍ଦେଶ ଜେନେରେଟର')}</h3>
      <p class="owner-hint">${t('Generates the message and a wa.me link. You still press send inside WhatsApp — this app cannot deliver messages on its own.', 'ସନ୍ଦେଶ ଓ wa.me ଲିଙ୍କ ତିଆରି କରେ। ପଠାଇବା ପାଇଁ WhatsApp ରେ ଆପଣ ବଟନ ଦବାନ୍ତୁ — ଏହି ଆପ ସ୍ୱୟଂ ପଠାଇପାରିବ ନାହିଁ।')}</p>
      <form data-act="wa-free">
        <div class="owner-grid">
          <label class="owner-field">${t('Customer', 'ଗ୍ରାହକ')}
            <select name="customerId">
              <option value="">${t('Choose a customer', 'ଗ୍ରାହକ ବାଛନ୍ତୁ')}</option>
              ${state.customers
                .map((c) => `<option value="${esc(c.id)}"${draft && String(draft.customerId) === String(c.id) ? ' selected' : ''}>${esc(c.name)}</option>`)
                .join('')}
            </select>
          </label>
          <label class="owner-field">${t('Language', 'ଭାଷା')}
            <select name="language">
              <option value="en"${draft && draft.language === 'en' ? ' selected' : ''}>English</option>
              <option value="or"${draft && draft.language === 'or' ? ' selected' : ''}>ଓଡ଼ିଆ</option>
            </select>
          </label>
        </div>
        <label class="owner-field" style="margin-top:10px">${t('What is the message about?', 'ସନ୍ଦେଶ କେଉଁ ବିଷୟରେ?')}
          <input type="text" name="purpose" maxlength="160" placeholder="${t('Weekly habit check, consultation reminder…', 'ସାପ୍ତାହିକ ଅଭ୍ୟାସ ଯାଞ୍ଚ, ପରାମର୍ଶ ସ୍ମରଣ…')}">
        </label>
        <div class="owner-actions"><button class="owner-btn" type="submit">${t('Generate message', 'ସନ୍ଦେଶ ତିଆରି କରନ୍ତୁ')}</button></div>
      </form>
      ${
        draft
          ? `<div style="margin-top:14px">
               <label class="owner-field">${t('Draft', 'ଡ୍ରାଫ୍ଟ')}<textarea data-role="draftText">${esc(draft.text)}</textarea></label>
               <div class="owner-actions">
                 <button class="owner-btn secondary" data-act="copy-draft">${t('Copy', 'କପି')}</button>
                 ${draft.waLink ? `<a class="owner-btn" style="text-decoration:none" href="${esc(draft.waLink)}" target="_blank" rel="noopener">${t('Open WhatsApp', 'WhatsApp ଖୋଲନ୍ତୁ')}</a>` : ''}
               </div>
               <p class="owner-note" style="margin-top:8px">${esc(draft.source === 'ai' ? t('AI-generated draft. Review before sending.', 'AI ଦ୍ୱାରା ତିଆରି ଡ୍ରାଫ୍ଟ। ପଠାଇବା ପୂର୍ବରୁ ସମୀକ୍ଷା କରନ୍ତୁ।') : t('AI was unavailable, so a reviewed template was used instead.', 'AI ଉପಲବ୍ଧ ନଥିଲା, ତେଣୁ ସମୀକ୍ଷିତ ଟେମ୍ପଲେଟ ବ୍ୟବହୃତ ହେଲା।'))}</p>
             </div>`
          : ''
      }
    </div>`;
  }

  function checkinsCard() {
    const rows = state.checkins
      .slice(0, 25)
      .map((k) => {
        const customer = state.customers.find((c) => String(c.id) === String(k.customerId));
        return `<tr>
          <td>${esc(customer ? customer.name : t('Unknown customer', 'ଅଜ୍ଞାତ ଗ୍ରାହକ'))}</td>
          <td>${esc(k.date || '—')}</td>
          <td>${esc(k.stage || '—')}</td>
          <td>${esc((k.wins || k.challenges || k.next || '').slice(0, 60))}</td>
          <td><button class="owner-btn danger" data-act="checkin-delete" data-id="${esc(k.id)}">${t('Delete', 'ଡିଲିଟ')}</button></td>
        </tr>`;
      })
      .join('');
    return `<div class="owner-card">
      <h3>${t('Health check-ins (coaching)', 'ସ୍ୱାସ୍ଥ୍ୟ ଯାଞ୍ଚ (କୋଚିଂ)')}</h3>
      <p class="owner-hint">${t('Coaching check-ins are saved in the same server store as the BMI check-ins shown in the stats above.', 'କୋଚିଂ ଯାଞ୍ଚ ଉପର ସାରାଂଶରେ ଦେଖାଯାଉଥିବା BMI ଯାଞ୍ଚ ସହ ସେହି ସର୍ଭର ଷ୍ଟୋରରେ ସେଭ ହୁଏ।')}</p>
      <form data-act="checkin-add">
        <div class="owner-grid">
          <label class="owner-field">${t('Customer', 'ଗ୍ରାହକ')}
            <select name="customerId" required>
              <option value="">${t('Choose', 'ବାଛନ୍ତୁ')}</option>
              ${state.customers.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}
            </select>
          </label>
          <label class="owner-field">${t('Date', 'ତାରିଖ')}<input type="date" name="date" value="${new Date().toISOString().slice(0, 10)}"></label>
          <label class="owner-field">${t('Stage', 'ପର୍ଯ୍ୟାୟ')}
            <select name="stage">
              <option>Week 1</option><option>Week 2</option><option>Week 4</option><option>Follow-up</option>
            </select>
          </label>
        </div>
        <label class="owner-field" style="margin-top:10px">${t('Note', 'ଟିପ୍ପଣୀ')}<input type="text" name="note" maxlength="200"></label>
        <div class="owner-actions"><button class="owner-btn" type="submit">${t('Save check-in', 'ଯାଞ୍ଚ ସେଭ')}</button></div>
      </form>
      ${
        rows
          ? `<div class="owner-table-wrap" style="margin-top:12px"><table class="owner-table"><thead><tr>
               <th>${t('Customer', 'ଗ୍ରାହକ')}</th><th>${t('Date', 'ତାରିଖ')}</th><th>${t('Stage', 'ପର୍ଯ୍ୟାୟ')}</th><th>${t('Note', 'ଟିପ୍ପଣୀ')}</th><th></th>
             </tr></thead><tbody>${rows}</tbody></table></div>`
          : `<p class="owner-empty" style="margin-top:12px">${t('No coaching check-ins recorded yet.', 'ଏପର୍ଯ୍ୟନ୍ତ କୋଚିଂ ଯାଞ୍ଚ ନାହିଁ।')}</p>`
      }
    </div>`;
  }

  function leadsCard() {
    const rows = state.leads
      .map(
        (l) => `<tr>
          <td><strong>${esc(l.name)}</strong><div class="muted">${esc(l.contact || '—')}</div></td>
          <td>${esc(l.source || '—')}</td>
          <td>${esc(l.date || '—')}</td>
          <td>
            <select data-act="lead-status" data-id="${esc(l.id)}">
              ${['New', 'Contacted', 'Interested', 'Consultation scheduled', 'Customer', 'Not proceeding']
                .map((s) => `<option${s === l.status ? ' selected' : ''}>${s}</option>`)
                .join('')}
            </select>
          </td>
          <td><button class="owner-btn danger" data-act="lead-delete" data-id="${esc(l.id)}">${t('Delete', 'ଡିଲିଟ')}</button></td>
        </tr>`
      )
      .join('');
    return `<div class="owner-card">
      <h3>${t('Lead tracking', 'ଲିଡ ଟ୍ରାକିଂ')}</h3>
      <p class="owner-hint">${t('Status changes are saved to the server immediately.', 'ସ୍ଥିତି ପରିବର୍ତ୍ତନ ସଙ୍ଗେ ସଙ୍ଗେ ସର୍ଭରରେ ସେଭ ହୁଏ।')}</p>
      ${
        rows
          ? `<div class="owner-table-wrap"><table class="owner-table"><thead><tr>
               <th>${t('Lead', 'ଲିଡ')}</th><th>${t('Source', 'ଉତ୍ସ')}</th><th>${t('Date', 'ତାରିଖ')}</th><th>${t('Status', 'ସ୍ଥିତି')}</th><th></th>
             </tr></thead><tbody>${rows}</tbody></table></div>`
          : `<p class="owner-empty">${t('No leads recorded yet.', 'ଏପର୍ଯ୍ୟନ୍ତ ଲିଡ ନାହିଁ।')}</p>`
      }
    </div>`;
  }

  function consoleHtml() {
    return `<div class="owner-wrap">
      <div class="owner-card" style="display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap">
        <div><h3 style="margin:0">${t('Owner console', 'ମାଲିକ କନସୋଲ')}</h3>
        <p class="owner-hint" style="margin:4px 0 0">${t('Signed in. Password source:', 'ସାଇନ ଇନ ଅଛି। ପାସୱାର୍ଡ ଉତ୍ସ:')} <b>${esc(state.session.source)}</b></p></div>
        <button class="owner-btn secondary" data-act="logout">${t('Sign out', 'ସାଇନ ଆଉଟ')}</button>
      </div>
      ${statsCard()}
      ${remindersCard()}
      ${customerForm()}
      ${customersCard()}
      ${checkinsCard()}
      ${leadsCard()}
      ${whatsappCard()}
      ${messageHtml()}
    </div>`;
  }

  function render() {
    const host = root();
    if (!host) return;
    host.innerHTML = state.session.authenticated ? consoleHtml() : signInCard();
  }

  /* ------------------------------------------------------------------ loading */

  async function loadAll() {
    const [customers, checkins, leads, followups, reminders, summary] = await Promise.all([
      api('/api/owner/records/customers'),
      api('/api/owner/records/checkins'),
      api('/api/owner/records/leads'),
      api('/api/owner/records/followups'),
      api('/api/owner/reminders'),
      api('/api/owner/summary')
    ]);
    state.customers = customers.items || [];
    state.checkins = checkins.items || [];
    state.leads = leads.items || [];
    state.followups = followups.items || [];
    state.reminders = reminders.items || [];
    state.summary = summary;
  }

  async function refresh() {
    if (!state.session.authenticated) {
      render();
      return;
    }
    try {
      await loadAll();
    } catch (err) {
      if (err.status === 401) {
        state.session.authenticated = false;
        setMessage(t('Session expired. Please sign in again.', 'ସେସନ ସମାପ୍ତ। ପୁଣି ସାଇନ ଇନ କରନ୍ତୁ।'), 'error');
      } else {
        setMessage(err.message, 'error');
      }
    }
    render();
  }

  async function saveCollection(collection, items) {
    const result = await api(`/api/owner/records/${collection}`, { method: 'PUT', body: { items } });
    state[collection] = result.items || items;
  }

  /* ------------------------------------------------------------------ actions */

  async function handle(action, form, target) {
    if (action === 'login' || action === 'setup') {
      const password = form.password.value;
      if (action === 'setup' && password !== form.confirm.value) {
        setMessage(t('Passwords do not match.', 'ପାସୱାର୍ଡ ମେଳ ଖାଉନାହିଁ।'), 'error');
        render();
        return;
      }
      const path = action === 'setup' ? '/api/owner/setup' : '/api/owner/login';
      const result = await api(path, { method: 'POST', body: { password } });
      state.session = result.session || { authenticated: true, passwordConfigured: true, source: 'stored' };
      setMessage(t('Signed in.', 'ସାଇନ ଇନ ହେଲା।'), 'ok');
      await refresh();
      return;
    }

    if (action === 'logout') {
      await api('/api/owner/logout', { method: 'POST', body: {} });
      state.session = { authenticated: false, passwordConfigured: true, source: state.session.source };
      state.customers = [];
      state.checkins = [];
      state.leads = [];
      state.followups = [];
      state.reminders = [];
      state.summary = null;
      state.draft = null;
      setMessage(t('Signed out.', 'ସାଇନ ଆଉଟ ହେଲା।'), 'ok');
      render();
      return;
    }

    if (action === 'customer-save') {
      const name = form.name.value.trim();
      if (!name) {
        setMessage(t('Enter a customer name.', 'ଗ୍ରାହକ ନାମ ଦିଅନ୍ତୁ।'), 'error');
        render();
        return;
      }
      if (!form.consent.checked) {
        setMessage(t('Confirm the customer agreed before storing coaching details.', 'କୋଚିଂ ବିବରଣୀ ରଖିବା ପୂର୍ବରୁ ଗ୍ରାହକ ସମ୍ମତି ନିଶ୍ଚିତ କରନ୍ତୁ।'), 'error');
        render();
        return;
      }
      const record = {
        name,
        contact: form.contact.value.trim(),
        language: form.language.value,
        goal: form.goal.value.trim(),
        consent: true,
        updatedAt: new Date().toISOString()
      };
      if (state.editingCustomer) {
        await api(`/api/owner/records/customers/${encodeURIComponent(state.editingCustomer)}`, {
          method: 'PATCH',
          body: { patch: record }
        });
        state.editingCustomer = null;
        setMessage(t('Customer updated.', 'ଗ୍ରାହକ ଅପଡେଟ ହେଲା।'), 'ok');
      } else {
        await api('/api/owner/records/customers', {
          method: 'POST',
          body: { record: Object.assign({ createdAt: new Date().toISOString() }, record) }
        });
        setMessage(t('Customer saved to the server.', 'ଗ୍ରାହକ ସର୍ଭରରେ ସେଭ ହେଲା।'), 'ok');
      }
      await refresh();
      return;
    }

    if (action === 'customer-edit') {
      state.editingCustomer = target.getAttribute('data-id');
      render();
      return;
    }

    if (action === 'customer-cancel') {
      state.editingCustomer = null;
      render();
      return;
    }

    if (action === 'customer-delete') {
      const id = target.getAttribute('data-id');
      if (!window.confirm(t('Delete this customer and keep their check-ins?', 'ଏହି ଗ୍ରାହକ ଡିଲିଟ କରିବେ?'))) return;
      await api(`/api/owner/records/customers/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setMessage(t('Customer deleted.', 'ଗ୍ରାହକ ଡିଲିଟ ହେଲା।'), 'ok');
      await refresh();
      return;
    }

    if (action === 'checkin-add') {
      const customerId = form.customerId.value;
      if (!customerId) {
        setMessage(t('Choose a customer first.', 'ପ୍ରଥମେ ଗ୍ରାହକ ବାଛନ୍ତୁ।'), 'error');
        render();
        return;
      }
      await api('/api/owner/records/checkins', {
        method: 'POST',
        body: {
          record: {
            customerId,
            date: form.date.value || new Date().toISOString().slice(0, 10),
            stage: form.stage.value,
            note: form.note.value.trim(),
            createdAt: new Date().toISOString()
          }
        }
      });
      setMessage(t('Check-in saved to the server.', 'ଯାଞ୍ଚ ସର୍ଭରରେ ସେଭ ହେଲା।'), 'ok');
      await refresh();
      return;
    }

    if (action === 'checkin-delete') {
      const id = target.getAttribute('data-id');
      await api(`/api/owner/records/checkins/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setMessage(t('Check-in deleted.', 'ଯାଞ୍ଚ ଡିଲିଟ ହେଲା।'), 'ok');
      await refresh();
      return;
    }

    if (action === 'lead-delete') {
      const id = target.getAttribute('data-id');
      await api(`/api/owner/records/leads/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setMessage(t('Lead deleted.', 'ଲିଡ ଡିଲିଟ ହେଲା।'), 'ok');
      await refresh();
      return;
    }

    if (action === 'reminder-done') {
      const id = target.getAttribute('data-id');
      await api(`/api/owner/records/followups/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: { patch: { status: 'Completed', completedAt: new Date().toISOString() } }
      });
      setMessage(t('Follow-up marked complete.', 'ଫଲୋଅପ ସମ୍ପୂର୍ଣ୍ଣ।'), 'ok');
      await refresh();
      return;
    }

    if (action === 'draft-wa') {
      const kind = target.getAttribute('data-kind');
      const id = target.getAttribute('data-id');
      target.disabled = true;
      try {
        const result = await api('/api/owner/whatsapp/draft', { method: 'POST', body: { kind, id, language: 'en' } });
        state.draft = result;
        setMessage(
          result.source === 'ai'
            ? t('AI draft ready. Review, then open WhatsApp.', 'AI ଡ୍ରାଫ୍ଟ ପ୍ରସ୍ତୁତ। ସମୀକ୍ଷା କରି WhatsApp ଖୋଲନ୍ତୁ।')
            : t('AI unavailable — a reviewed template draft is ready.', 'AI ଉପଲବ୍ଧ ନାହିଁ — ସମୀକ୍ଷିତ ଟେମ୍ପଲେଟ ଡ୍ରାଫ୍ଟ ପ୍ରସ୍ତୁତ।'),
          'ok'
        );
      } catch (err) {
        setMessage(err.message, 'error');
      }
      target.disabled = false;
      render();
      return;
    }

    if (action === 'wa-free') {
      const customerId = form.customerId.value;
      if (!customerId) {
        setMessage(t('Choose a customer first.', 'ପ୍ରଥମେ ଗ୍ରାହକ ବାଛନ୍ତୁ।'), 'error');
        render();
        return;
      }
      try {
        const result = await api('/api/owner/whatsapp/draft', {
          method: 'POST',
          body: { kind: 'customer', id: customerId, language: form.language.value, purpose: form.purpose.value }
        });
        state.draft = Object.assign({ customerId, language: form.language.value }, result);
        setMessage(
          result.source === 'ai'
            ? t('AI draft ready.', 'AI ଡ୍ରାଫ୍ଟ ପ୍ରସ୍ତୁତ।')
            : t('AI unavailable — a reviewed template draft is ready.', 'AI ଉପଲବ୍ଧ ନାହିଁ — ସମୀକ୍ଷିତ ଟେମ୍ପଲେଟ ଡ୍ରାଫ୍ଟ ପ୍ରସ୍ତୁତ।'),
          'ok'
        );
      } catch (err) {
        setMessage(err.message, 'error');
      }
      render();
      return;
    }

    if (action === 'copy-draft') {
      const area = document.querySelector('#owner [data-role="draftText"]');
      if (!area) return;
      try {
        await navigator.clipboard.writeText(area.value);
        setMessage(t('Message copied.', 'ସନ୍ଦେଶ କପି ହେଲା।'), 'ok');
      } catch (err) {
        area.select();
        setMessage(t('Press Ctrl+C to copy the selected message.', 'କପି ପାଇଁ Ctrl+C ଦବାନ୍ତୁ।'), 'ok');
      }
      return;
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    const host = root();
    if (!host) return;

    host.addEventListener('submit', async (event) => {
      const form = event.target.closest('form[data-act]');
      if (!form) return;
      event.preventDefault();
      try {
        await handle(form.getAttribute('data-act'), form, form);
      } catch (err) {
        setMessage(err.message, 'error');
        render();
      }
    });

    host.addEventListener('click', async (event) => {
      const target = event.target.closest('[data-act]');
      if (!target || target.tagName === 'FORM') return;
      const action = target.getAttribute('data-act');
      if (target.tagName === 'A') return;
      event.preventDefault();
      try {
        await handle(action, null, target);
      } catch (err) {
        setMessage(err.message, 'error');
        render();
      }
    });

    host.addEventListener('change', async (event) => {
      const select = event.target.closest('select[data-act="lead-status"]');
      if (!select) return;
      const id = select.getAttribute('data-id');
      try {
        await api(`/api/owner/records/leads/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: { patch: { status: select.value } }
        });
        setMessage(t('Lead status updated.', 'ଲିଡ ସ୍ଥିତି ଅପଡେଟ ହେଲା।'), 'ok');
        await refresh();
      } catch (err) {
        setMessage(err.message, 'error');
        render();
      }
    });

    (async function boot() {
      try {
        const session = await api('/api/owner/session');
        state.session = session;
      } catch (err) {
        state.session = { authenticated: false, passwordConfigured: false, source: 'none' };
        setMessage(t('Could not reach the server. Open the deployed app URL.', 'ସର୍ଭର ସହ ସଂଯୋଗ ହେଲା ନାହିଁ। ଡିପ୍ଲୟ URL ଖୋଲନ୍ତୁ।'), 'error');
      }
      await refresh();
    })();

    document.addEventListener('shh:hydrated', () => {
      if (state.session.authenticated) render();
    });
    window.SHHOwner = { refresh, get session() { return state.session; } };
  });
})();
