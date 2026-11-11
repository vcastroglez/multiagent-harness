#!/usr/bin/env node
// Enrol the dashboard's second factor (TOTP, 6 digits, 30 s). Run it on the host yourself:
//
//   node web/totp-setup.js            # creates ~/.config/mah/totp.key (mode 600)
//   node web/totp-setup.js --force    # replaces an existing key (old codes stop working)
//
// The base32 secret is printed once. Add it to an authenticator app (manual entry).
// Until this file exists the dashboard refuses every sign-in (MAH_REQUIRE_TOTP=0 overrides).
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const auth = require('./auth');

const file = auth.totpFile();
const force = process.argv.includes('--force');

if (fs.existsSync(file) && !force) {
  console.error(`Already enrolled: ${file}\nRun with --force to replace the secret.`);
  process.exit(1);
}

const secret = auth.base32Encode(crypto.randomBytes(20));
fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
fs.writeFileSync(file, `${secret}\n`, { mode: 0o600 });
fs.chmodSync(file, 0o600);

const label = encodeURIComponent(`multiagent-harness dashboard (${os.userInfo().username})`);
console.log(`Wrote ${file} (mode 600).`);
console.log(`Secret (base32): ${secret}`);
const uri = `otpauth://totp/${label}?secret=${secret}&issuer=multiagent-harness&algorithm=SHA1&digits=6&period=30`;

// Scan with the authenticator app. The optional `qrcode` package lives in ~/.config/mah
// (npm install --prefix ~/.config/mah qrcode); without it only the URI is printed.
function loadQr() {
  for (const p of [path.join(os.homedir(), '.config', 'mah', 'node_modules', 'qrcode'), 'qrcode']) {
    try { return require(p); } catch { /* try the next location */ }
  }
  return null;
}
const qr = loadQr();
if (qr) {
  qr.toString(uri, { type: 'terminal', small: true }).then((art) => {
    console.log('\nScan this QR code with your authenticator app:\n');
    console.log(art);
    console.log(`If scanning fails, enter the secret manually. URI: ${uri}`);
  });
} else {
  console.log(`otpauth URI: ${uri}`);
}
