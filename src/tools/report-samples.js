#!/usr/bin/env node
/*
 * report-samples.js — 把所有样例过一遍渲染器，生成兼容性/性能报告
 *
 * 用法：node src/tools/report-samples.js [--md samples/report.md]
 *
 * 输出：终端表格 + Markdown 报告
 *   - 每个文件：字节数、块数、公式数、降级条数、渲染耗时
 *   - 解析异常（不该出现）会被显式标记为 ❌
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..', '..');
const samplesDir = path.join(root, 'samples');

/* ---------------- 加载渲染器 ---------------- */
const code = fs.readFileSync(path.join(root, 'src', 'web', 'tex-vocab.js'), 'utf8') +
  '\n' + fs.readFileSync(path.join(root, 'src', 'web', 'tex-renderer.js'), 'utf8');
const sandbox = { console };
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'tex-renderer.js' });
const TeXRender = sandbox.window.TeXRender;
if (!TeXRender) {
  console.error('FATAL: TeXRender 未定义');
  process.exit(1);
}

/* ---------------- 收集样例 ---------------- */
function walk(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.toLowerCase().endsWith('.tex')) out.push(p);
  }
  return out;
}

const files = []
  .concat(walk(path.join(samplesDir, 'stress'), []))
  .concat(walk(path.join(samplesDir, 'real'), []))
  .concat(walk(path.join(samplesDir, 'generated'), []))
  .concat(fs.existsSync(samplesDir)
    ? fs.readdirSync(path.join(samplesDir))
      .filter(f => f.endsWith('.tex'))
      .map(f => path.join(samplesDir, f))
    : [])
  .sort();

if (!files.length) {
  console.error('没找到任何 .tex 样例。');
  process.exit(1);
}

/* ---------------- 逐个渲染 ---------------- */
const rows = [];
let fatal = 0;

for (const file of files) {
  const rel = path.relative(root, file).replace(/\\/g, '/');
  const bytes = fs.statSync(file).size;
  const src = fs.readFileSync(file, 'utf8');

  let result = null;
  let err = null;
  const t0 = process.hrtime.bigint();
  try {
    result = TeXRender.render(src, {});
  } catch (e) {
    err = e;
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  if (err) {
    fatal++;
    rows.push({ rel, bytes, blocks: 0, math: 0, warns: 0, ms, err: err.message, warnList: [] });
    continue;
  }

  const warnings = result.warnings || [];
  const parseError = warnings.find(w => w.indexOf('解析异常') !== -1);
  if (parseError) fatal++;

  rows.push({
    rel,
    bytes,
    blocks: result.stats.blocks,
    math: result.stats.math,
    warns: warnings.length,
    ms,
    err: parseError || null,
    warnList: warnings.slice(0, 3),
  });
}

/* ---------------- 终端表格 ---------------- */
const pad = (s, n) => {
  const w = [...String(s)].reduce((a, c) => a + (c.charCodeAt(0) > 127 ? 2 : 1), 0);
  return String(s) + ' '.repeat(Math.max(0, n - w));
};

console.log(pad('文件', 52) + pad('字节', 9) + pad('块', 6) + pad('公式', 6) + pad('降级', 6) + pad('耗时ms', 9) + '状态');
console.log('-'.repeat(96));
for (const r of rows) {
  console.log(
    pad(r.rel.replace(/^samples\//, ''), 52) +
    pad(r.bytes, 9) + pad(r.blocks, 6) + pad(r.math, 6) + pad(r.warns, 6) +
    pad(r.ms.toFixed(1), 9) +
    (r.err ? '❌ ' + r.err.slice(0, 20) : (r.warns ? '⚠' : '✓'))
  );
}

/* ---------------- Markdown 报告 ---------------- */
const md = [];
md.push('# 样例渲染报告');
md.push('');
md.push(`> 由 \`src/tools/report-samples.js\` 生成于 ${new Date().toLocaleString('zh-CN')}`);
md.push('> 这里只测“解析器”，不含 MathJax 实际排版（那部分在浏览器/WebView2 里）。');
md.push('');
md.push(`- 样例数：**${rows.length}**`);
md.push(`- 解析异常：**${fatal}**${fatal ? '（需要修）' : '（无）'}`);
const totalMs = rows.reduce((a, r) => a + r.ms, 0);
const maxRow = rows.slice().sort((a, b) => b.ms - a.ms)[0];
md.push(`- 解析总耗时：**${totalMs.toFixed(1)} ms**，最慢 **${maxRow.rel}** ${maxRow.ms.toFixed(1)} ms`);
md.push('');
md.push('| 文件 | 字节 | 块 | 公式 | 降级 | 耗时 (ms) | 状态 |');
md.push('| --- | ---: | ---: | ---: | ---: | ---: | --- |');
for (const r of rows) {
  md.push(`| \`${r.rel.replace(/^samples\//, '')}\` | ${r.bytes} | ${r.blocks} | ${r.math} | ${r.warns} | ${r.ms.toFixed(1)} | ${r.err ? '❌' : (r.warns ? '⚠' : '✓')} |`);
}
md.push('');
md.push('## 降级明细（每个文件前 3 条）');
md.push('');
for (const r of rows.filter(x => x.warnList.length)) {
  md.push(`### \`${r.rel.replace(/^samples\//, '')}\``);
  md.push('');
  for (const w of r.warnList) md.push('- ' + w);
  md.push('');
}

const outIdx = process.argv.indexOf('--md');
const outFile = outIdx > -1 ? process.argv[outIdx + 1] : path.join(samplesDir, 'report.md');
fs.writeFileSync(outFile, md.join('\n'), 'utf8');
console.log(`\n报告：${outFile}`);
console.log(fatal ? `\n❌ ${fatal} 个文件有解析异常` : '\n✓ 没有解析异常');
process.exit(fatal ? 1 : 0);
