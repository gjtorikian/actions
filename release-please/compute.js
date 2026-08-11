const fs = require('fs');
const { execSync } = require('child_process');

const versionFile = process.env.VERSION_FILEPATH;
const versionType = process.env.VERSION_TYPE;
const repo = process.env.REPO;

const readRe = versionType === 'ruby' ? /VERSION\s*=\s*"([^"]+)"/ : /"version"\s*:\s*"([^"]+)"/;
const writeRe = versionType === 'ruby' ? /(VERSION\s*=\s*)"[^"]+"/ : /("version"\s*:\s*)"[^"]+"/;

const readVersion = () => {
  const m = fs.readFileSync(versionFile, 'utf8').match(readRe);
  if (!m) throw new Error(`No version found in ${versionFile}`);
  return m[1];
};
const writeVersion = (v) => {
  const content = fs.readFileSync(versionFile, 'utf8');
  fs.writeFileSync(versionFile, content.replace(writeRe, `$1"${v}"`));
};

const parse = (v) => v.split('.').map(Number);
const fmt = (a) => a.join('.');
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const setOut = (k, v) => fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);

let lastTag = '';
try { lastTag = execSync('git describe --tags --abbrev=0 2>/dev/null || true', { encoding: 'utf8' }).trim(); } catch {}
const hasLast = !!lastTag;
const lastReleased = hasLast ? parse(lastTag.replace(/^v/, '')) : null;
const current = readVersion();
const currentParsed = parse(current);

// A release for the current (already-bumped) version may be in flight:
// version is ahead of the last tag, but that tag has not been created yet.
if (lastReleased && cmp(currentParsed, lastReleased) > 0) {
  let currentTagged = false;
  try { execSync(`git rev-parse v${current}`, { stdio: 'ignore' }); currentTagged = true; } catch {}
  if (!currentTagged) {
    console.log(`A release for v${current} is pending (last tag ${lastTag}). Skipping release-please PR.`);
    setOut('should_release', 'false');
    setOut('next_version', current);
    process.exit(0);
  }
}

const range = hasLast ? `${lastTag}..HEAD` : '';
const cmd = `git log --no-merges --format='%H%x1f%s%x1f%b%x1e' ${range}`;
let raw = '';
try { raw = execSync(cmd, { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 }); } catch {}

const commits = raw.split('\x1e').map((s) => s.trim()).filter(Boolean).map((rec) => {
  const [hash, subject, body = ''] = rec.split('\x1f');
  return { hash, subject, body };
});

const CONV = /^(?<type>[a-zA-Z]+)(?:\((?<scope>[^)]+)\))?(?<bang>!)?:\s*(?<desc>.*)$/;
let bump = 'none';
const sections = { feat: [], fix: [], perf: [], revert: [], docs: [], misc: [] };
const breaking = [];

const entry = (scope, desc, hash) => {
  const url = `https://github.com/${repo}/commit/${hash}`;
  const prefix = scope ? `**${scope}:** ` : '';
  return `* ${prefix}${desc} ([${hash.slice(0, 7)}](${url}))`;
};

for (const c of commits) {
  const m = c.subject.match(CONV);
  if (!m) continue; // non-conventional commits are ignored, per release-please
  const { type, scope, bang, desc } = m.groups;
  const t = type.toLowerCase();
  const breakingLines = c.body.split('\n').filter((l) => /^breaking change: ?/i.test(l)).map((l) => l.replace(/^breaking change: ?/i, '').trim());
  const isBreaking = bang === '!' || breakingLines.length > 0;
  if (isBreaking) {
    if (bump !== 'major') bump = 'major';
    if (breakingLines.length) breaking.push(...breakingLines); else breaking.push(desc.trim());
  }
  const e = entry(scope, desc.trim(), c.hash);
  switch (t) {
    case 'feat':   if (['patch', 'none'].includes(bump)) bump = 'minor'; sections.feat.push(e); break;
    case 'fix':    if (bump === 'none') bump = 'patch'; sections.fix.push(e); break;
    case 'perf':   if (bump === 'none') bump = 'patch'; sections.perf.push(e); break;
    case 'revert': if (bump === 'none') bump = 'patch'; sections.revert.push(e); break;
    case 'docs':   sections.docs.push(e); break;
    default:       sections.misc.push(e); break;
  }
}

const base = lastReleased || [0, 0, 0];
let nextV = null;
if (bump === 'major') nextV = base[0] === 0 ? [base[0], base[1] + 1, 0] : [base[0] + 1, 0, 0];
else if (bump === 'minor') nextV = [base[0], base[1] + 1, 0];
else if (bump === 'patch') nextV = [base[0], base[1], base[2] + 1];

if (!nextV) {
  console.log(`No release-triggering commits since ${lastTag || 'start'}. Nothing to release.`);
  setOut('should_release', 'false');
  setOut('next_version', current);
  process.exit(0);
}

const nextVersion = fmt(nextV);
writeVersion(nextVersion);

const date = new Date().toISOString().slice(0, 10);
const compare = lastReleased
  ? `https://github.com/${repo}/compare/v${fmt(lastReleased)}...v${nextVersion}`
  : `https://github.com/${repo}/commits/v${nextVersion}`;
const lines = [`## [${nextVersion}](${compare}) (${date})`, ''];
if (breaking.length) {
  lines.push('### ⚠ BREAKING CHANGES', '');
  breaking.forEach((b) => lines.push(`* ${b}`));
  lines.push('');
}
const titles = [['feat', 'Features'], ['fix', 'Bug Fixes'], ['perf', 'Performance Improvements'], ['revert', 'Reverts'], ['docs', 'Documentation'], ['misc', 'Miscellaneous Chores']];
for (const [k, t] of titles) {
  if (sections[k].length) {
    lines.push(`### ${t}`, '');
    sections[k].forEach((e) => lines.push(e));
    lines.push('');
  }
}
const entryText = lines.join('\n') + '\n';
const changelogPath = 'CHANGELOG.md';
const existing = fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, 'utf8') : '';
fs.writeFileSync(changelogPath, entryText + (existing.length ? '\n' + existing : ''));

setOut('should_release', 'true');
setOut('next_version', nextVersion);
console.log(`Computed next release v${nextVersion} (from ${lastReleased ? 'v' + fmt(lastReleased) : 'start'}).`);
