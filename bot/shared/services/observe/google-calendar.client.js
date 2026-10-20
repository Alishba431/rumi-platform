'use strict';
/**
 * Google Calendar transport — the thin, dependency-free layer.
 *
 * WHY NO SDK: the Google client library is a very large dependency for three
 * calls (insert, patch, delete) on one API, and this feature ships OFF by
 * default — every cloner would pay for it whether or not they turn it on. The
 * whole protocol here is: sign a JWT with the service-account key (Node's own
 * crypto signs RS256), exchange it for an access token, make the REST call.
 *
 * IMPERSONATION: a service account has no calendar a person can see. To send
 * invites to attendees it has to act as a real workspace user (domain-wide
 * delegation) — that is the `sub` claim, set from GOOGLE_CALENDAR_SUBJECT.
 * Without a subject the events are written to GOOGLE_CALENDAR_ID as the service
 * account itself, which only works for a calendar shared with it.
 *
 * CONFIGURATION (read at call time):
 *   GOOGLE_SERVICE_ACCOUNT_JSON  the service-account key, inline JSON
 *   GOOGLE_CALENDAR_ID           target calendar
 *   GOOGLE_CALENDAR_SUBJECT      optional — the workspace user to act as
 * Missing the key or the calendar id leaves this dormant (isConfigured false).
 */

const crypto = require('crypto');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://www.googleapis.com/calendar/v3/calendars';
const SCOPE = 'https://www.googleapis.com/auth/calendar';

function config() {
  return {
    keyJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '',
    subject: process.env.GOOGLE_CALENDAR_SUBJECT || '',
    calendarId: process.env.GOOGLE_CALENDAR_ID || '',
  };
}

function isConfigured() {
  const c = config();
  return Boolean(c.keyJson && c.calendarId);
}

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// One token per subject until shortly before it expires.
let cached = null;

async function accessToken() {
  const { keyJson, subject } = config();
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.subject === subject && cached.expiresAt > now + 60) return cached.token;

  const key = JSON.parse(keyJson);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: key.client_email,
    ...(subject ? { sub: subject } : {}),
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }));
  const signature = b64url(crypto.createSign('RSA-SHA256').update(`${header}.${claims}`).sign(key.private_key));

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${signature}`,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`google-calendar: token exchange failed (${res.status}) ${body.error_description || ''}`);
  }
  cached = { subject, token: body.access_token, expiresAt: now + (body.expires_in || 3600) };
  return cached.token;
}

async function call(method, pathSuffix, payload) {
  const { calendarId } = config();
  const token = await accessToken();
  const url = `${API_BASE}/${encodeURIComponent(calendarId)}/events${pathSuffix}`;
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(payload ? { 'Content-Type': 'application/json' } : {}) },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  if (res.status === 204) return true;   // DELETE
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`google-calendar: ${method} ${res.status} ${(body.error && body.error.message) || ''}`);
  return body;
}

// sendUpdates=all so the coach actually receives the mail — without it the
// event is created and nobody is told.
const insertEvent = (event) => call('POST', '?sendUpdates=all', event);
const patchEvent = (eventId, patch) => call('PATCH', `/${encodeURIComponent(eventId)}?sendUpdates=all`, patch);
const deleteEvent = (eventId) => call('DELETE', `/${encodeURIComponent(eventId)}?sendUpdates=all`);

module.exports = {
  isConfigured, insertEvent, patchEvent, deleteEvent, _resetTokenCache: () => { cached = null; },
};
