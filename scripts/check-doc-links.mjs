// Read-only Markdown file-link checks; run from any working directory.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const all = process.argv.includes('--all');
const excluded = new Set(['node_modules', '.git', 'backups', 'dist', 'build', 'coverage', 'logs']);
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (entry.isSymbolicLink() || entry.name.startsWith('.') || excluded.has(entry.name)) return [];
    const full = path.join(dir, entry.name);
    if (!all && full === path.join(root, 'docs', 'archive')) return [];
    return entry.isDirectory() ? walk(full) : entry.name.endsWith('.md') ? [full] : [];
  });
}
const files = walk(root);
const failures = [];
let count = 0;
for (const file of files) {
  if (!fs.existsSync(file)) { failures.push(`Missing document: ${path.relative(root, file)}`); continue; }
  let fenced = false;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced || /^ {4}/.test(line)) continue;
    for (const match of line.matchAll(/!?\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\)/g)) {
      const target = match[1].replace(/^<|>$/g, '');
      if (/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(target)) continue;
      let local;
      try { local = decodeURIComponent(target.split(/[?#]/)[0]); }
      catch { failures.push(`${path.relative(root, file)}:${i + 1}: malformed URL`); continue; }
      if (!local) continue;
      count++;
      if (!fs.existsSync(path.resolve(path.dirname(file), local))) {
        failures.push(`${path.relative(root, file)}:${i + 1}: ${target}`);
      }
    }
  }
}
console.log(`${all ? 'All Markdown' : 'Current Markdown'}: ${files.length} files, ${count} local links, ${failures.length} broken`);
if (failures.length) console.error(failures.join('\n'));
console.log('Scope: inline relative file links; excludes external URLs, anchors, bare paths and code blocks.');
process.exitCode = failures.length ? 1 : 0;
