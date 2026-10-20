/**
 * Which channel a recipient identity lives on — decided by the IDENTITY.
 *
 * users.phone_number is the channel identity: a bare number is WhatsApp,
 * "mtx:…" / "matrix:…" / "slack:…" / "discord:…" belong to an additive channel
 * that runs alongside whichever WhatsApp driver is configured. So the Meta-only
 * machinery (the 24-hour window, approved templates, the window-closed cache)
 * applies only when BOTH hold: the identity is a bare number AND the resolved
 * WhatsApp driver is Meta. A deployment with CHANNEL_DRIVER=meta and Matrix
 * live sends to "mtx:…" directly — never a window check, never a template.
 * Same rule as the editable-form Flow gate.
 */

const { resolveChannelDriver } = require('../../config/feature-availability');

const BARE_NUMBER = /^\+?\d{6,20}$/;

/** @returns {boolean} true when Meta-only sends/limits apply to this identity */
function isMetaRecipient(identity, env = process.env) {
  if (typeof identity !== 'string' || !BARE_NUMBER.test(identity.trim())) return false;
  return resolveChannelDriver(env) === 'meta';
}

/** A human-readable form of an identity for coach-facing copy ("+15550100002"). */
function displayIdentity(identity) {
  const s = String(identity || '');
  const m = s.match(/^(?:[a-z]+:)?\+?(\d{6,20})$/i);
  return m ? `+${m[1]}` : s;
}

module.exports = { isMetaRecipient, displayIdentity, BARE_NUMBER };
