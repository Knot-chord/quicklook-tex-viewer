#!/usr/bin/env node
/*
 * test-render.js — 渲染器单元回归（无需浏览器）
 *
 * 把 src/web/tex-renderer.js 放进一个最小 window 沙箱里，用 samples/ 下的
 * 真实 .tex 跑一遍，断言结构产物。MathJax 排版不在这里验证（那需要浏览器）。
 *
 * 用法：node src/tools/test-render.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..', '..');
const rendererPath = path.join(root, 'src', 'web', 'tex-renderer.js');
const samplesDir = path.join(root, 'samples');

const vocabPath = path.join(root, 'src', 'web', 'tex-vocab.js');
const code = fs.readFileSync(vocabPath, 'utf8') + "\n" + fs.readFileSync(rendererPath, 'utf8');
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

let failed = 0;
let passed = 0;

function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log('  ✓ ' + name);
  } else {
    failed++;
    console.log('  ✗ ' + name + (extra ? '  →  ' + extra : ''));
  }
}

function count(hay, needle) {
  let n = 0;
  let i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

function run(name) {
  const tex = fs.readFileSync(path.join(samplesDir, name + '.tex'), 'utf8');
  const t0 = Date.now();
  const r = TeXRender.render(tex, {});
  const ms = Date.now() - t0;
  console.log(`\n[${name}.tex] ${ms} ms · ${r.stats.blocks} 块 · ${r.stats.math} 公式 · ${r.warnings.length} 降级`);
  return { r, ms };
}

/* ---------------------------------------------------------------- */
/* article-math：完整文档                                            */
/* ---------------------------------------------------------------- */
{
  const { r, ms } = run('misc/article-math');

  check('无解析异常', !r.warnings.some(w => w.indexOf('解析异常') !== -1),
    r.warnings.join(' | '));
  check('渲染耗时 < 400ms', ms < 400, ms + 'ms');
  check('标题块存在', r.html.indexOf('doc-title') !== -1);
  check('标题/作者正确', r.meta.title.indexOf('快速预览用示例文档') === 0 &&
    r.meta.author.indexOf('张三') === 0, JSON.stringify(r.meta));
  check('10 个标题', r.headings.length === 10, r.headings.length);
  check('章节编号 2.1 存在', r.headings.some(h => h.number === '2.1'));
  check('公式 ≥ 15 个', r.stats.math >= 15, r.stats.math);
  const noAttr = r.html.replace(/data-tex="[^"]*"/g, '');
  check('display math 用 \\[ \\] 包裹（不再套 equation 环境）',
    noAttr.indexOf('\\[') !== -1 && noAttr.indexOf('\\begin{equation}') === -1);

  const rows = (r.html.match(/<tr>/g) || []).length;
  check('表格 4 行（表头 + 3 数据行）', rows === 4, rows);
  check('列格式 {lcc} 未泄漏', r.html.indexOf('{lcc}') === -1);
  check('浮动体位置参数 [htbp] 未泄漏', r.html.indexOf('[htbp]') === -1);
  check('tabular 有 thead', r.html.indexOf('<thead>') !== -1);
    check('表标题编号（英文文档 → Table 1）', r.html.indexOf('Table 1') !== -1);
    check('图标题编号（英文文档 → Figure 1）', r.html.indexOf('Figure 1') !== -1);
  check('PDF 图形渲染为 <img data-pdf>（宿主内联 PNG，失败由页面降级）',
    r.html.indexOf('data-pdf="1"') !== -1);
  check('\\eqref 解析成 (1)', r.html.indexOf('>(1)<') !== -1 || r.html.indexOf('>(1)</span>') !== -1);
  check('\\ref 无未解析键', r.html.indexOf('未找到引用键') === -1);
  check('脚注编号为 1.', r.html.indexOf('>1.</span>') !== -1);
  check('verbatim 保留百分号注释', r.html.indexOf('% 注释不会被当成注释') !== -1);
  check('定理块 2 个', count(r.html, 'class="thmbox') === 2, count(r.html, 'class="thmbox'));
  check('描述列表渲染为 dl', r.html.indexOf('<dl class="desc">') !== -1);
  check('嵌套列表存在', count(r.html, '<ul class="list">') >= 2);
  // 数学区里的 \begin{...} 是故意保留给 MathJax 的，只检查数学区以外
  // 数学元素现在带 data-tex 属性，正则要允许 class 之后的额外属性
  const noMath = r.html.replace(/<(div|span) class="math[^"]*"[^>]*>[\s\S]*?<\/\1>/g, '');
  check('数学区以外无残留 \\begin{', noMath.indexOf('\\begin{') === -1);
}

/* ---------------------------------------------------------------- */
/* fragment：无导言区片段                                            */
/* ---------------------------------------------------------------- */
{
  const { r } = run('misc/fragment');
  check('无解析异常', !r.warnings.some(w => w.indexOf('解析异常') !== -1), r.warnings.join(' | '));
  check('标题 1 个', r.headings.length === 1, r.headings.length);
  check('公式 ≥ 2', r.stats.math >= 2, r.stats.math);
  check('列表存在', r.html.indexOf('<ul class="list">') !== -1);
  check('正文非空', r.stats.blocks >= 3, r.stats.blocks);
}

/* ---------------------------------------------------------------- */
/* torture：坏输入                                                    */
/* ---------------------------------------------------------------- */
{
  const { r } = run('misc/torture');
  check('无解析异常', !r.warnings.some(w => w.indexOf('解析异常') !== -1), r.warnings.join(' | '));
  check('6 个标题且首个为无编号 section*', r.headings.length === 6 && r.headings[0].number === '', r.headings.length + ':' + JSON.stringify(r.headings[0]));
  check('未知环境被降级保留', r.html.indexOf('env-unknownenvironment') !== -1);
  check('未闭合数学不吞掉后文', r.html.indexOf('未知环境') !== -1);
  check('尖括号被转义', r.html.indexOf('<尖括号>') === -1 && r.html.indexOf('&lt;尖括号&gt;') !== -1);
  check('& 被转义', r.html.indexOf('& 符号') === -1 || r.html.indexOf('&amp; 符号') !== -1);
  check('multicolumn colspan=2', r.html.indexOf('colspan="2"') !== -1);
  check('嵌套有序列表', count(r.html, '<ol class="list">') >= 2, count(r.html, '<ol class="list">'));
  check('输出非空', r.html.length > 500, r.html.length);
}

/* ---------------------------------------------------------------- */
/* 极端输入                                                          */
/* ---------------------------------------------------------------- */
{
  const cases = {
    '空字符串': '',
    '只有注释': '% nothing\n% here',
    '未闭合花括号': '\\textbf{abc',
    '未闭合环境': '\\begin{itemize}\n\\item x',
    '超深嵌套': '\\begin{itemize}\n' + '\\item a\n'.repeat(200) + '\\end{itemize}',
    '巨大单行': 'x'.repeat(200000),
    '只有数学': '$$a=b$$',
    '反斜杠风暴': '\\\\'.repeat(500)
  };
  for (const [name, src] of Object.entries(cases)) {
    let ok = true;
    let err = '';
    const t0 = Date.now();
    try {
      const r = TeXRender.render(src, {});
      if (typeof r.html !== 'string') throw new Error('html 不是字符串');
    } catch (e) {
      ok = false;
      err = e.message;
    }
    const ms = Date.now() - t0;
    check('极端输入不崩溃：' + name + `（${ms}ms）`, ok && ms < 2000, err);
  }
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
