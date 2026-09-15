const fs = require('fs');
const { execSync } = require('child_process');

const versionFile = process.env.VERSION_FILEPATH;
const versionType = process.env.VERSION_TYPE;
const repo = process.env.REPO;

const readRe = versionType === 'ruby' ? /VERSION\s*=\s*"([^"]+)"/ : /"version"\s*:\s*"([^"]+)"/;
const writeRe = versionType === 'ruby' ? /(VERSION\s*=\s*)"[^"]+"/ : /("version"\s*:\s*)"[^"]+"/;

// Cargo.toml carries a `version =` line for every dependency table, so a flat
// regex (or `grep -m1 '^version'`) picks up whichever comes first and breaks
// the day a `[dependencies.foo]` section appears above `[package]`. Scope
// every read and write to the `[package]` section. Line-based rather than one
// regex so the section boundary is unambiguous: it ends at the next `[...]`
// header or EOF. Workspace-inherited versions (`version.workspace = true`)
// are not supported and fail loudly — there is no literal to bump.
const cargoPackage = (text) => {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^\[package\]\s*$/.test(l));
  if (start < 0) throw new Error(`No [package] section in ${versionFile}`);
  let end = lines.findIndex((l, i) => i > start && /^\s*\[/.test(l));
  if (end < 0) end = lines.length;
  return { lines, start, end };
};
const cargoField = (key) => {
  const { lines, start, end } = cargoPackage(fs.readFileSync(versionFile, 'utf8'));
  const re = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`);
  for (let i = start + 1; i < end; i++) {
    const m = lines[i].match(re);
    if (m) return m[1];
  }
  throw new Error(`No ${key} = "..." in [package] of ${versionFile}`);
};
const writeCargoVersion = (v) => {
  const { lines, start, end } = cargoPackage(fs.readFileSync(versionFile, 'utf8'));
  for (let i = start + 1; i < end; i++) {
    if (/^\s*version\s*=\s*"[^"]+"/.test(lines[i])) {
      lines[i] = lines[i].replace(/(version\s*=\s*)"[^"]+"/, `$1"${v}"`);
      fs.writeFileSync(versionFile, lines.join('\n'));
      return;
    }
  }
  throw new Error(`No version = "..." in [package] of ${versionFile}`);
};

const readVersion = () => {
  if (versionType === 'rust') return cargoField('version');
  const m = fs.readFileSync(versionFile, 'utf8').match(readRe);
  if (!m) throw new Error(`No version found in ${versionFile}`);
  return m[1];
};
const writeVersion = (v) => {
  if (versionType === 'rust') return writeCargoVersion(v);
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
    console.log(`A release for v${current} is pending (last tag ${lastTag}). Skipping release-please PR; signaling release.`);
    setOut('should_release', 'false');
    setOut('pending_release', 'true');
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

// Find the PR that introduced a commit so the changelog can link to it.
// Squash merges carry the PR number in the subject ("feat: thing (#12)");
// merge/rebase merges need a GitHub API lookup. Returns null if none found.
const prForCommit = (hash) => {
  try {
    const out = execSync(`gh api "repos/${repo}/commits/${hash}/pulls" --jq '.[0].number'`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (/^\d+$/.test(out)) return out;
  } catch {}
  return null;
};

const entry = (scope, desc, hash) => {
  const prefix = scope ? `**${scope}:** ` : '';
  const squash = desc.match(/^(.*)\s+\(#(\d+)\)$/);
  const pr = squash ? squash[2] : prForCommit(hash);
  if (squash) desc = squash[1];
  if (pr) return `* ${prefix}${desc} ([#${pr}](https://github.com/${repo}/pull/${pr}))`;
  return `* ${prefix}${desc} ([${hash.slice(0, 7)}](https://github.com/${repo}/commit/${hash}))`;
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

// `cargo publish --locked` refuses a Cargo.lock whose entry for this crate
// still carries the previous version, so the release PR must bump both files.
// `-p <crate>` is what keeps every dependency pinned: it re-locks only the
// named package (cargo reports "N unchanged dependencies"). Do NOT add
// `--offline`: cargo still needs the registry index to re-resolve the graph,
// and a fresh CI runner has none cached, so it fails with "no matching
// package named <dep> found — location searched: crates.io index". That
// passed locally only because of a warm ~/.cargo/registry.
if (versionType === 'rust') {
  const crate = cargoField('name');
  if (!/^[A-Za-z0-9_-]+$/.test(crate)) throw new Error(`Unexpected crate name: ${crate}`);
  execSync(`cargo update -p ${crate}`, { stdio: 'inherit' });
}

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
