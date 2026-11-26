// 语料断言审计：每份 corpus 文档声明“应出现/不应出现/结构不变量”，逐条判定
// 用法: node src/tools/corpus-audit.js [--verbose]
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const CORPUS = path.join(ROOT, 'samples', 'corpus');
const verbose = process.argv.includes('--verbose');

const sandbox = { console };
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of ['tex-vocab.js', 'tex-renderer.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', 'web', f), 'utf8'), sandbox);
}
const T = sandbox.window.TeXRender;

function expandInputs(file, depth) {
  if (depth > 4) return '';
  const text = fs.readFileSync(file, 'utf8');
  const dir = path.dirname(file);
  return text.replace(/\\(?:input|include|subfile)\s*\{([^}]+)\}/g, (m, rel) => {
    const a = path.join(dir, rel.endsWith('.tex') ? rel : rel + '.tex');
    const b = path.join(dir, rel);
    const p = fs.existsSync(a) ? a : (fs.existsSync(b) ? b : null);
    return p ? expandInputs(p, depth + 1) : '';
  });
}

function plain(html) {
  return html
    .replace(/<div class="math[\s\S]*?<\/div>/g, ' ')
    .replace(/<span class="math[\s\S]*?<\/span>/g, ' ')
    .replace(/<pre[\s\S]*?<\/pre>/g, ' ')
    .replace(/<code[\s\S]*?<\/code>/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');
}
function tableRowCounts(html) {
  return [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(m => (m[1].match(/<t[dh][ >]/g) || []).length);
}
function count(html, re) { return (html.match(re) || []).length; }

/* ---------------- 断言表 ---------------- */
const C = {
  '01-structure.tex': {
    has: ['结构测试', '摘要测试', '不编号节', '附录章', '段落标题'],
    minHeadings: 6,
    hasClass: ['h1', 'h2'],
    noLeak: true
  },
  '02-lists.tex': {
    has: ['一级', '二级 1', '三级描述', '自定义编号', '第二项'],
    minTags: { ul: 1, ol: 1, dl: 1 },
    noLeak: true
  },
  '03-table-basic.tex': {
    has: ['名称', '数值', '第一行', '第二行', '合并行'],
    minTags: { table: 1, th: 3 },
    colspan: 3,
    rowsEqual: true,
    noLeak: true
  },
  '04-table-complex.tex': {
    has: ['左', '自动宽度的一段较长文字', 'A', '3'],
    minTags: { table: 3 },
    rowsEqual: true,
    noLeak: true
  },
  '05-math-inline.tex': {
    minMath: 8,
    mathHas: ['sqrt[3]', 'operatorname', 'mathbb', 'binom', 'frac'],
    noBareDollar: true,
    noLeak: true
  },
  '06-math-display.tex': {
    minMath: 8,
    mathHas: ['cases', 'pmatrix', 'align', 'gather', 'multline'],
    minTags: { 'div class="math math-display"': 6 },
    noLeak: true
  },
  '07-math-custom.tex': {
    minMath: 6,
    mathHas: ['argmin', 'pair', 'half', '4/2'],
    noLeak: true
  },
  '08-floats.tex': {
    has: ['示例图', '示例表', '组图', '左', '右'],
    minTags: { figure: 1, img: 1, figcaption: 2 },
    noLeak: true
  },
  '09-refs-cites.tex': {
    has: ['Knuth', 'Lamport'],
    minTags: { 'class="cite': 2 },
    hasAny: ['[1]', '[2]'],
    noLeak: true
  },
  '10-notes.tex': {
    has: ['脚注内容', '悬空脚注', '页边注', '更多页边注', '致谢内容'],
    minTags: { 'class="fnref': 1, 'class="sidenote': 3 },
    noLeak: true
  },
  '11-colors-boxes.tex': {
    has: ['红字', '底色', '框底色', '标题', '框内文字', '边框段', '简单框', '定宽段落', '小页内容'],
    hasStyle: ['color:'],
    noLeak: true
  },
  '12-code.tex': {
    htmlHas: ['a_b$c', 'code_text', 'unbalanced', 'def f(x)', 'int main'],
    minTags: { pre: 3 },
    noLeak: true
  },
  '13-beamer.tex': {
    has: ['标题一', '第一点', '第二点', '强调', '块标题', '块内容', '左栏', '右栏'],
    noLeak: true
  },
  '14-ctex.tex': {
    has: ['中文标题', '黑体', '宋体', '楷体', '加粗中文', '强调中文', '“”'],
    noLeak: true
  },
  '15-theorems.tex': {
    has: ['Theorem', 'Lemma', 'Example', '显然', '伴随结论'],
    minTags: { 'class="thmbox': 4 },
    noLeak: true
  },
  '16-algorithms.tex': {
    htmlHas: ['排序', 'input', '处理', '结果'],
    noLeak: true
  },
  '17-tikz.tex': {
    minTags: { 'class="tex-hold': 3 },
    noSource: true,
    noLeak: true
  },
  '18-hyperlinks.tex': {
    has: ['example.com', '示例', '写信'],
    minTags: { a: 3 },
    noLeak: true
  },
  '19-text-format.tex': {
    has: ['强调', '加粗', '小型大写', '下划线', '删除线', 'abc', '引号'],
    minTags: { em: 1, strong: 1, u: 1, del: 1 },
    noLeak: true
  },
  '20-spacing.tex': {
    has: ['顶格段', '居中', '左', '右'],
    hasClass: ['env-center', 'env-flushleft', 'env-flushright'],
    noLeak: true
  },
  '21-counters.tex': {
    has: ['计数器'],
    hasAny: ['7', 'vii'],
    noLeak: true
  },
  '22-macros.tex': {
    has: ['Hello', '1+2', '默认', 'A/值', 'a,b,c', '内容', '内容2', 'Hi you', 'robust', '条件为真'],
    noLeak: true
  },
  '23-special-chars.tex': {
    has: ['#', '$', '%', '&', '_', '{', '}', '–', '—', '…', 'é', 'ö', 'ç', '30', '©', 'LaTeX'],
    noLeak: true
  },
  '24-malformed.tex': {
    has: ['待保留的内容', '未知环境内容'],
    noLeak: false
  },
  '25-paper.tex': {
    has: ['Representative Paper', 'Introduction', 'unique', 'Standard', 'Results', 'PSNR', 'A paper'],
    minHeadings: 1,
    rowsEqual: true,
    noLeak: true
  },
  '26-cv.tex': {
    has: ['张三', '教育', '经历', '2019', '2023', '负责后端开发'],
    minTags: { table: 1 },
    noLeak: true
  },
  '27-input/main.tex': {
    has: ['简介', '从子文件引入的简介', '正文'],
    noLeak: true
  }
};

/* ---------------- 判定 ---------------- */
function walk(dir, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith('.tex')) acc.push(p);
  }
  return acc;
}

const files = walk(CORPUS, []).sort();
let failed = 0, checked = 0;
const failures = [];

for (const f of files) {
  const rel = path.relative(CORPUS, f).replace(/\\/g, '/');
  const spec = C[rel];
  if (!spec) { console.log('  (无语料断言) ' + rel); continue; }

  let r;
  try { r = T.render(expandInputs(f, 0), {}); }
  catch (e) { failures.push(rel + ' → 渲染抛异常: ' + e.message); failed++; continue; }

  const html = r.html;
  const txt = plain(html);
  const bad = [];

  (spec.has || []).forEach(s => { if (!txt.includes(s)) bad.push('缺少文本「' + s + '」'); });
  (spec.hasAny || []).forEach(s => { if (!txt.includes(s)) bad.push('缺少任一文本「' + s + '」'); });
  (spec.mathHas || []).forEach(s => { if (!html.includes(s)) bad.push('公式缺少「' + s + '」'); });
  (spec.htmlHas || []).forEach(s => { if (!html.includes(s)) bad.push('HTML 缺少「' + s + '」'); });
  (spec.hasClass || []).forEach(s => { if (!html.includes(s)) bad.push('缺少 class「' + s + '」'); });
  (spec.hasStyle || []).forEach(s => { if (!html.includes(s)) bad.push('缺少样式「' + s + '」'); });
  if (spec.minMath && r.stats.math < spec.minMath) bad.push('公式数 ' + r.stats.math + ' < ' + spec.minMath);
  if (spec.minHeadings && r.headings.length < spec.minHeadings) bad.push('标题数 ' + r.headings.length + ' < ' + spec.minHeadings);
  for (const [tag, n] of Object.entries(spec.minTags || {})) {
    let got;
    if (tag.includes('class=') || tag.includes(' ')) {
      got = html.split(tag).length - 1;
    } else {
      got = count(html, new RegExp('<' + tag + '[ >]', 'g'));
    }
    if (got < n) bad.push(tag + ' 数 ' + got + ' < ' + n);
  }
  if (spec.colspan) {
    const m = new RegExp('colspan="' + spec.colspan + '"').test(html);
    if (!m) bad.push('缺少 colspan=' + spec.colspan);
  }
  if (spec.rowsEqual) {
    const rows = tableRowCounts(html);
    if (rows.length && Math.min(...rows) !== Math.max(...rows)) bad.push('表格行错位 ' + Math.min(...rows) + '/' + Math.max(...rows));
  }
  if (spec.noBareDollar && /\$/.test(txt)) bad.push('正文残留裸 $');
  if (spec.noLeak) {
    const leaks = (txt.match(/\\[A-Za-z@]{2,}/g) || []).slice(0, 5);
    if (leaks.length) bad.push('命令泄漏: ' + leaks.join(' '));
  }
  if (spec.noSource && /展开看源码|<pre[\s\S]*class="code"/.test(html)) bad.push('仍显示源码');

  checked++;
  if (bad.length) {
    failed++;
    failures.push(rel + '\n    - ' + bad.join('\n    - '));
  } else if (verbose) {
    console.log('  ok  ' + rel);
  }
}

console.log('\n=== 语料断言结果 ===');
if (!failures.length) console.log('  全部通过（' + checked + ' 份）');
else {
  failures.forEach(x => console.log('  ✗ ' + x));
  console.log('\n  失败 ' + failed + ' / ' + checked);
}
process.exit(failed ? 1 : 0);
