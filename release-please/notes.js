const fs = require('fs');
const v = process.env.VERSION;
let notes = '';
try {
  const lines = fs.readFileSync('CHANGELOG.md', 'utf8').split('\n');
  const out = [];
  let cap = false;
  // A version heading is `## [1.5.3](...)` (new format) or
  // `# [v1.5.2] - ...` (legacy format); both start with `#` then `[`.
  const isVersionHeading = (l) => /^#+\s*\[/.test(l);
  for (const line of lines) {
    if (isVersionHeading(line)) {
      if (cap) break;
      if (line.startsWith(`## [${v}]`)) cap = true;
    }
    if (cap) out.push(line);
  }
  notes = out.join('\n').replace(/\n+$/, '');
} catch {}
fs.writeFileSync('release-notes.md', notes);
