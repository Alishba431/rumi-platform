#!/usr/bin/env node
/**
 * Link a school, its head teacher and its staff — what turns staff attendance on.
 *
 * A head teacher's "attendance" means staff attendance once:
 *   1. a `schools` row exists,
 *   2. the head teacher's users row has that school_id and role 'head_teacher',
 *   3. their colleagues' users rows have that school_id.
 * Colleagues who never use the bot can be added by name; they appear on the staff
 * register like everyone else.
 *
 * Usage (from bot/):
 *   node scripts/attendance/link-school.js --school "Hillside Primary" [--ext-id HP-01] \
 *     --head <person> [--staff <person> ...] [--staff-name "Full Name" ...]
 *
 * <person> is a users.id, a WhatsApp number (digits, any punctuation), or a channel
 * identity as the bot addresses it: "slack:U0123", "discord:1234", "matrix:@ivy:example.org".
 * A channel identity is found once that person has messaged the bot.
 *
 * Idempotent: re-running reuses the school (matched by --ext-id, else by exact name)
 * and does not duplicate name-only staff. People it cannot find are reported and
 * skipped; a head teacher it cannot find stops the run before anything is written.
 */

const supabase = require('../../shared/config/supabase');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEAD_TEACHER_ROLE = 'head_teacher';

function parseArgs(argv) {
  const out = { school: null, extId: null, head: null, staff: [], staffNames: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--school') { out.school = value; i += 1; }
    else if (flag === '--ext-id') { out.extId = value; i += 1; }
    else if (flag === '--head') { out.head = value; i += 1; }
    else if (flag === '--staff') { out.staff.push(value); i += 1; }
    else if (flag === '--staff-name') { out.staffNames.push(value); i += 1; }
  }
  return out;
}

/** A users row for an id, a WhatsApp number, or a "channel:id" identity — or null. */
async function resolveUser(who) {
  const value = String(who || '').trim();
  if (!value) return null;

  if (UUID.test(value)) {
    const { data } = await supabase.from('users').select('id, name, phone_number').eq('id', value).maybeSingle();
    return data || null;
  }

  const colon = value.indexOf(':');
  if (colon > 0 && !/^\+?[\d\s()-]+$/.test(value)) {
    const channel = value.slice(0, colon);
    const channelUserId = value.slice(colon + 1);
    const { data: link } = await supabase
      .from('user_channels')
      .select('user_id')
      .eq('channel', channel)
      .eq('channel_user_id', channelUserId)
      .maybeSingle();
    if (!link) return null;
    const { data } = await supabase.from('users').select('id, name, phone_number').eq('id', link.user_id).maybeSingle();
    return data || null;
  }

  const digits = value.replace(/\D/g, '');
  if (!digits) return null;
  const { data } = await supabase.from('users').select('id, name, phone_number').eq('phone_number', digits).maybeSingle();
  return data || null;
}

async function findOrCreateSchool(name, extId) {
  const lookup = extId
    ? supabase.from('schools').select('id, name, ext_id').eq('ext_id', extId)
    : supabase.from('schools').select('id, name, ext_id').eq('name', name);
  const { data: existing } = await lookup.maybeSingle();
  if (existing) return existing;

  const { data: created, error } = await supabase
    .from('schools')
    .insert({ name, ext_id: extId || null })
    .select('id, name, ext_id')
    .single();
  if (error) throw new Error(`Could not create the school: ${error.message}`);
  return created;
}

async function setUser(userId, patch) {
  const { error } = await supabase.from('users').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', userId);
  if (error) throw new Error(`Could not update user ${userId}: ${error.message}`);
}

/** A colleague who does not use the bot: a users row with a name and a school, nothing else. */
async function ensureNameOnlyStaff(name, schoolId) {
  const { data: existing } = await supabase
    .from('users')
    .select('id')
    .eq('school_id', schoolId)
    .eq('name', name)
    .limit(1);
  if (existing && existing.length) return existing[0].id;

  const { data, error } = await supabase
    .from('users')
    .insert({ name, school_id: schoolId, registration_completed: false, source: 'staff_roster' })
    .select('id')
    .single();
  if (error) throw new Error(`Could not add ${name}: ${error.message}`);
  return data.id;
}

/**
 * @param {{school: string, extId?: string, head: string, staff: string[], staffNames: string[]}} args
 * @returns {Promise<{school: object, head: object, linked: string[], added: string[], missing: string[]}>}
 */
async function linkSchool({ school, extId = null, head, staff = [], staffNames = [] }) {
  if (!school) throw new Error('--school is required');
  if (!head) throw new Error('--head is required');

  // Resolve everyone before writing anything, so a typo in --head writes nothing.
  const headUser = await resolveUser(head);
  if (!headUser) throw new Error(`Could not find the head teacher "${head}". They need to have messaged the bot, or pass their users.id.`);

  const resolved = [];
  const missing = [];
  for (const who of staff) {
    const user = await resolveUser(who);
    if (user) resolved.push(user);
    else missing.push(who);
  }

  const schoolRow = await findOrCreateSchool(school, extId);
  await setUser(headUser.id, { school_id: schoolRow.id, role: HEAD_TEACHER_ROLE });

  const linked = [];
  for (const user of resolved) {
    if (user.id === headUser.id) continue;
    await setUser(user.id, { school_id: schoolRow.id });
    linked.push(user.name || user.id);
  }

  const added = [];
  for (const name of staffNames) {
    if (!String(name || '').trim()) continue;
    await ensureNameOnlyStaff(name.trim(), schoolRow.id);
    added.push(name.trim());
  }

  return { school: schoolRow, head: headUser, linked, added, missing };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    const result = await linkSchool(args);
    console.log(`School: ${result.school.name}${result.school.ext_id ? ` (${result.school.ext_id})` : ''} — ${result.school.id}`);
    console.log(`Head teacher: ${result.head.name || result.head.id}`);
    if (result.linked.length) console.log(`Linked staff: ${result.linked.join(', ')}`);
    if (result.added.length) console.log(`Added by name: ${result.added.join(', ')}`);
    if (result.missing.length) console.log(`Not found (skipped): ${result.missing.join(', ')}`);
    console.log('Done. The head teacher can now say "attendance" to mark staff attendance.');
  } catch (error) {
    console.error(`link-school: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs, resolveUser, linkSchool };
