'use strict';
/**
 * coach_directory — a coach's work email, resolved ONCE and then only read.
 *
 * The calendar invite needs an address. The rule this file enforces: never
 * resolve an email per invite from a name. A similarity score happily matches
 * one person's name to a mailbox belonging to someone else (the strings share
 * letters), and one wrong match puts a school visit on a stranger's calendar —
 * while a miss only costs a coach an invite. So the mapping is stored, and the
 * only automatic matching allowed is one that can be justified:
 *
 *   1. strip invisible control / bidi characters (they survive spreadsheets);
 *   2. compare the roster name with BOTH the directory's full name AND the
 *      email local-part (a mailbox often encodes first.last where the HR record
 *      holds a given name only);
 *   3. last resort: the same words in any order. Never a ratio, never a subset.
 */

const { logToFile } = require('../../utils/logger');

// C0/C1 controls, zero-width + bidi marks, overrides, invisible joiners, BOM.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤﻿]/g;

/** A name reduced to comparable lowercase words. Pure and total: junk → ''. */
function normalizeCoachName(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(CONTROL_CHARS, '')
    .toLowerCase()
    // Punctuation SEPARATES words — "first-last" is two tokens, not one.
    .replace(/[.,'‘’`_\-/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `first.last@example.org` → `first last`. */
function nameFromEmail(email) {
  if (typeof email !== 'string') return '';
  const at = email.indexOf('@');
  return normalizeCoachName(at === -1 ? email : email.slice(0, at));
}

function _sameWords(a, b) {
  const A = new Set(normalizeCoachName(a).split(' ').filter(Boolean));
  const B = new Set(normalizeCoachName(b).split(' ').filter(Boolean));
  if (!A.size || A.size !== B.size) return false;
  for (const w of A) if (!B.has(w)) return false;
  return true;
}

/** Does this roster name denote the person behind (fullName, email)? Only when justified. */
function matchesRosterName(rosterName, fullName, email) {
  const roster = normalizeCoachName(rosterName);
  if (!roster) return false;
  const full = normalizeCoachName(fullName);
  const mailbox = nameFromEmail(email);
  if (full && roster === full) return true;
  if (mailbox && roster === mailbox) return true;
  return (!!full && _sameWords(roster, full)) || (!!mailbox && _sameWords(roster, mailbox));
}

/**
 * One roster name against candidates, refusing to guess.
 * @returns {{ok, match, reason: 'ok'|'no_match'|'ambiguous'|'no_input', candidates?}}
 */
function resolveRosterName(rosterName, candidates) {
  if (!normalizeCoachName(rosterName) || !Array.isArray(candidates) || !candidates.length) {
    return { ok: false, match: null, reason: 'no_input' };
  }
  const hits = candidates.filter((c) => c && matchesRosterName(rosterName, c.name, c.email));
  if (hits.length === 1) return { ok: true, match: hits[0], reason: 'ok' };
  if (!hits.length) return { ok: false, match: null, reason: 'no_match' };
  return { ok: false, match: null, reason: 'ambiguous', candidates: hits };
}

/** The coach's stored work email, or null. Never derived. */
async function getWorkEmail(leaderUserId) {
  if (!leaderUserId) return null;
  const supabase = require('../../config/supabase');
  const { data, error } = await supabase
    .from('coach_directory')
    .select('work_email')
    .eq('leader_user_id', leaderUserId)
    .maybeSingle();
  if (error || !data || !data.work_email) return null;
  return data.work_email;
}

/**
 * Store (or replace) a coach's work email — a person typed it, so 'manual'.
 * @returns {Promise<object>} the row
 */
async function setWorkEmail(leaderUserId, { email, fullName }) {
  const clean = String(email || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) throw new Error(`coach-directory: not an email address: "${email}"`);
  const supabase = require('../../config/supabase');
  const { data, error } = await supabase
    .from('coach_directory')
    .upsert({
      leader_user_id: leaderUserId,
      work_email: clean,
      full_name: String(fullName || '').trim() || clean,
      match_method: 'manual',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'leader_user_id' })
    .select()
    .single();
  if (error) throw new Error(`coach-directory: save failed: ${error.message}`);
  logToFile('coach-directory: work email stored', { leaderUserId });
  return data;
}

module.exports = {
  normalizeCoachName, nameFromEmail, matchesRosterName, resolveRosterName, getWorkEmail, setWorkEmail,
};
