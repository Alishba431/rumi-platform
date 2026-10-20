'use strict';
/**
 * The calendar invite for a scheduled visit — an optional provider.
 *
 * A coach schedules a visit in chat and then has to hold it in their head; the
 * invite puts it where the rest of their week already lives.
 *
 * Three rules, in order of importance:
 * 1. The invite may never break the scheduling. Scheduling is the product, the
 *    invite a courtesy on top. Every entry point here is best-effort and
 *    swallows its errors — an expired key, a 403, a stalled network leave the
 *    visit saved and nothing else different.
 * 2. No directory row, no invite — silently. The address is READ from
 *    coach_directory (coach-directory.js), never guessed from a name: one wrong
 *    match puts a school visit on a stranger's calendar.
 * 3. The coach only. Teachers are not attendees.
 *
 * OBSERVE_CALENDAR_ENABLED (default off): 'true' = every coach with a directory
 * row; a comma list of users.id = only those coaches (a first group).
 */

const supabase = require('../../config/supabase');
const { logToFile } = require('../../utils/logger');
const google = require('./google-calendar.client');
const CoachDirectory = require('./coach-directory');

const VISIT_MINUTES = 60;

function _enabledFor(leaderUserId) {
  const raw = (process.env.OBSERVE_CALENDAR_ENABLED || '').trim();
  if (!raw || raw === 'false' || raw === '0') return false;
  if (raw === 'true') return true;
  return raw.split(',').map((s) => s.trim()).filter(Boolean).includes(String(leaderUserId));
}

function _addMinutes(hhmm, minutes) {
  const [h, m] = String(hhmm).split(':').map(Number);
  const total = (h * 60 + m + minutes) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * A picked slot is booked as a timed event; no slot books the DAY — inventing
 * a start time the coach never chose is worse than an all-day entry.
 */
function _timing(schedule) {
  const date = schedule.scheduled_for;
  const slot = schedule.scheduled_slot;
  if (!slot) return { start: { date }, end: { date } };
  const timeZone = process.env.OBSERVE_CALENDAR_TIMEZONE || 'UTC';
  return {
    start: { dateTime: `${date}T${slot}:00`, timeZone },
    end: { dateTime: `${date}T${_addMinutes(slot, VISIT_MINUTES)}:00`, timeZone },
  };
}

function _buildEvent(schedule, email) {
  const teacher = (schedule.teacher_name || '').trim() || 'a teacher';
  const school = (schedule.school_name || '').trim();
  return {
    summary: school ? `Observation: ${teacher} — ${school}` : `Observation: ${teacher}`,
    description: `Classroom observation with ${teacher}${school ? ` at ${school}` : ''}. Type /observe to open your brief.`,
    attendees: [{ email }],
    ..._timing(schedule),
  };
}

async function _storeEventId(scheduleId, eventId) {
  try {
    await supabase.from('observation_schedules')
      .update({ calendar_event_id: eventId, updated_at: new Date().toISOString() })
      .eq('id', scheduleId);
  } catch (err) {
    logToFile('observe-calendar: could not store event id (non-blocking)', { scheduleId, error: err.message });
  }
}

/** Flag on, transport configured, coach in the directory → their email; else null. */
async function _gate(schedule) {
  if (!schedule || !schedule.leader_user_id) return null;
  if (!_enabledFor(schedule.leader_user_id)) return null;
  if (!google.isConfigured()) return null;
  return CoachDirectory.getWorkEmail(schedule.leader_user_id);
}

async function _create(schedule, email) {
  const created = await google.insertEvent(_buildEvent(schedule, email));
  if (created && created.id) await _storeEventId(schedule.id, created.id);
  logToFile('observe-calendar: invite sent', { scheduleId: schedule.id, eventId: created && created.id });
  return created;
}

async function onScheduled(schedule) {
  try {
    const email = await _gate(schedule);
    if (email) await _create(schedule, email);
  } catch (err) {
    logToFile('observe-calendar: create failed (non-blocking)', { scheduleId: schedule && schedule.id, error: err.message });
  }
}

/**
 * Patch the event this schedule already owns — never search the calendar for
 * "the one it probably was". A schedule made before the flag went on gets its
 * invite now.
 */
async function onRescheduled(schedule) {
  try {
    const email = await _gate(schedule);
    if (!email) return;
    if (!schedule.calendar_event_id) { await _create(schedule, email); return; }
    await google.patchEvent(schedule.calendar_event_id, _timing(schedule));
  } catch (err) {
    logToFile('observe-calendar: patch failed (non-blocking)', { scheduleId: schedule && schedule.id, error: err.message });
  }
}

/** Clearing the stored id is what makes a second cancel a no-op. */
async function onCancelled(schedule) {
  try {
    const email = await _gate(schedule);
    if (!email || !schedule.calendar_event_id) return;
    await google.deleteEvent(schedule.calendar_event_id);
    await _storeEventId(schedule.id, null);
  } catch (err) {
    logToFile('observe-calendar: delete failed (non-blocking)', { scheduleId: schedule && schedule.id, error: err.message });
  }
}

module.exports = { onScheduled, onRescheduled, onCancelled, _enabledFor, _buildEvent };
