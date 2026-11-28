'use strict';
/* End-to-end check of the fail-closed community store.
   Run with the backend directory as the first argument:
     node community-store-check.cjs /opt/wicked/backend
   It builds a scratch copy of the backend with a corrupt community document,
   proves that reading raises and that nothing is written back, and removes
   the scratch copy. */
const fs = require('fs');
const path = require('path');

const backendDir = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const scratch = path.join(backendDir, '.tmp-store-check');
const dataDir = path.join(scratch, 'data');
const commFile = path.join(dataDir, 'community.json');

fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.join(scratch, 'lib'), { recursive: true });
for (const name of fs.readdirSync(backendDir)) {
  if (name.endsWith('.js') && name !== 'server.js') {
    fs.cpSync(path.join(backendDir, name), path.join(scratch, name));
  }
}
for (const file of fs.readdirSync(path.join(backendDir, 'lib'))) {
  if (file.endsWith('.js')) fs.cpSync(path.join(backendDir, 'lib', file), path.join(scratch, 'lib', file));
}
/* The scratch copy reuses the installed dependencies. */
try { fs.symlinkSync(path.join(backendDir, 'node_modules'), path.join(scratch, 'node_modules'), 'dir'); }
catch { fs.cpSync(path.join(backendDir, 'node_modules'), path.join(scratch, 'node_modules'), { recursive: true }); }

const corrupt = '{ "profiles": { "listener": { "premium": true } }, "premiumRedemptions": ';
fs.writeFileSync(commFile, corrupt);
const before = fs.readFileSync(commFile, 'utf8');

const community = require(path.join(scratch, 'community.js'));

let loadThrew = false;
try {
  community.load();
} catch (error) {
  loadThrew = true;
  console.log('load threw:', error.name, error.status);
}

const saved = community.save({ profiles: {} });
const after = fs.readFileSync(commFile, 'utf8');
console.log('save returned:', saved);
console.log('file unchanged:', before === after);

fs.rmSync(scratch, { recursive: true, force: true });

if (!loadThrew || saved !== false || before !== after) {
  console.error('FAIL: the corrupt community store was not handled fail-closed');
  process.exit(1);
}
console.log('PASS: a corrupt community store raises and is never overwritten');
