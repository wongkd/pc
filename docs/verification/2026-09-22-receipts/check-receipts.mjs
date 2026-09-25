import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] || 'docs/verification/progress';
const allowed = ['working', 'blocked', 'review', 'verified'];
const extOk = /\.(md|json|ts|tsx|css|mjs|cjs|sql)$/;
const prefixOk = ['backend/', 'frontend/', 'miniprogram/', 'contracts/', 'docs/'];

const files = fs.readdirSync(dir).filter((x) => x.endsWith('.json'));
console.log('回执数量: ' + files.length + ' -> ' + files.join(', '));

for (const f of files) {
  const p = path.join(dir, f);
  let j;
  try {
    j = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.log('\n===== ' + f + ' =====\n  [BAD-JSON] ' + e.message);
    continue;
  }
  console.log('\n===== ' + f + ' =====');
  console.log('  id=' + j.id + '  status=' + j.status + '  updatedAt=' + j.updatedAt);
  if (!allowed.includes(j.status)) console.log('  !! status 非法');
  if (String(j.id) + '.json' !== f) console.log('  !! id 与文件名不一致');
  ['id', 'status', 'summary', 'next', 'updatedAt', 'evidence'].forEach((k) => {
    if (!(k in j)) console.log('  !! 缺字段 ' + k);
  });
  const upd = new Date(j.updatedAt).getTime();
  if (Number.isNaN(upd)) console.log('  !! updatedAt 无法解析');
  let missing = 0;
  let stale = 0;
  let badPath = 0;
  for (const e of j.evidence || []) {
    if (e.startsWith('docs/verification/progress')) {
      console.log('  !! evidence 含回执自身: ' + e);
      continue;
    }
    if (!prefixOk.some((pfx) => e.startsWith(pfx)) || !extOk.test(e)) {
      console.log('  !! 路径不合规: ' + e);
      badPath++;
      continue;
    }
    if (!fs.existsSync(e)) {
      console.log('  !! 不存在: ' + e);
      missing++;
      continue;
    }
    const mt = fs.statSync(e).mtime.getTime();
    if (mt > upd) {
      const d = new Date(mt);
      console.log('  ~~ 待复核(mtime>updatedAt): ' + e + '   ' + d.toISOString());
      stale++;
    }
  }
  if (j.status === 'verified') {
    const hasSrc = (j.evidence || []).some((e) => /^(backend|frontend|miniprogram)\//.test(e));
    const hasDoc = (j.evidence || []).some((e) => /^docs\/verification\/.+\.md$/.test(e));
    if (!hasSrc) console.log('  !! verified 缺源码路径');
    if (!hasDoc) console.log('  !! verified 缺 docs/verification/*.md 验证记录');
  }
  console.log('  -> 缺失 ' + missing + ' / 待复核 ' + stale + ' / 路径不合规 ' + badPath);
}
