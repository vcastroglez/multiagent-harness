// Login hardening for the dashboard (zero dependencies): who may sign in, how failed
// attempts lock an account, and a TOTP second factor (RFC 6238, HMAC-SHA1, 6 digits, 30 s).
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const STEP_MS = 30 * 1000;
const DIGITS = 6;
const SKEW_STEPS = 1; // accept the previous and next code as well
const LOCK_THRESHOLD = 5; // failures before an account is locked
const LOCK_BASE_MS = 15 * 60 * 1000;
const LOCK_MAX_MS = 24 * 60 * 60 * 1000;
const FAILURE_DECAY_MS = 24 * 60 * 60 * 1000; // quiet for a day => the counter starts over

// Only these Linux accounts may sign in. Defaults to the account running the dashboard.
function allowedUsers(env = process.env) {
  const list = String(env.MAH_ALLOWED_USERS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (list.length) return new Set(list);
  return new Set([os.userInfo().username]);
}

function totpFile(env = process.env) {
  return env.MAH_TOTP_FILE || path.join(os.homedir(), '.config', 'mah', 'totp.key');
}

// Enrolled = the secret file exists and holds a usable key.
function readTotpSecret(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    return raw ? base32Decode(raw) : null;
  } catch { return null; }
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(input) {
  const clean = String(input).toUpperCase().replace(/[\s=-]/g, '');
  if (!/^[A-Z2-7]+$/.test(clean)) throw new Error('invalid base32 secret');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function hotp(key, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', key).update(msg).digest();
  const off = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

// Returns the matched time step, or null. Steps at or before lastStep are rejected (replay).
function verifyTotp(key, code, nowMs = Date.now(), lastStep = -1) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const step = Math.floor(nowMs / STEP_MS);
  for (let d = -SKEW_STEPS; d <= SKEW_STEPS; d += 1) {
    const s = step + d;
    if (s <= lastStep) continue;
    const expected = hotp(key, s);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return s;
  }
  return null;
}

// Per-account failure state, shared by every IP and kept across restarts.
function loadLockState(file) {
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    return doc && typeof doc === 'object' && doc.users && typeof doc.users === 'object' ? doc : { users: {} };
  } catch { return { users: {} }; }
}

function saveLockState(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function accountLock(doc, user, nowMs = Date.now()) {
  const u = doc.users[user];
  if (!u) return { locked: false, retryAfter: 0 };
  if (u.lockedUntil && u.lockedUntil > nowMs) {
    return { locked: true, retryAfter: Math.ceil((u.lockedUntil - nowMs) / 1000) };
  }
  return { locked: false, retryAfter: 0 };
}

// Escalating lock: 15 min after the 5th failure, doubling each further failure, max 24 h.
function recordFailure(doc, user, nowMs = Date.now()) {
  const u = doc.users[user] || { fails: 0, lockedUntil: 0, lastFail: 0 };
  if (nowMs - (u.lastFail || 0) > FAILURE_DECAY_MS) u.fails = 0;
  u.fails += 1;
  u.lastFail = nowMs;
  if (u.fails >= LOCK_THRESHOLD) {
    const span = Math.min(LOCK_MAX_MS, LOCK_BASE_MS * 2 ** (u.fails - LOCK_THRESHOLD));
    u.lockedUntil = nowMs + span;
  }
  doc.users[user] = u;
  return u;
}

// Clears the failure state but keeps the last accepted TOTP step (no code replay).
function recordSuccess(doc, user, step = null) {
  const u = doc.users[user] || {};
  doc.users[user] = { fails: 0, lastFail: 0, lockedUntil: 0, lastStep: step !== null ? step : (u.lastStep ?? -1) };
}

module.exports = {
  allowedUsers, totpFile, readTotpSecret, base32Decode, base32Encode,
  hotp, verifyTotp, loadLockState, saveLockState, accountLock, recordFailure, recordSuccess,
  LOCK_THRESHOLD, LOCK_BASE_MS, LOCK_MAX_MS,
};
