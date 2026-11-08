const fs = require('fs'), crypto = require('crypto'), path = require('path');
const pkg = JSON.parse(fs.readFileSync(__dirname + '/package.json', 'utf8'));
const dir = __dirname + '/dist';
const file = `Wicked Player Setup ${pkg.version}.exe`;
if (!fs.existsSync(dir + '/' + file)) { console.error('NOT FOUND: ' + file); process.exit(1); }
const buf = fs.readFileSync(dir + '/' + file);
const sha512 = crypto.createHash('sha512').update(buf).digest('base64');
const yml = `version: ${pkg.version}\nfiles:\n  - url: ${file}\n    sha512: ${sha512}\n    size: ${buf.length}\npath: ${file}\nsha512: ${sha512}\nreleaseDate: '${new Date().toISOString()}'\n`;
fs.writeFileSync(dir + '/latest.yml', yml);
console.log('latest.yml written for v' + pkg.version);
