// Proves the calendar plugin end to end through info/registerTools (the real loader contract),
// using a stateful fake Postgres pool (calendar_events only — this plugin touches no other
// table) and a stubbed global fetch for the ICS-sync path. Covers: create_calendar_event via the
// tool, get_calendar_schedule's overlap filter and sourceMeta enrichment, icsSync's RRULE
// expansion and upsert-dedup (a second sync of the same feed never duplicates rows), and
// applyPrivacyMask's masking/no-masking behavior directly.

import { createPostgresClient } from '@bigbrain/orchestrator/postgres';
import { info, registerTools, startBackgroundJobs } from '../dist/index.js';
import { syncFeedOnce } from '../dist/icsSync.js';
import { applyPrivacyMask } from '../dist/parseWorkEvent.js';
import { sourceMeta } from '../dist/sourceMeta.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

const USER_ID = '11111111-1111-1111-1111-111111111111';

function createFakePool() {
  const events = [];
  let counter = 0;

  return {
    events,
    async connect() {
      let staged;
      return {
        async query(sql, params = []) {
          if (sql === 'BEGIN') {
            staged = [...events];
            return { rows: [] };
          }
          if (sql === 'COMMIT') {
            events.length = 0;
            events.push(...staged);
            return { rows: [] };
          }
          if (sql === 'ROLLBACK') {
            staged = undefined;
            return { rows: [] };
          }
          if (sql.includes('set_config')) return { rows: [] };

          if (sql.startsWith('insert into calendar_events') && sql.includes('on conflict')) {
            const [userId, source, externalId, title, description, location, startTime, endTime, allDay] = params;
            const existing = staged.find((e) => e.source === source && e.external_id === externalId);
            if (existing) {
              Object.assign(existing, { title, description, location, start_time: startTime, end_time: endTime, all_day: allDay });
            } else {
              staged.push({
                event_id: `event-${++counter}`,
                user_id: userId,
                source,
                external_id: externalId,
                title,
                description,
                location,
                start_time: startTime,
                end_time: endTime,
                all_day: allDay,
                assigned_members: [],
              });
            }
            return { rows: [] };
          }

          if (sql.startsWith('insert into calendar_events') && sql.includes('returning event_id')) {
            const [userId, title, description, startTime, endTime, assignedMembers] = params;
            const event_id = `event-${++counter}`;
            staged.push({
              event_id,
              user_id: userId,
              source: 'native',
              external_id: `native-${event_id}`,
              title,
              description,
              location: null,
              start_time: startTime,
              end_time: endTime,
              all_day: false,
              assigned_members: assignedMembers,
            });
            return { rows: [{ event_id }] };
          }

          if (sql.startsWith('select event_id, source, title')) {
            const [userId, sources, endDate, startDate] = params;
            const rangeEnd = new Date(`${endDate}T00:00:00.000Z`);
            rangeEnd.setUTCDate(rangeEnd.getUTCDate() + 1);
            const rangeStart = new Date(`${startDate}T00:00:00.000Z`);
            const matches = staged
              .filter(
                (e) =>
                  e.user_id === userId &&
                  sources.includes(e.source) &&
                  new Date(e.start_time) < rangeEnd &&
                  new Date(e.end_time) > rangeStart,
              )
              .sort((a, b) => a.start_time.localeCompare(b.start_time));
            return { rows: matches };
          }

          throw new Error(`fake pool: unhandled query: ${sql}`);
        },
        release() {},
      };
    },
  };
}

function icsDate(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function buildFixtureIcs() {
  const singleStart = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  const singleEnd = new Date(singleStart.getTime() + 60 * 60 * 1000);
  const weeklyStart = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  const weeklyEnd = new Date(weeklyStart.getTime() + 30 * 60 * 1000);

  return {
    singleStart,
    weeklyStart,
    text: `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//bigBrain//verify-calendar//EN
BEGIN:VEVENT
UID:single-1@test
DTSTAMP:${icsDate(new Date())}
DTSTART:${icsDate(singleStart)}
DTEND:${icsDate(singleEnd)}
SUMMARY:Dentist
LOCATION:Main St Clinic
DESCRIPTION:Checkup
END:VEVENT
BEGIN:VEVENT
UID:weekly-1@test
DTSTAMP:${icsDate(new Date())}
DTSTART:${icsDate(weeklyStart)}
DTEND:${icsDate(weeklyEnd)}
SUMMARY:Team Sync
RRULE:FREQ=WEEKLY;COUNT=3
END:VEVENT
END:VCALENDAR
`,
  };
}

async function main() {
  // --- registerTools contract ---
  assert(info.id === 'calendar', 'plugin info.id is "calendar"');
  const tools = await registerTools({});
  const names = tools.map((t) => t.definition.name).sort();
  assert(JSON.stringify(names) === JSON.stringify(['create_calendar_event', 'get_calendar_schedule']), 'registerTools returns exactly the two calendar tools');

  const createTool = tools.find((t) => t.definition.name === 'create_calendar_event');
  const getTool = tools.find((t) => t.definition.name === 'get_calendar_schedule');

  const pool = createFakePool();
  const db = createPostgresClient(pool);
  const withUser = (fn) => db.withUserScope(USER_ID, (session) => fn({ userId: USER_ID, db: session }));

  // --- create_calendar_event ---
  const created = await withUser((ctx) =>
    createTool.handler({ title: 'Pack for trip', start_time: '2026-08-01T10:00:00.000Z', end_time: '2026-08-01T11:00:00.000Z' }, ctx),
  );
  assert(created.source === 'native', 'create_calendar_event sets source=native');
  assert(created.isReadOnly === false, 'a native event reports isReadOnly=false via sourceMeta');
  assert(pool.events.length === 1 && pool.events[0].title === 'Pack for trip', 'native event actually persisted');

  // --- icsSync: fetch + parse + upsert, including RRULE expansion ---
  const fixture = buildFixtureIcs();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => fixture.text });

  try {
    await syncFeedOnce(db, USER_ID, { source: 'cozi', url: 'https://example.invalid/cozi.ics' }, false);
    const cozi = pool.events.filter((e) => e.source === 'cozi');
    assert(cozi.length === 1 + 3, `expands to 1 single-occurrence + 3 weekly occurrences (got ${cozi.length})`);
    assert(cozi.some((e) => e.title === 'Dentist' && e.location === 'Main St Clinic'), 'non-recurring event fields parsed correctly');
    assert(cozi.filter((e) => e.title === 'Team Sync').length === 3, 'recurring event expanded into 3 distinct rows');

    // Re-sync the same feed: upsert must not duplicate rows.
    await syncFeedOnce(db, USER_ID, { source: 'cozi', url: 'https://example.invalid/cozi.ics' }, false);
    assert(pool.events.filter((e) => e.source === 'cozi').length === 4, 're-syncing the same feed does not duplicate rows (upsert on source+external_id)');

    // --- Outlook masking ---
    await syncFeedOnce(db, USER_ID, { source: 'outlook', url: 'https://example.invalid/outlook.ics' }, true);
    const outlook = pool.events.filter((e) => e.source === 'outlook');
    assert(outlook.every((e) => e.title === 'Work Commitment' && e.location === null), 'MASK_WORK_CALENDAR replaces Outlook title/location/description');
  } finally {
    globalThis.fetch = originalFetch;
  }

  // --- get_calendar_schedule: overlap filter + sourceMeta enrichment ---
  const schedule = await withUser((ctx) =>
    getTool.handler({ start_date: '2026-01-01', end_date: '2026-12-31', sources: ['native'] }, ctx),
  );
  assert(schedule.length === 1 && schedule[0].title === 'Pack for trip', 'get_calendar_schedule filters by sources');
  assert(schedule[0].colorCode === '#10B981' && schedule[0].isReadOnly === false, 'schedule rows are enriched with sourceMeta');

  const allSources = await withUser((ctx) => getTool.handler({ start_date: '2026-01-01', end_date: '2026-12-31' }, ctx));
  assert(allSources.length === pool.events.length, 'omitting sources returns events from every source');

  // --- sourceMeta / applyPrivacyMask as pure functions ---
  assert(sourceMeta('cozi').colorCode === '#8B5CF6' && sourceMeta('cozi').isReadOnly === true, 'sourceMeta("cozi") is purple and read-only');
  const rawEvent = { externalId: 'x', title: 'Real title', description: 'Real desc', location: 'Real place', startTime: 'a', endTime: 'b', allDay: false };
  assert(applyPrivacyMask(rawEvent, false) === rawEvent, 'applyPrivacyMask is a no-op (same reference) when shouldMask=false');
  assert(applyPrivacyMask(rawEvent, true).title === 'Work Commitment', 'applyPrivacyMask replaces title when shouldMask=true');

  // --- startBackgroundJobs resolves feed URLs via the credential store, not raw env (bb_principles.md §12) ---
  {
    const resolveCalls = [];
    const fakeCredentials = {
      async resolve(name, envFallback) {
        resolveCalls.push({ name, envFallback });
        return undefined; // neither feed "configured" — proves no poll timer gets started off unresolved secrets
      },
    };
    const originalOwner = process.env.BIGBRAIN_CALENDAR_OWNER_USER_ID;
    process.env.BIGBRAIN_CALENDAR_OWNER_USER_ID = USER_ID;
    try {
      await startBackgroundJobs({ db, credentials: fakeCredentials });
    } finally {
      if (originalOwner === undefined) delete process.env.BIGBRAIN_CALENDAR_OWNER_USER_ID;
      else process.env.BIGBRAIN_CALENDAR_OWNER_USER_ID = originalOwner;
    }
    assert(
      resolveCalls.some((c) => c.name === 'cozi_ics_url') && resolveCalls.some((c) => c.name === 'outlook_ics_url'),
      'startBackgroundJobs resolves both ICS feed URLs through deps.credentials, not process.env directly',
    );
  }
}

main().catch((err) => {
  console.error('verify-calendar crashed:', err);
  process.exitCode = 1;
});
