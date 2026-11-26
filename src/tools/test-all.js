// 一键自动化测试：单元测试 + 语料断言 + 真实文档断言
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const steps = [
  ['单元测试（渲染器断言）', 'src/tools/test-render.js', 'node'],
  ['语料断言（27 份构造样本）', 'src/tools/corpus-audit.js', 'node'],
  ['真实文档断言（长文档/模板）', 'src/tools/real-samples-audit.js', 'node'],
  ['样例报告（35 份，仅检查解析异常）', 'src/tools/report-samples.js', 'node'],
  ['语义核对（TeX 编译的 .toc/.aux/log 为基准，零外部依赖）', 'src/tools/oracle-audit.js', 'node']
];

let failed = 0;
for (const [name, script, runner] of steps) {
  console.log('\n==== ' + name + ' ====');
  const args = runner === 'pwsh'
    ? ['-NoProfile', '-File', path.join(ROOT, script)]
    : [path.join(ROOT, script)];
  const exe = runner === 'pwsh' ? 'pwsh' : process.execPath;
  const r = spawnSync(exe, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  console.log(out.length > 4000 ? out.slice(-4000) : out);
  if (r.status !== 0) { failed++; console.log('  → 失败（exit ' + r.status + '）'); }
}

console.log('\n========================================');
console.log(failed ? '自动化测试失败项: ' + failed + ' / ' + steps.length : '自动化测试全部通过（' + steps.length + ' 项）');
process.exit(failed ? 1 : 0);
