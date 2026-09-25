#!/usr/bin/env node
// scripts/show-credentials.mjs - print the Pi web UI login banner (username,
// password, local + remote URL, one-click auth_token link).
//
// The password is a secret: this prints it to STDOUT only. It is never written
// to data/logs/. Do not redirect its output into a log file.
//
// Usage:
//   node scripts/show-credentials.mjs          # human-readable banner
//   node scripts/show-credentials.mjs --plain  # no ANSI colors
//   node scripts/show-credentials.mjs --json   # machine-readable

import { printLoginBanner, readPassword, readUsername, authToken, localUrl, remoteUrl, oneClickUrl, AUTH_USERNAME, PASSWORD_FILE, USERNAME_FILE } from './lib/web-auth.mjs';

const args = process.argv.slice(2);

if (args.includes('--json')) {
  const password = readPassword();
  process.stdout.write(JSON.stringify({
    username: readUsername(),
    password,
    localUrl: localUrl(),
    remoteUrl: remoteUrl(),
    oneClickUrl: oneClickUrl(),
    authToken: authToken(password),
    passwordFile: PASSWORD_FILE,
    usernameFile: USERNAME_FILE,
    defaultUsername: AUTH_USERNAME,
  }, null, 2) + '\n');
} else {
  printLoginBanner({ color: !args.includes('--plain') });
}
