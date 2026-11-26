// 真实文档断言审计（修正版：实体解码、准确关键词）
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const sandbox = { console };
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of ['tex-vocab.js', 'tex-renderer.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', 'web', f), 'utf8'), sandbox);
}
const T = sandbox.window.TeXRender;

function expandInputs(file, depth) {
  if (depth > 5) return '';
  const text = fs.readFileSync(file, 'utf8');
  const dir = path.dirname(file);
  return text.replace(/\\(?:input|include|subfile)\s*\{([^}]+)\}/g, (m, rel) => {
    const a = path.join(dir, rel.endsWith('.tex') ? rel : rel + '.tex');
    const b = path.join(dir, rel);
    const p = fs.existsSync(a) ? a : (fs.existsSync(b) ? b : null);
    return p ? expandInputs(p, depth + 1) : '';
  });
}

function decode(s) {
  return String(s)
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ');
}
function textOnly(html) {
  return decode(html
    .replace(/<div class="math[\s\S]*?<\/div>/g, ' ')
    .replace(/<span class="math[\s\S]*?<\/span>/g, ' ')
    .replace(/<pre[\s\S]*?<\/pre>/g, ' ')
    .replace(/<code[\s\S]*?<\/code>/g, ' ')
    .replace(/<[^>]+>/g, ' '));
}

const CASES = [
  {
    name: 'lshort（200 页中文书）',
    file: 'samples/real/09-lshort-zh-cn/lshort-zh-cn.tex',
    minBlocks: 1600, minMath: 600, maxUnknown: 0,
    has: ['LaTeX', '表格', '章节']
  },
  {
    name: 'revtex（论文模板）',
    file: 'samples/real/02-revtex-aps/apssamp.tex',
    minBlocks: 100, minMath: 30, maxUnknown: 0,
    has: ['Manuscript Title']
  },
  {
    name: 'tufte（讲义样式）',
    file: 'samples/real/04-tufte-handout/sample-handout.tex',
    minBlocks: 60, minMath: 3, maxUnknown: 0,
    has: ['Tufte', 'Sidenotes']
  },
  {
    name: 'stress（全样式压力）',
    file: 'samples/stress/all-styles-stress.tex',
    minBlocks: 200, minMath: 80, maxUnknown: 1,
    has: ['压力测试', '标题层级']
  },
  {
    name: '综合论文（语料 25）',
    file: 'samples/corpus/25-paper.tex',
    minBlocks: 15, minMath: 1, maxUnknown: 0,
    has: ['Representative Paper', 'PSNR']
  },
  {
    name: '中文试卷（demo2）',
    file: 'samples/demos/demo2.tex',
    minBlocks: 25, minMath: 20, maxUnknown: 0,
    has: ['概率论', '姓名']
  }
];

let failed = 0;
console.log('=== 真实文档断言 ===');
for (const c of CASES) {
  const file = path.join(ROOT, c.file);
  if (!fs.existsSync(file)) { console.log('  ✗ 缺文件 ' + c.file); failed++; continue; }
  let r;
  try { r = T.render(expandInputs(file, 0), {}); }
  catch (e) { console.log('  ✗ ' + c.name + ' 渲染抛异常: ' + e.message); failed++; continue; }

  const bad = [];
  if (r.stats.blocks < c.minBlocks) bad.push('块数 ' + r.stats.blocks + ' < ' + c.minBlocks);
  if (r.stats.math < c.minMath) bad.push('公式数 ' + r.stats.math + ' < ' + c.minMath);
  if ((r.unknown || []).length > c.maxUnknown) bad.push('未识别宏 ' + (r.unknown || []).join(','));
  const txt = textOnly(r.html);
  (c.has || []).forEach(s => { if (!txt.includes(s)) bad.push('缺文本「' + s + '」'); });

  // 数学里出现 #n（宏定义参数漏出）才算错；先解码实体避免 &#39; 误判
  const badMath = [...r.html.matchAll(/data-tex="([^"]*)"/g)]
    .map(m => decode(m[1]))
    .filter(t => /#[1-9]/.test(t));
  if (badMath.length) bad.push('公式里含 #n: ' + badMath.slice(0, 3).join(' | '));

  if (/<pre class="code"><code><\/code><\/pre>/.test(r.html)) bad.push('存在空代码块');

  if (bad.length) { failed++; console.log('  ✗ ' + c.name + '\n      - ' + bad.join('\n      - ')); }
  else console.log('  ✓ ' + c.name + '（' + r.stats.blocks + ' 块 · ' + r.stats.math + ' 公式）');
}

console.log(failed ? '\n真实文档失败: ' + failed : '\n真实文档全部通过');
process.exit(failed ? 1 : 0);
