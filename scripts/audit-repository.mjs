// 只读盘点：不读取凭据、数据库、依赖、备份或同步临时目录。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const excluded = new Set(['.git', 'node_modules', 'backups', '.sync_temp_dir', '.wrangler',
  '.workbuddy', '.learnings', 'dist', 'build', 'coverage', 'logs', '.vite']);
const files = [];
const skipped = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const relative = path.relative(root, full).replaceAll('\\', '/');
    if (entry.isSymbolicLink() || excluded.has(entry.name) || entry.name.startsWith('.validation-')) {
      skipped.push(relative); continue;
    }
    if (entry.isDirectory()) { walk(full); continue; }
    if (/^(?:\.env|\.dev\.vars)/.test(entry.name) || /\.(?:sqlite(?:-shm|-wal)?|db|pem|key|p12)$/.test(entry.name)) {
      skipped.push(relative); continue;
    }
    const stat = fs.statSync(full);
    const source = /^(?:frontend\/src|backend\/src|miniprogram\/(?:pages|packages|features))\//.test(relative)
      && /\.(?:tsx?|jsx?|css|wxss|wxml)$/.test(relative) && !relative.includes('/generated/');
    files.push({ path: relative, bytes: stat.size,
      ...(source ? { lines: fs.readFileSync(full, 'utf8').split(/\r?\n/).length } : {}) });
  }
}
walk(root);
const groups = {};
for (const file of files) {
  const group = file.path.includes('/') ? file.path.split('/')[0] : '(root)';
  groups[group] ??= { files: 0, bytes: 0 };
  groups[group].files++;
  groups[group].bytes += file.bytes;
}
const entrypoints = ['README.md', 'AGENTS.md', 'docs/STATUS.md', 'docs/NEXT-SESSION-PROMPT.md'];
const reading = entrypoints.map(file => {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  return { path: file, characters: text.length, lines: text.split(/\r?\n/).length };
});
const categories = {
  production: /^(?:frontend\/src|backend\/src|miniprogram\/(?:pages|packages|features|components|services|custom-tab-bar))\//,
  tests: /(?:\/tests?\/|\.test\.[cm]?[jt]sx?$)/,
  generated: /\/generated\//,
  migrations: /^backend\/migrations\//,
  design: /^docs\/design\//,
  evidence: /^docs\/verification\//,
  archive: /^docs\/archive\//,
};
const classifiedFiles = files.map(file => ({ ...file, category:
  Object.entries(categories).filter(([name]) => name !== 'production').find(([, pattern]) => pattern.test(file.path))?.[0]
    ?? (categories.production.test(file.path) ? 'production' : 'support') }));
const report = { groups, reading, files: classifiedFiles,
  backupCandidates: files.filter(f => /(?:\.bak(?:-|$)|\.old$|\.orig$|~$)/.test(f.path)).map(f => f.path),
  largeSources: files.filter(f => f.lines > 600).sort((a, b) => b.lines - a.lines),
  skipped, note: '行数仅用于定位维护热点，不代表无用代码；未执行删除，未扫描凭据和业务数据。' };
if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
else {
  console.log('目录盘点（文件数 / 字节）');
  for (const [name, value] of Object.entries(groups)) console.log(`${name}: ${value.files} / ${value.bytes}`);
  console.log('\n默认阅读入口（字符 / 行）');
  for (const file of reading) console.log(`${file.path}: ${file.characters} / ${file.lines}`);
  console.log('\n超过 600 行的源码（前 15 项）');
  for (const file of report.largeSources.slice(0, 15)) console.log(`${file.lines} ${file.path}`);
  console.log(`\n跳过 ${skipped.length} 个数据/依赖/生成目录或文件。${report.note}`);
}
