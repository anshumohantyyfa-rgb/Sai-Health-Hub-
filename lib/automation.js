'use strict';

// Phase 3 business automation. Pure functions only: every input is passed in and
// nothing here touches storage, the network or the clock directly, so the whole
// board can be unit-tested with fixed dates.
//
// Inputs come from the existing app collections:
//   contacts      - Business Desk contacts (businessContacts)
//   followups     - follow-up planner entries
//   consultations - consultation bookings
//   consentEvents - opt-in / opt-out audit trail
//   reminders     - scheduled reminders (new, optional)
//   campaigns     - campaign schedule (new, optional)
//   customers     - Customer Transformation records
//   checkins      - health check-in records
//
// Nothing in this module sends messages. Reminders and follow-ups are surfaced
// for the owner to act on manually.

const DAY_MS = 86400000;
const BIRTHDAY_WINDOW_DAYS = 30;
const UPCOMING_WINDOW_DAYS = 7;
const ENGAGEMENT_ACTIVE_DAYS = 14;
const ENGAGEMENT_COOLING_DAYS = 30;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

// Parses a date-only string (YYYY-MM-DD) or an ISO timestamp as a UTC midnight
// date. Date-only values are treated as UTC so day counts never shift with the
// server timezone.
function parseDay(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : startOfDay(value);
  }
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (match) {
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : startOfDay(parsed);
}

function startOfDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function toISODay(date) {
  return date ? date.toISOString().slice(0, 10) : '';
}

// Whole days from `from` to `to` (negative when `to` is in the past).
function diffDays(from, to) {
  const a = parseDay(from);
  const b = parseDay(to);
  if (!a || !b) {
    return null;
  }
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

// Next occurrence of a birthday within the window. Accepts YYYY-MM-DD (age is
// reported) or MM-DD (age unknown). 29 February rolls to 28 February in
// non-leap years so the reminder is never lost.
function nextBirthday(birthday, today) {
  const todayDay = parseDay(today);
  if (!todayDay) {
    return null;
  }
  const raw = String(birthday || '').trim();
  let month;
  let day;
  let birthYear = null;
  const full = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  const short = /^(\d{1,2})-(\d{1,2})$/.exec(raw);
  if (full) {
    birthYear = Number(full[1]);
    month = Number(full[2]);
    day = Number(full[3]);
  } else if (short) {
    month = Number(short[1]);
    day = Number(short[2]);
  } else {
    return null;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  const year = todayDay.getUTCFullYear();
  const candidates = [];
  for (let offset = 0; offset <= 1; offset += 1) {
    const targetYear = year + offset;
    let occurrence = new Date(Date.UTC(targetYear, month - 1, day));
    // 29 Feb in a non-leap year becomes 28 Feb.
    if (occurrence.getUTCMonth() !== month - 1) {
      occurrence = new Date(Date.UTC(targetYear, month - 1, 0));
    }
    candidates.push(occurrence);
  }
  let next = candidates.find((date) => date.getTime() >= todayDay.getTime()) || candidates[candidates.length - 1];
  const daysAway = Math.round((next.getTime() - todayDay.getTime()) / DAY_MS);
  return {
    date: toISODay(next),
    monthDay: `${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`,
    daysAway,
    turning: birthYear ? next.getUTCFullYear() - birthYear : null
  };
}

function bucketFor(daysAway) {
  if (daysAway === null) {
    return 'unscheduled';
  }
  if (daysAway < 0) {
    return 'overdue';
  }
  if (daysAway === 0) {
    return 'today';
  }
  return 'upcoming';
}

function buildFollowups(input, today) {
  const contacts = asArray(input.contacts);
  const contactById = new Map(contacts.map((c) => [String(c.id), c]));
  const rows = [];

  asArray(input.followups).forEach((item) => {
    const status = String(item.status || 'Pending');
    if (status === 'Completed' || status === 'Cancelled') {
      return;
    }
    const contact = contactById.get(String(item.contactId)) || null;
    const daysAway = diffDays(today, item.date || item.dueAt);
    const consent = contact ? String(contact.consent || '') === 'Yes' && !contact.optedOut : false;
    rows.push({
      id: String(item.id),
      name: (contact && contact.name) || item.contactName || 'Contact',
      contact: (contact && contact.phone) || item.contact || '',
      purpose: item.purpose || item.reason || 'Follow-up',
      note: item.note || '',
      dueDate: toISODay(parseDay(item.date || item.dueAt)),
      daysAway,
      bucket: bucketFor(daysAway),
      consent,
      // Promotional follow-up stays blocked unless current explicit opt-in exists.
      blocked: !consent && String(item.purpose || '') !== 'Requested information'
    });
  });

  rows.sort((a, b) => {
    const av = a.daysAway === null ? Number.MAX_SAFE_INTEGER : a.daysAway;
    const bv = b.daysAway === null ? Number.MAX_SAFE_INTEGER : b.daysAway;
    return av - bv;
  });

  const counts = { overdue: 0, today: 0, upcoming: 0, unscheduled: 0, pending: rows.length };
  rows.forEach((row) => {
    counts[row.bucket] += 1;
  });
  return {
    items: rows,
    overdue: rows.filter((r) => r.bucket === 'overdue'),
    dueToday: rows.filter((r) => r.bucket === 'today'),
    upcoming: rows.filter((r) => r.bucket === 'upcoming'),
    counts
  };
}

function buildBirthdays(input, today) {
  const rows = [];
  asArray(input.contacts).forEach((contact) => {
    const info = nextBirthday(contact.birthday, today);
    if (!info) {
      return;
    }
    rows.push({
      id: String(contact.id),
      name: contact.name || 'Contact',
      contact: contact.phone || '',
      consent: String(contact.consent || '') === 'Yes' && !contact.optedOut,
      date: info.date,
      monthDay: info.monthDay,
      daysAway: info.daysAway,
      turning: info.turning,
      inWindow: info.daysAway <= BIRTHDAY_WINDOW_DAYS
    });
  });
  rows.sort((a, b) => a.daysAway - b.daysAway);
  return {
    items: rows,
    withinWindow: rows.filter((r) => r.inWindow),
    windowDays: BIRTHDAY_WINDOW_DAYS
  };
}

function buildReminders(input, today) {
  const contacts = asArray(input.contacts);
  const contactById = new Map(contacts.map((c) => [String(c.id), c]));
  const rows = [];

  asArray(input.reminders).forEach((item) => {
    if (String(item.status || 'Pending') === 'Done') {
      return;
    }
    const contact = contactById.get(String(item.contactId)) || null;
    const daysAway = diffDays(today, item.dueDate || item.dueAt);
    rows.push({
      id: String(item.id),
      title: item.title || 'Reminder',
      kind: item.kind || 'General',
      name: (contact && contact.name) || item.name || '',
      contact: (contact && contact.phone) || item.contact || '',
      dueDate: toISODay(parseDay(item.dueDate || item.dueAt)),
      note: item.note || '',
      daysAway,
      bucket: bucketFor(daysAway),
      dueSoon: daysAway !== null && daysAway <= UPCOMING_WINDOW_DAYS
    });
  });

  rows.sort((a, b) => {
    const av = a.daysAway === null ? Number.MAX_SAFE_INTEGER : a.daysAway;
    const bv = b.daysAway === null ? Number.MAX_SAFE_INTEGER : b.daysAway;
    return av - bv;
  });

  const counts = { overdue: 0, today: 0, upcoming: 0, unscheduled: 0, pending: rows.length };
  rows.forEach((row) => {
    counts[row.bucket] += 1;
  });
  return {
    items: rows,
    overdue: rows.filter((r) => r.bucket === 'overdue'),
    dueToday: rows.filter((r) => r.bucket === 'today'),
    dueSoon: rows.filter((r) => r.bucket === 'upcoming' && r.dueSoon),
    counts
  };
}

// Engagement is derived from recorded interactions only. No opens, clicks or
// deliveries are implied: this app does not send or track messages.
function buildEngagement(input, today) {
  const contacts = asArray(input.contacts);
  const followups = asArray(input.followups);
  const consultations = asArray(input.consultations);
  const consentEvents = asArray(input.consentEvents);

  const rows = contacts.map((contact) => {
    const id = String(contact.id);
    const ownFollowups = followups.filter((f) => String(f.contactId) === id);
    const completed = ownFollowups.filter((f) => String(f.status || '') === 'Completed');
    const ownConsults = consultations.filter((c) => String(c.contactId) === id);
    const ownConsent = consentEvents.filter((e) => String(e.contactId) === id);

    const stamps = []
      .concat(completed.map((f) => f.completedAt || f.date))
      .concat(ownConsults.map((c) => c.date))
      .concat(ownConsent.map((e) => e.timestamp))
      .concat([contact.updatedAt, contact.createdAt])
      .map((value) => parseDay(value))
      .filter(Boolean)
      .sort((a, b) => a - b);

    const lastTouch = stamps.length ? stamps[stamps.length - 1] : null;
    const lastTouchDays = lastTouch ? Math.round((parseDay(today).getTime() - lastTouch.getTime()) / DAY_MS) : null;

    let level = 'dormant';
    if (lastTouchDays !== null && lastTouchDays <= ENGAGEMENT_ACTIVE_DAYS) {
      level = 'active';
    } else if (lastTouchDays !== null && lastTouchDays <= ENGAGEMENT_COOLING_DAYS) {
      level = 'cooling';
    }
    if (contact.optedOut) {
      level = 'opted_out';
    }

    // Simple, explainable score: recency dominates, activity adds weight.
    let score = 0;
    if (lastTouchDays !== null) {
      score += Math.max(0, 40 - Math.min(40, lastTouchDays));
    }
    score += Math.min(20, completed.length * 5);
    score += Math.min(20, ownConsults.length * 10);
    score += Math.min(20, ownConsent.length * 5);
    if (contact.optedOut) {
      score = 0;
    }

    return {
      id,
      name: contact.name || 'Contact',
      contact: contact.phone || '',
      type: contact.type || 'Enquiry',
      consent: String(contact.consent || '') === 'Yes' && !contact.optedOut,
      optedOut: Boolean(contact.optedOut),
      level,
      score: Math.round(Math.min(100, score)),
      lastTouch: lastTouch ? toISODay(lastTouch) : '',
      lastTouchDays,
      signals: {
        followupsScheduled: ownFollowups.length,
        followupsCompleted: completed.length,
        consultations: ownConsults.length,
        consentEvents: ownConsent.length
      }
    };
  });

  rows.sort((a, b) => b.score - a.score);

  const counts = { active: 0, cooling: 0, dormant: 0, opted_out: 0 };
  rows.forEach((row) => {
    counts[row.level] += 1;
  });

  const customers = asArray(input.customers);
  const checkins = asArray(input.checkins);
  const customerRows = customers.map((customer) => {
    const id = String(customer.id);
    const own = checkins
      .filter((k) => String(k.customerId) === id)
      .map((k) => parseDay(k.date || k.createdAt))
      .filter(Boolean)
      .sort((a, b) => a - b);
    const last = own.length ? own[own.length - 1] : null;
    const lastDays = last ? Math.round((parseDay(today).getTime() - last.getTime()) / DAY_MS) : null;
    return {
      id,
      name: customer.name || 'Customer',
      checkins: own.length,
      lastCheckin: last ? toISODay(last) : '',
      lastCheckinDays: lastDays,
      stale: lastDays === null || lastDays > ENGAGEMENT_ACTIVE_DAYS
    };
  });

  return {
    contacts: rows,
    counts,
    customers: {
      total: customerRows.length,
      stale: customerRows.filter((c) => c.stale).length,
      items: customerRows.sort((a, b) => b.checkins - a.checkins)
    }
  };
}

function buildCampaigns(input, today) {
  const rows = asArray(input.campaigns).map((campaign) => {
    const startDays = diffDays(today, campaign.startDate);
    const endDays = campaign.endDate ? diffDays(today, campaign.endDate) : null;
    let status = 'planned';
    if (endDays !== null && endDays < 0) {
      status = 'completed';
    } else if (startDays !== null && startDays <= 0) {
      status = 'active';
    }
    if (String(campaign.status || '') === 'Cancelled') {
      status = 'cancelled';
    }
    return {
      id: String(campaign.id),
      name: campaign.name || 'Campaign',
      channel: campaign.channel || 'WhatsApp status',
      audience: campaign.audience || '',
      startDate: toISODay(parseDay(campaign.startDate)),
      endDate: toISODay(parseDay(campaign.endDate)),
      notes: campaign.notes || '',
      status,
      daysAway: startDays,
      startsToday: startDays === 0,
      manualPublish: true
    };
  });

  rows.sort((a, b) => {
    const av = a.daysAway === null ? Number.MAX_SAFE_INTEGER : a.daysAway;
    const bv = b.daysAway === null ? Number.MAX_SAFE_INTEGER : b.daysAway;
    return av - bv;
  });

  const counts = { planned: 0, active: 0, completed: 0, cancelled: 0 };
  rows.forEach((row) => {
    counts[row.status] += 1;
  });
  return { items: rows, counts, startingSoon: rows.filter((r) => r.status === 'planned' && r.daysAway !== null && r.daysAway <= UPCOMING_WINDOW_DAYS) };
}

function countWithin(values, today, days) {
  const todayDay = parseDay(today);
  if (!todayDay) {
    return 0;
  }
  const from = todayDay.getTime() - (days - 1) * DAY_MS;
  return values.filter((value) => {
    const parsed = parseDay(value);
    if (!parsed) {
      return false;
    }
    const time = parsed.getTime();
    return time >= from && time <= todayDay.getTime();
  }).length;
}

function periodReport(input, today, days, label) {
  const contacts = asArray(input.contacts);
  const followups = asArray(input.followups);
  const consultations = asArray(input.consultations);
  const checkins = asArray(input.checkins);
  const campaigns = asArray(input.campaigns);

  return {
    label,
    days,
    since: toISODay(new Date(parseDay(today).getTime() - (days - 1) * DAY_MS)),
    until: toISODay(parseDay(today)),
    newContacts: countWithin(contacts.map((c) => c.createdAt || c.updatedAt), today, days),
    followupsCompleted: countWithin(
      followups.filter((f) => String(f.status || '') === 'Completed').map((f) => f.completedAt || f.date),
      today,
      days
    ),
    followupsScheduled: countWithin(followups.map((f) => f.createdAt || f.date), today, days),
    consultations: countWithin(consultations.map((c) => c.date), today, days),
    checkins: countWithin(checkins.map((c) => c.date || c.createdAt), today, days),
    campaignsStarted: countWithin(campaigns.map((c) => c.startDate), today, days),
    remindersDue: countWithin(asArray(input.reminders).map((r) => r.dueDate || r.dueAt), today, days)
  };
}

function computeAutomation(input, now) {
  const today = toISODay(parseDay(now || new Date()));
  const safe = input && typeof input === 'object' ? input : {};
  const followups = buildFollowups(safe, today);
  const birthdays = buildBirthdays(safe, today);
  const reminders = buildReminders(safe, today);
  const engagement = buildEngagement(safe, today);
  const campaigns = buildCampaigns(safe, today);

  return {
    generatedAt: new Date().toISOString(),
    today,
    followups,
    birthdays,
    reminders,
    engagement,
    campaigns,
    reports: {
      daily: periodReport(safe, today, 1, 'Today'),
      weekly: periodReport(safe, today, 7, 'Last 7 days'),
      monthly: periodReport(safe, today, 30, 'Last 30 days')
    },
    totals: {
      contacts: asArray(safe.contacts).length,
      pendingFollowups: followups.counts.pending,
      overdueFollowups: followups.counts.overdue,
      birthdaysInWindow: birthdays.withinWindow.length,
      remindersDue: reminders.counts.overdue + reminders.counts.today,
      activeCampaigns: campaigns.counts.active,
      activeContacts: engagement.counts.active
    },
    delivery: {
      automatic: false,
      note: 'Reminders and follow-ups are surfaced for the owner to act on manually. This app does not send WhatsApp messages or notifications.'
    }
  };
}

module.exports = {
  computeAutomation,
  diffDays,
  nextBirthday,
  parseDay,
  toISODay,
  BIRTHDAY_WINDOW_DAYS,
  UPCOMING_WINDOW_DAYS
};
