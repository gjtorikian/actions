const fs = require('fs');
const v = process.env.VERSION;
let notes = '';
try {
  const lines = fs.readFileSync('CHANGELOG.md', 'utf8').split('\n');
  const out = [];
  let cap = false;
  for (const line of lines) {
    if (line.startsWith('## [')) {
      if (cap) break;
      if (line.startsWith(`## [${v}]`)) cap = true;
    }
    if (cap) out.push(line);
  }
  notes = out.join('\n').replace(/\n+$/, '');
} catch {}
fs.writeFileSync('release-notes.md', notes);
