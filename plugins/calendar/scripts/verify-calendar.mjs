// Proves the calendar plugin end to end through info/registerTools (the real loader contract),
// using a stateful fake Postgres pool (calendar_events + calendar_google_sync_map — the only two
// tables this plugin touches) and a stubbed global fetch for the ICS-sync path. Covers:
// create/update/delete_calendar_event via the tools, get_calendar_schedule's overlap filter and
// sourceMeta enrichment, icsSync's RRULE expansion and upsert-dedup (a second sync of the same
// feed never duplicates rows), applyPrivacyMask's masking/no-masking behavior directly, and
// bidirectional Google Calendar sync (googleSync.ts's inbound poll reconciliation, and the
// outbound push from the create/update/delete tools via a fake GoogleCalendarClient — no real
// network call, same reasoning icsSync's stubbed fetch already uses for Cozi/Outlook).

import { createPostgresClient } from '@bigbrain/orchestrator/postgres';
import { info, registerTools, startBackgroundJobs } from '../dist/index.js';
import { syncFeedOnce } from '../dist/icsSync.js';
import { syncGoogleOnce } from '../dist/googleSync.js';
import { applyPrivacyMask } from '../dist/parseWorkEvent.js';
import { sourceMeta } from '../dist/sourceMeta.js';
import { createCreateCalendarEventTool } from '../dist/createCalendarEventTool.js';
import { createUpdateCalendarEventTool } from '../dist/updateCalendarEventTool.js';
import { createDeleteCalendarEventTool } from '../dist/deleteCalendarEventTool.js';

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
  const syncMap = [];
  let counter = 0;

  return {
    events,
    syncMap,
    async connect() {
      let stagedEvents;
      let stagedSyncMap;
      return {
        async query(sql, params = []) {
          if (sql === 'BEGIN') {
            stagedEvents = [...events];
            stagedSyncMap = [...syncMap];
            return { rows: [] };
          }
          if (sql === 'COMMIT') {
            events.length = 0;
            events.push(...stagedEvents);
            syncMap.length = 0;
            syncMap.push(...stagedSyncMap);
            return { rows: [] };
          }
          if (sql === 'ROLLBACK') {
            stagedEvents = undefined;
            stagedSyncMap = undefined;
            return { rows: [] };
          }
          if (sql.includes('set_config')) return { rows: [] };

          // --- icsSync.ts: upsert on (source, external_id) ---
          if (sql.startsWith('insert into calendar_events') && sql.includes('on conflict')) {
            const [userId, source, externalId, title, description, location, startTime, endTime, allDay] = params;
            const existing = stagedEvents.find((e) => e.source === source && e.external_id === externalId);
            if (existing) {
              Object.assign(existing, { title, description, location, start_time: startTime, end_time: endTime, all_day: allDay });
            } else {
              stagedEvents.push({
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
                visibility: 'shared',
                linked_list_item_id: null,
                linked_note_id: null,
              });
            }
            return { rows: [] };
          }

          // --- createCalendarEventTool.ts: dedup lookup for a linked create ---
          if (sql.startsWith('select event_id, title, start_time, end_time, visibility from calendar_events where user_id = $1 and linked_')) {
            const [userId, linkedId] = params;
            const field = sql.includes('linked_list_item_id') ? 'linked_list_item_id' : 'linked_note_id';
            const existing = stagedEvents.find((e) => e.user_id === userId && e[field] === linkedId);
            return {
              rows: existing
                ? [{ event_id: existing.event_id, title: existing.title, start_time: existing.start_time, end_time: existing.end_time, visibility: existing.visibility }]
                : [],
            };
          }

          // --- createCalendarEventTool.ts: always source='native' ---
          if (sql.includes("values ($1, 'native', gen_random_uuid()")) {
            const [userId, title, description, startTime, endTime, assignedMembers, visibility, linkedListItemId, linkedNoteId] = params;
            const event_id = `event-${++counter}`;
            stagedEvents.push({
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
              visibility,
              linked_list_item_id: linkedListItemId,
              linked_note_id: linkedNoteId,
              updated_at: new Date().toISOString(),
            });
            return { rows: [{ event_id }] };
          }

          // --- googleSync.ts: insert a new google-originated event ---
          if (sql.includes("values ($1, 'google', $2")) {
            const [userId, externalId, title, description, location, startTime, endTime, allDay] = params;
            const event_id = `event-${++counter}`;
            stagedEvents.push({
              event_id,
              user_id: userId,
              source: 'google',
              external_id: externalId,
              title,
              description,
              location,
              start_time: startTime,
              end_time: endTime,
              all_day: allDay,
              assigned_members: [],
              visibility: 'shared',
              linked_list_item_id: null,
              linked_note_id: null,
              updated_at: new Date().toISOString(),
            });
            return { rows: [{ event_id }] };
          }

          // --- googleSync.ts: apply an inbound update from Google ---
          if (sql.includes('all_day = $7, updated_at = now()')) {
            const [eventId, title, description, location, startTime, endTime, allDay] = params;
            const existing = stagedEvents.find((e) => e.event_id === eventId);
            if (existing) {
              Object.assign(existing, {
                title,
                description,
                location,
                start_time: startTime,
                end_time: endTime,
                all_day: allDay,
                updated_at: new Date().toISOString(),
              });
            }
            return { rows: [] };
          }

          // --- updateCalendarEventTool.ts: look up the existing row before editing ---
          if (sql.includes('select source, title, description, location, start_time, end_time, all_day')) {
            const [eventId, userId] = params;
            const existing = stagedEvents.find((e) => e.event_id === eventId && e.user_id === userId);
            return { rows: existing ? [existing] : [] };
          }

          // --- updateCalendarEventTool.ts: apply the actual edit ---
          if (sql.includes('assigned_members = coalesce($7, assigned_members)')) {
            const [eventId, userId, title, description, startTime, endTime, assignedMembers, visibility] = params;
            const existing = stagedEvents.find((e) => e.event_id === eventId && e.user_id === userId);
            if (existing) {
              Object.assign(existing, {
                title,
                description,
                start_time: startTime,
                end_time: endTime,
                assigned_members: assignedMembers ?? existing.assigned_members,
                visibility,
                updated_at: new Date().toISOString(),
              });
            }
            return { rows: [] };
          }

          // --- updateCalendarEventTool.ts: shared -> private demotion drops the sync-map row ---
          if (sql === 'delete from calendar_google_sync_map where event_id = $1') {
            const [eventId] = params;
            for (let i = stagedSyncMap.length - 1; i >= 0; i--) {
              if (stagedSyncMap[i].event_id === eventId) stagedSyncMap.splice(i, 1);
            }
            return { rows: [] };
          }

          // --- deleteCalendarEventTool.ts ---
          if (sql.includes('and user_id = $2 returning event_id')) {
            const [eventId, userId] = params;
            const index = stagedEvents.findIndex((e) => e.event_id === eventId && e.user_id === userId);
            if (index === -1) return { rows: [] };
            const [removed] = stagedEvents.splice(index, 1);
            for (let i = stagedSyncMap.length - 1; i >= 0; i--) {
              if (stagedSyncMap[i].event_id === removed.event_id) stagedSyncMap.splice(i, 1); // cascade
            }
            return { rows: [{ event_id: removed.event_id }] };
          }

          // --- googleSync.ts: cancel-delete (no user_id param — the poll is already scoped by withUserScope) ---
          if (sql === 'delete from calendar_events where event_id = $1') {
            const [eventId] = params;
            const index = stagedEvents.findIndex((e) => e.event_id === eventId);
            if (index !== -1) stagedEvents.splice(index, 1);
            for (let i = stagedSyncMap.length - 1; i >= 0; i--) {
              if (stagedSyncMap[i].event_id === eventId) stagedSyncMap.splice(i, 1); // cascade
            }
            return { rows: [] };
          }

          // --- googleSync.ts: lookup by google_event_id, joined to calendar_events ---
          if (sql.includes('from calendar_google_sync_map gsm')) {
            const [googleEventId] = params;
            const mapped = stagedSyncMap.find((m) => m.google_event_id === googleEventId);
            if (!mapped) return { rows: [] };
            const event = stagedEvents.find((e) => e.event_id === mapped.event_id);
            return { rows: event ? [{ event_id: event.event_id, updated_at: event.updated_at }] : [] };
          }

          // --- googleOutboundSync.ts: lookupGoogleEventId ---
          if (sql === 'select google_event_id from calendar_google_sync_map where event_id = $1') {
            const [eventId] = params;
            const mapped = stagedSyncMap.find((m) => m.event_id === eventId);
            return { rows: mapped ? [{ google_event_id: mapped.google_event_id }] : [] };
          }

          // --- mint a calendar_google_sync_map row (on conflict (google_event_id) do nothing) ---
          if (sql.includes('insert into calendar_google_sync_map (event_id, google_event_id')) {
            const [eventId, googleEventId, googleUpdatedAt] = params;
            if (stagedSyncMap.some((m) => m.google_event_id === googleEventId)) return { rows: [] }; // conflict, do nothing
            const sync_id = `sync-${++counter}`;
            stagedSyncMap.push({ sync_id, event_id: eventId, google_event_id: googleEventId, google_updated_at: googleUpdatedAt });
            return { rows: [{ sync_id }] };
          }

          // --- bookkeeping update to an existing sync-map row (both googleSync.ts and googleOutboundSync.ts) ---
          if (sql.includes('update calendar_google_sync_map set google_updated_at')) {
            const [eventId, googleUpdatedAt] = params;
            const mapped = stagedSyncMap.find((m) => m.event_id === eventId);
            if (mapped) mapped.google_updated_at = googleUpdatedAt;
            return { rows: [] };
          }

          if (sql.startsWith('select event_id, source, title')) {
            const [userId, sources, endDate, startDate] = params;
            const rangeEnd = new Date(`${endDate}T00:00:00.000Z`);
            rangeEnd.setUTCDate(rangeEnd.getUTCDate() + 1);
            const rangeStart = new Date(`${startDate}T00:00:00.000Z`);
            const matches = stagedEvents
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

// get_calendar_schedule reads household_timezone live on every call (getCalendarScheduleTool.ts,
// same value util/dateContext.ts uses for the LLM) — undefined here just exercises the DEFAULT_TIMEZONE
// ('UTC') fallback, fine for tests that always pass explicit start_date/end_date anyway.
function createFakeSettingsStore(overrides = {}) {
  const store = { ...overrides };
  return {
    async get(key) {
      return store[key];
    },
    async set(key, value) {
      store[key] = value;
    },
  };
}

// Neither ICS nor Google Calendar configured — the common case for tests not specifically
// exercising either sync path (registerTools' resolveGoogleCalendarClient still calls this, so
// every registerTools() call site needs a working fake, not just the ones testing Google directly).
function createFakeCredentialsStore(overrides = {}) {
  return {
    async resolve(name, envFallback) {
      return overrides[name];
    },
  };
}

// A fake GoogleCalendarClient covering only what create/update/delete_calendar_event's outbound
// push calls (insertEvent/updateEvent/deleteEvent) — no real network, same reasoning icsSync's
// stubbed fetch already uses for Cozi/Outlook. Records every call for assertions.
function createFakeGoogleOutboundClient() {
  let counter = 0;
  return {
    calendarId: 'primary',
    inserted: [],
    updated: [],
    deleted: [],
    async insertEvent(input) {
      const googleEventId = `g-out-${++counter}`;
      const updatedAt = new Date().toISOString();
      this.inserted.push({ googleEventId, input });
      return { googleEventId, updatedAt };
    },
    async updateEvent(googleEventId, input) {
      const updatedAt = new Date().toISOString();
      this.updated.push({ googleEventId, input });
      return { updatedAt };
    },
    async deleteEvent(googleEventId) {
      this.deleted.push(googleEventId);
    },
  };
}

async function main() {
  // --- registerTools contract ---
  assert(info.id === 'calendar', 'plugin info.id is "calendar"');
  const noGoogleDeps = { settings: createFakeSettingsStore(), credentials: createFakeCredentialsStore() };
  const tools = await registerTools(noGoogleDeps);
  const names = tools.map((t) => t.definition.name).sort();
  assert(
    JSON.stringify(names) === JSON.stringify(['create_calendar_event', 'delete_calendar_event', 'get_calendar_schedule', 'update_calendar_event']),
    'registerTools returns exactly the four calendar tools',
  );

  const createTool = tools.find((t) => t.definition.name === 'create_calendar_event');
  const updateTool = tools.find((t) => t.definition.name === 'update_calendar_event');
  const deleteTool = tools.find((t) => t.definition.name === 'delete_calendar_event');
  const getTool = tools.find((t) => t.definition.name === 'get_calendar_schedule');

  const pool = createFakePool();
  const db = createPostgresClient(pool);
  const withUser = (fn) => db.withUserScope(USER_ID, (session) => fn({ userId: USER_ID, db: session }));

  // --- create_calendar_event, no Google connection configured: works, no sync-map row minted ---
  const created = await withUser((ctx) =>
    createTool.handler({ title: 'Pack for trip', start_time: '2026-08-01T10:00:00.000Z', end_time: '2026-08-01T11:00:00.000Z' }, ctx),
  );
  assert(created.source === 'native', 'create_calendar_event sets source=native');
  assert(created.isReadOnly === false, 'a native event reports isReadOnly=false via sourceMeta');
  assert(pool.events.length === 1 && pool.events[0].title === 'Pack for trip', 'native event actually persisted');
  assert(pool.syncMap.length === 0, 'no Google connection configured — no sync-map row is minted');

  // --- update_calendar_event / delete_calendar_event, still no Google connection ---
  const updated = await withUser((ctx) => updateTool.handler({ event_id: created.eventId, title: 'Pack for the trip' }, ctx));
  assert(updated.title === 'Pack for the trip', 'update_calendar_event changes the given field');
  assert(pool.events[0].title === 'Pack for the trip', 'update_calendar_event actually persisted the change');
  assert(pool.events[0].start_time === '2026-08-01T10:00:00.000Z', 'update_calendar_event leaves an omitted field unchanged');

  const deleted = await withUser((ctx) => deleteTool.handler({ event_id: created.eventId }, ctx));
  assert(deleted.deleted === true, 'delete_calendar_event reports success');
  assert(pool.events.length === 0, 'delete_calendar_event actually removed the row');

  // --- outbound push to Google: create/update/delete, via a fake GoogleCalendarClient ---
  {
    const googleClient = createFakeGoogleOutboundClient();
    const outCreateTool = createCreateCalendarEventTool(googleClient);
    const outUpdateTool = createUpdateCalendarEventTool(googleClient);
    const outDeleteTool = createDeleteCalendarEventTool(googleClient);

    const outCreated = await withUser((ctx) =>
      outCreateTool.handler({ title: 'Dentist', start_time: '2026-09-01T09:00:00.000Z', end_time: '2026-09-01T10:00:00.000Z' }, ctx),
    );
    assert(googleClient.inserted.length === 1 && googleClient.inserted[0].input.title === 'Dentist', 'create pushes the new event to Google');
    assert(
      pool.syncMap.length === 1 && pool.syncMap[0].event_id === outCreated.eventId && pool.syncMap[0].google_event_id === googleClient.inserted[0].googleEventId,
      'create mints a calendar_google_sync_map row linking the local event to the Google event',
    );

    await withUser((ctx) => outUpdateTool.handler({ event_id: outCreated.eventId, title: 'Dentist (rescheduled)' }, ctx));
    assert(
      googleClient.updated.length === 1 && googleClient.updated[0].googleEventId === googleClient.inserted[0].googleEventId,
      'update pushes the edit to the already-mapped Google event',
    );
    assert(googleClient.updated[0].input.title === 'Dentist (rescheduled)', 'the pushed update carries the new title');

    await withUser((ctx) => outDeleteTool.handler({ event_id: outCreated.eventId }, ctx));
    assert(
      googleClient.deleted.length === 1 && googleClient.deleted[0] === googleClient.inserted[0].googleEventId,
      'delete pushes the deletion to Google using the id looked up before the local row (and its sync-map row) was removed',
    );
    assert(pool.syncMap.length === 0, 'deleting the local row cascades away its sync-map row');
  }

  // --- update/delete on an event never mirrored to Google: no-op push, no crash ---
  {
    const googleClient = createFakeGoogleOutboundClient();
    const plainCreateTool = createCreateCalendarEventTool(undefined); // created with no Google connection at all
    const bare = await withUser((ctx) =>
      plainCreateTool.handler({ title: 'Unmirrored', start_time: '2026-09-02T09:00:00.000Z', end_time: '2026-09-02T10:00:00.000Z' }, ctx),
    );
    const outUpdateTool = createUpdateCalendarEventTool(googleClient);
    const outDeleteTool = createDeleteCalendarEventTool(googleClient);
    await withUser((ctx) => outUpdateTool.handler({ event_id: bare.eventId, title: 'Still unmirrored' }, ctx));
    await withUser((ctx) => outDeleteTool.handler({ event_id: bare.eventId }, ctx));
    assert(googleClient.updated.length === 0 && googleClient.deleted.length === 0, 'a never-mirrored event pushes nothing to Google on update/delete');
  }

  // --- linking + visibility (db/migrations/0025_calendar_links_visibility.sql) ---
  {
    const googleClient = createFakeGoogleOutboundClient();
    const linkCreateTool = createCreateCalendarEventTool(googleClient);
    const linkUpdateTool = createUpdateCalendarEventTool(googleClient);

    // A plain event (no link) still defaults to visibility='shared' and pushes to Google, same as always.
    const plain = await withUser((ctx) =>
      linkCreateTool.handler({ title: 'Plain event', start_time: '2026-10-01T09:00:00.000Z', end_time: '2026-10-01T10:00:00.000Z' }, ctx),
    );
    assert(plain.visibility === 'shared', 'an unlinked event defaults to visibility="shared"');
    assert(plain.created === true, 'an unlinked create always reports created: true (never deduplicated)');
    assert(googleClient.inserted.some((i) => i.input.title === 'Plain event'), 'a shared unlinked event is still pushed to Google by default');

    // A linked event defaults to visibility='private' and is NOT pushed, even with Google configured.
    const linked = await withUser((ctx) =>
      linkCreateTool.handler(
        { title: 'Finish the report', start_time: '2026-10-02T09:00:00.000Z', end_time: '2026-10-02T09:00:00.000Z', linked_note_id: 'note-123' },
        ctx,
      ),
    );
    assert(linked.visibility === 'private', 'promoting a note deadline defaults to visibility="private"');
    assert(linked.linkedNoteId === 'note-123' && linked.linkedListItemId === null, 'the link is recorded and the other link field stays null');
    assert(!googleClient.inserted.some((i) => i.input.title === 'Finish the report'), 'a private linked event is never pushed to Google on create');
    assert(linked.created === true, 'the first promotion of a given note reports created: true');

    // Re-promoting the same note (e.g. a second click of "Add to calendar") is a dedup no-op, not a duplicate.
    const eventCountBeforeRepeat = pool.events.length;
    const repeated = await withUser((ctx) =>
      linkCreateTool.handler(
        { title: 'Finish the report (edited title, ignored)', start_time: '2026-11-01T09:00:00.000Z', end_time: '2026-11-01T09:00:00.000Z', linked_note_id: 'note-123' },
        ctx,
      ),
    );
    assert(repeated.created === false, 're-promoting the same note reports created: false instead of making a duplicate');
    assert(repeated.eventId === linked.eventId, 're-promoting the same note returns the original event id');
    assert(pool.events.length === eventCountBeforeRepeat, 're-promoting the same note does not insert a second calendar_events row');
    assert(repeated.title === 'Finish the report', 'the reused event keeps its original title rather than being silently overwritten');

    // A different link (a list item, not the note) is unaffected — dedup is scoped per link field/value.
    const differentLink = await withUser((ctx) =>
      linkCreateTool.handler(
        { title: 'Pick up dry cleaning', start_time: '2026-11-02T09:00:00.000Z', end_time: '2026-11-02T09:00:00.000Z', linked_list_item_id: 'item-456' },
        ctx,
      ),
    );
    assert(differentLink.created === true && differentLink.eventId !== linked.eventId, 'a different linked_list_item_id is never deduped against an unrelated linked_note_id');

    // Giving both link fields is rejected.
    let rejectedBothLinks = false;
    try {
      await withUser((ctx) =>
        linkCreateTool.handler(
          { title: 'x', start_time: '2026-10-02T09:00:00.000Z', end_time: '2026-10-02T09:00:00.000Z', linked_note_id: 'n', linked_list_item_id: 'i' },
          ctx,
        ),
      );
    } catch {
      rejectedBothLinks = true;
    }
    assert(rejectedBothLinks, 'create_calendar_event rejects linked_note_id and linked_list_item_id given together');

    // Flipping private -> shared mints a Google mapping that never existed.
    await withUser((ctx) => linkUpdateTool.handler({ event_id: linked.eventId, visibility: 'shared' }, ctx));
    assert(googleClient.inserted.some((i) => i.input.title === 'Finish the report'), 'flipping a private linked event to shared pushes (mints) it on Google');
    assert(pool.syncMap.some((m) => m.event_id === linked.eventId), 'the flip to shared leaves a sync-map row for the event');

    // Flipping shared -> private pulls it back off Google and drops the mapping.
    await withUser((ctx) => linkUpdateTool.handler({ event_id: linked.eventId, visibility: 'private' }, ctx));
    assert(googleClient.deleted.length > 0, 'flipping back to private pulls the event off Google');
    assert(!pool.syncMap.some((m) => m.event_id === linked.eventId), 'flipping back to private drops the now-stale sync-map row');

    // get_calendar_schedule passes visibility/link fields straight through.
    const withLinks = await withUser((ctx) => getTool.handler({ start_date: '2026-10-01', end_date: '2026-10-02' }, ctx));
    const reportEvent = withLinks.find((e) => e.eventId === linked.eventId);
    assert(reportEvent.visibility === 'private' && reportEvent.linkedNoteId === 'note-123', 'get_calendar_schedule returns visibility and linkedNoteId for a linked, currently-private event');

    // cleanup so later "sanity: no native rows survived" assertions still hold
    const cleanupDeleteTool = createDeleteCalendarEventTool(googleClient);
    await withUser((ctx) => cleanupDeleteTool.handler({ event_id: plain.eventId }, ctx));
    await withUser((ctx) => cleanupDeleteTool.handler({ event_id: linked.eventId }, ctx));
    await withUser((ctx) => cleanupDeleteTool.handler({ event_id: differentLink.eventId }, ctx));
  }

  // --- inbound Google sync (googleSync.ts): insert / update-applied / update-skipped / cancel-delete ---
  {
    const settings = createFakeSettingsStore();
    const googleUpdatedAt = new Date().toISOString();

    // New Google-originated event, never seen before.
    let listResult = { events: [{ googleEventId: 'g-in-1', status: 'confirmed', title: 'Soccer practice', description: null, location: null, startTime: '2026-09-03T15:00:00.000Z', endTime: '2026-09-03T16:00:00.000Z', allDay: false, updatedAt: googleUpdatedAt }], nextSyncToken: 'token-1' };
    let fakeClient = { calendarId: 'primary', async listEvents() { return listResult; } };
    await syncGoogleOnce(db, fakeClient, USER_ID, settings);
    const inserted = pool.events.find((e) => e.external_id === 'g-in-1');
    assert(inserted && inserted.source === 'google' && inserted.title === 'Soccer practice', 'an unmapped, non-cancelled Google event is adopted as a new source=google row');
    assert(pool.syncMap.some((m) => m.google_event_id === 'g-in-1' && m.event_id === inserted.event_id), 'adopting it mints a sync-map row');
    assert((await settings.get('google_calendar_sync_token')) === 'token-1', 'syncGoogleOnce persists the returned nextSyncToken');

    // Google reports a newer update for the same event — must be applied.
    const newerUpdatedAt = new Date(Date.now() + 60_000).toISOString();
    listResult = { events: [{ googleEventId: 'g-in-1', status: 'confirmed', title: 'Soccer practice (moved)', description: null, location: null, startTime: '2026-09-03T16:00:00.000Z', endTime: '2026-09-03T17:00:00.000Z', allDay: false, updatedAt: newerUpdatedAt }], nextSyncToken: 'token-2' };
    await syncGoogleOnce(db, fakeClient, USER_ID, settings);
    assert(pool.events.find((e) => e.event_id === inserted.event_id).title === 'Soccer practice (moved)', 'a Google update newer than the local row is applied');

    // Google reports a version *older* than the local row (e.g. a stale poll) — must be ignored.
    pool.events.find((e) => e.event_id === inserted.event_id).updated_at = new Date(Date.now() + 120_000).toISOString(); // simulate a newer local edit
    const staleUpdatedAt = new Date(Date.now() - 120_000).toISOString();
    listResult = { events: [{ googleEventId: 'g-in-1', status: 'confirmed', title: 'Should not apply', description: null, location: null, startTime: '2026-09-03T16:00:00.000Z', endTime: '2026-09-03T17:00:00.000Z', allDay: false, updatedAt: staleUpdatedAt }], nextSyncToken: 'token-3' };
    await syncGoogleOnce(db, fakeClient, USER_ID, settings);
    assert(pool.events.find((e) => e.event_id === inserted.event_id).title === 'Soccer practice (moved)', 'a Google update older than the local row is left alone (last-write-wins)');

    // Cancellation of a mapped event deletes the local row.
    listResult = { events: [{ googleEventId: 'g-in-1', status: 'cancelled', title: 'Soccer practice (moved)', description: null, location: null, startTime: '2026-09-03T16:00:00.000Z', endTime: '2026-09-03T17:00:00.000Z', allDay: false, updatedAt: new Date().toISOString() }], nextSyncToken: 'token-4' };
    await syncGoogleOnce(db, fakeClient, USER_ID, settings);
    assert(!pool.events.some((e) => e.external_id === 'g-in-1'), 'a cancelled, mapped Google event deletes the local row');
    assert(!pool.syncMap.some((m) => m.google_event_id === 'g-in-1'), 'deleting it cascades away its sync-map row');

    // Cancellation of an event we never knew about is a no-op, not an error.
    listResult = { events: [{ googleEventId: 'g-in-never-seen', status: 'cancelled', title: 'x', description: null, location: null, startTime: '2026-09-03T16:00:00.000Z', endTime: '2026-09-03T17:00:00.000Z', allDay: false, updatedAt: new Date().toISOString() }], nextSyncToken: 'token-5' };
    await syncGoogleOnce(db, fakeClient, USER_ID, settings);
    assert(!pool.events.some((e) => e.external_id === 'g-in-never-seen'), 'cancelling an unmapped event stays a no-op');
  }

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
  const nativeLeft = pool.events.filter((e) => e.source === 'native');
  assert(nativeLeft.length === 0, 'sanity: no native rows survived the create/update/delete cycles above');
  await withUser((ctx) =>
    createTool.handler({ title: 'Pack for trip', start_time: '2026-08-01T10:00:00.000Z', end_time: '2026-08-01T11:00:00.000Z' }, ctx),
  );
  const schedule = await withUser((ctx) =>
    getTool.handler({ start_date: '2026-01-01', end_date: '2026-12-31', sources: ['native'] }, ctx),
  );
  assert(schedule.length === 1 && schedule[0].title === 'Pack for trip', 'get_calendar_schedule filters by sources');
  assert(schedule[0].colorCode === '#10B981' && schedule[0].isReadOnly === false, 'schedule rows are enriched with sourceMeta');

  const allSources = await withUser((ctx) => getTool.handler({ start_date: '2026-01-01', end_date: '2026-12-31' }, ctx));
  assert(allSources.length === pool.events.length, 'omitting sources returns events from every source');

  // --- "today" is resolved through household_timezone, not the server's own (UTC) clock — a
  // server-local "today" would silently drop events that are already today for a household west
  // of UTC, which is the bug this default exists to avoid. ---
  {
    const tzCalls = [];
    const spySettings = { async get(key) { tzCalls.push(key); return 'Australia/Perth'; } };
    const tzTools = await registerTools({ settings: spySettings, credentials: createFakeCredentialsStore() });
    const tzGetTool = tzTools.find((t) => t.definition.name === 'get_calendar_schedule');
    await withUser((ctx) => tzGetTool.handler({}, ctx));
    assert(tzCalls.includes('household_timezone'), 'get_calendar_schedule resolves "today" through household_timezone on every call, not the server clock');
  }

  // --- sourceMeta / applyPrivacyMask as pure functions ---
  assert(sourceMeta('cozi').colorCode === '#8B5CF6' && sourceMeta('cozi').isReadOnly === true, 'sourceMeta("cozi") is purple and read-only');
  assert(sourceMeta('google').colorCode === '#EA4335' && sourceMeta('google').isReadOnly === false, 'sourceMeta("google") is Google-red and editable under OAuth sync');
  const rawEvent = { externalId: 'x', title: 'Real title', description: 'Real desc', location: 'Real place', startTime: 'a', endTime: 'b', allDay: false };
  assert(applyPrivacyMask(rawEvent, false) === rawEvent, 'applyPrivacyMask is a no-op (same reference) when shouldMask=false');
  assert(applyPrivacyMask(rawEvent, true).title === 'Work Commitment', 'applyPrivacyMask replaces title when shouldMask=true');

  // --- startBackgroundJobs resolves settings via deps.settings/deps.credentials, not raw env (bb_principles.md §§12-13) ---
  {
    const resolveCalls = [];
    const fakeCredentials = {
      async resolve(name, envFallback) {
        resolveCalls.push({ name, envFallback });
        return undefined; // neither ICS feed nor Google configured — proves no poll timer gets started off unresolved secrets
      },
    };
    const settingsGetCalls = [];
    const fakeSettings = {
      async get(key) {
        settingsGetCalls.push(key);
        return undefined; // nothing in the DB yet — falls back to the env var set below for calendar_owner_user_id
      },
    };
    const originalOwner = process.env.BIGBRAIN_CALENDAR_OWNER_USER_ID;
    process.env.BIGBRAIN_CALENDAR_OWNER_USER_ID = USER_ID;
    try {
      await startBackgroundJobs({ db, credentials: fakeCredentials, settings: fakeSettings });
    } finally {
      if (originalOwner === undefined) delete process.env.BIGBRAIN_CALENDAR_OWNER_USER_ID;
      else process.env.BIGBRAIN_CALENDAR_OWNER_USER_ID = originalOwner;
    }
    assert(
      settingsGetCalls.includes('calendar_owner_user_id'),
      'startBackgroundJobs resolves the owning user through deps.settings before falling back to env',
    );
    assert(
      resolveCalls.some((c) => c.name === 'cozi_ics_url') && resolveCalls.some((c) => c.name === 'outlook_ics_url'),
      'startBackgroundJobs resolves both ICS feed URLs through deps.credentials, not process.env directly',
    );
    assert(
      settingsGetCalls.includes('google_calendar_owner_user_id'),
      'startBackgroundJobs separately checks google_calendar_owner_user_id — the ICS and Google connections are independently gated',
    );
    assert(
      !resolveCalls.some((c) => c.name === 'google_calendar_client_secret'),
      'no google_calendar_owner_user_id configured — Google Calendar client resolution is short-circuited before touching credentials at all',
    );
  }
}

main().catch((err) => {
  console.error('verify-calendar crashed:', err);
  process.exitCode = 1;
});
