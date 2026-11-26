// 零依赖对照基准：用 TeX 编译产物（.toc/.aux/.log + PDF 页数）核对渲染结果
// 不再依赖 Python/外部工具；PDF 仅作编译产物与页数参照
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const TEXBIN = 'C:\\texlive\\2026\\bin\\windows';
const KEEPDIR = path.join(ROOT, '.build', 'pdf-oracle');

const sb = { console }; sb.window = sb; sb.globalThis = sb;
vm.createContext(sb);
for (const f of ['tex-vocab.js', 'tex-renderer.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', 'web', f), 'utf8'), sb);
}
const T = sb.window.TeXRender;

/* ---------- 工具 ---------- */
const strip = (s) => String(s || '').replace(/\\[A-Za-z@]+\*?(\[[^\]]*\])?(\{[^{}]*\})?/g, ' ').replace(/\d+(?:\.\d+)?(?:em|ex|pt|cm|mm|in)\b/g, ' ')
  .replace(/[{}]/g, ' ').replace(/\\/g, ' ').replace(/\s+/g, ' ').trim();
const norm = (s) => strip(s).toLowerCase().replace(/[\s'’\-]+/g, '');

function walk(dir, acc) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith('.tex')) acc.push(p);
  }
  return acc;
}
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (['.git', 'obj', 'bin', 'vendor'].includes(e.name)) continue;
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}
function pickEngine(src) {
  if (/\\(documentclass|usepackage)(\[[^\]]*\])?\s*\{[^}]*(ctex|xeCJK|fontspec|unicode-math)/.test(src)) return 'xelatex';
  if (/\\(xymatrix|begin\{xy\})/.test(src)) return 'xelatex';
  return 'pdflatex';
}

/* ---------- TeX 事实 ---------- */
function readGroup(s, i) {
  if (s[i] !== '{') return null;
  let d = 0;
  for (let k = i; k < s.length; k++) {
    if (s[k] === '\\\\') { k++; continue; }
    if (s[k] === '{') d++;
    else if (s[k] === '}') { d--; if (!d) return { text: s.slice(i + 1, k), end: k + 1 }; }
  }
  return null;
}

function readTexFacts(work) {
  const aux = fs.existsSync(path.join(work, 'input.aux')) ? fs.readFileSync(path.join(work, 'input.aux'), 'utf8') : '';
  const toc = fs.existsSync(path.join(work, 'input.toc')) ? fs.readFileSync(path.join(work, 'input.toc'), 'utf8') : '';
  const log = fs.existsSync(path.join(work, 'input.log')) ? fs.readFileSync(path.join(work, 'input.log'), 'utf8') : '';
  const f = { labels: {}, bib: {}, bibYear: {}, toc: [], pages: 0, undefRefs: [], undefCites: [] };

  for (const m of aux.matchAll(/\\newlabel\{([^}]+)\}\{\{([^}]*)\}/g)) f.labels[m[1].trim()] = m[2].trim();
  for (const m of aux.matchAll(/\\bibcite\{([^}]+)\}\{([\s\S]*?)\}(?=\s|\\|$)/g)) {
  for (const m of aux.matchAll(/\\bibcite\{([^}]+)\}\{\{?\d+\}?\{(\d{4})\}/g)) f.bibYear[m[1].trim()] = m[2];
    let v = m[2].trim().replace(/^\{+/, '').replace(/\}+$/, '');
    v = v.split('}')[0].replace(/^\{+/, '').trim();
    f.bib[m[1].trim()] = v;
  }
  for (const m of toc.matchAll(/\\contentsline\s*\{(part|chapter|section|subsection|subsubsection|paragraph)\}/g)) {
    const g = readGroup(toc, m.index + m[0].length);
    if (!g) continue;
    let body = g.text, number = '';
    const nl = /^\\numberline\s*\{([^}]*)\}/.exec(body);
    if (nl) { number = nl[1].trim(); body = body.slice(nl[0].length); }
    else {
      const partNo = /^([IVXLC]+)\\hspace/.exec(body);
      if (partNo) { number = partNo[1]; body = body.slice(partNo[0].length); }
    }
    body = body.replace(/\\hspace\s*\{[^}]*\}/g, ' ').replace(/\\quad|\\qquad|,|;/g, ' ');
    f.toc.push({ level: m[1], number, title: strip(body) });
  }
  const pm = /Output written on [^(]+\((\d+) pages?/.exec(log);
  if (pm) f.pages = +pm[1];
  for (const m of log.matchAll(/Reference `([^']+)' on page/g) || []) f.undefRefs.push(m[1]);
  for (const m of log.matchAll(/Reference `([^']+)'/g)) f.undefRefs.push(m[1]);
  for (const m of log.matchAll(/Citation `([^']+)' (?:on page \d+ )?undefined/g) || []) f.undefCites.push(m[1]);
  for (const m of log.matchAll(/Citation `([^']+)'/g)) f.undefCites.push(m[1]);
  return f;
}

/* ---------- 渲染事实 ---------- */
function readRenderFacts(html) {
  const f = { headings: [], xrefs: {}, unresolved: [], cites: [] };
  for (const m of html.matchAll(/<h([1-5])[^>]*>([\s\S]*?)<\/h\1>/g)) {
    const inner = m[2];
    const no = /<span class="secno">([^<]*)<\/span>/.exec(inner);
    const ti = /<span class="sectitle">([\s\S]*?)<\/span>/.exec(inner);
    f.headings.push({ level: +m[1], number: no ? strip(no[1]) : '', title: ti ? strip(ti[1]) : strip(inner) });
  }
  for (const m of html.matchAll(/<span class="xref" title="([^"]*)"[^>]*>([^<]*)<\/span>/g)) {
    const title = m[1], shown = m[2].trim();
    const k = /\\label\{([^}]+)\}/.exec(title);
    if (k) f.xrefs[k[1].trim()] = shown;
    else if (/未找到引用键：(.+)$/.test(title)) f.unresolved.push(title.replace(/^.*未找到引用键：/, '').trim());
  }
  for (const m of html.matchAll(/<span class="cite[^"]*">([^<]*)<\/span>/g)) f.cites.push(m[1].trim());
  return f;
}

/* ---------- 渲染（展开 \input） ---------- */
function expand(f) {
  const t = fs.readFileSync(f, 'utf8');
  return t.replace(/\\(?:input|include|subfile)\s*\{([^}]+)\}/g, (m, rel) => {
    const a = path.join(path.dirname(f), rel.endsWith('.tex') ? rel : rel + '.tex');
    return fs.existsSync(a) ? expand(a) : '';
  });
}

/* ---------- 主流程 ---------- */
const dirs = process.argv.slice(2);
const targets = dirs.length ? dirs : ['samples/corpus', 'samples/misc', 'samples/demos', 'samples/fresh'];
const files = [];
for (const d of targets) walk(path.join(ROOT, d), files);
files.sort();
fs.mkdirSync(KEEPDIR, { recursive: true });

let rendererErrors = 0, sampleErrors = 0;
const rows = [];
for (const f of files) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  const key = rel.replace(/\.tex$/, '').replace(/[\\/]/g, '__');
  const src = fs.readFileSync(f, 'utf8');

  if (!/\\documentclass/.test(src)) {
    rows.push({ rel, errors: [], notes: ['片段（无 \\documentclass），不单独编译'] });
    continue;
  }
  const skip = /^\s*%\s*pdf-check:\s*skip\s*(.*)$/mi.exec(src);
  if (skip) { rows.push({ rel, errors: [], notes: ['跳过 PDF 对照：' + (skip[1] || '').trim()] }); continue; }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'qlora-'));
  const tdir = path.join(work, 'src');
  copyDir(path.dirname(f), tdir);
  const docPath = path.join(tdir, 'input.tex');
  // 缺图自动占位（1×1 PNG），保证样例可编译
  const PNG1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
  for (const m of src.matchAll(/\\includegraphics(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)) {
    const target = path.join(tdir, m[1].trim());
    if (!fs.existsSync(target)) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, PNG1); }
  }
  if (!fs.existsSync(docPath)) fs.copyFileSync(f, docPath);
  const engine = pickEngine(src);
  let compiled = false, logOut = '';
  for (let pass = 0; pass < 2; pass++) {
    const r = spawnSync(path.join(TEXBIN, engine + '.exe'), ['-interaction=nonstopmode', '-halt-on-error', 'input.tex'],
      { cwd: tdir, encoding: 'utf8', timeout: 120000 });
    logOut = (r.stdout || '') + (r.stderr || '');
    compiled = fs.existsSync(path.join(tdir, 'input.pdf'));
    if (!compiled) break;
  }
  const errors = [], notes = [];
  let tex = null;
  if (!compiled) {
    sampleErrors++;
    const firstErr = (logOut.split('\n').filter(l => /^!/.test(l))[0] || logOut.trim().split('\n').pop() || '').trim();
    rows.push({ rel, errors: [], notes: ['样例不可编译（' + engine + '）：' + firstErr.slice(0, 120)], sample: true });
    fs.rmSync(work, { recursive: true, force: true });
    continue;
  }
  fs.copyFileSync(path.join(tdir, 'input.pdf'), path.join(KEEPDIR, key.replace(/^samples__/, '') + '.pdf'));
  tex = readTexFacts(tdir);

  let html;
  try { html = T.render(expand(f), {}).html; }
  catch (e) { errors.push('渲染异常：' + e.message); html = ''; }
  const r = readRenderFacts(html);

  // 1) 章节：toc vs 渲染标题（标题/编号）
  if (tex.toc.length) {
    const numbered = r.headings.filter(h => h.number);
    if (tex.toc.length !== numbered.length) {
      errors.push('编号章节数 ' + numbered.length + ' ≠ TeX ' + tex.toc.length);
    } else {
      for (let i = 0; i < tex.toc.length; i++) {
        const a = norm(tex.toc[i].title), b = norm(numbered[i].title);
        if (a && b && a !== b) { errors.push('第 ' + (i + 1) + ' 节标题：TeX「' + tex.toc[i].title + '」 vs 渲染「' + numbered[i].title + '」'); break; }
        if (tex.toc[i].number && tex.toc[i].number !== numbered[i].number) { errors.push('第 ' + (i + 1) + ' 节编号：TeX ' + tex.toc[i].number + ' vs 渲染 ' + numbered[i].number); break; }
      }
    }
    // 星号标题（不进 toc）：源码有几个，渲染里就应出现几个
    const starred = [...src.matchAll(/\\(part|chapter|section|subsection|subsubsection)\*\s*\{([^}]*)\}/g)].map(m => norm(m[2]));
    const rendered = new Set(r.headings.map(h => norm(h.title)));
    const missingStar = starred.filter(t => t && !rendered.has(t));
    if (missingStar.length) errors.push('星号标题缺失：' + missingStar.slice(0, 3).join(', '));
  }

  // 2) 引用：TeX 里已解析的标签，渲染里也应解析成同一编号
  const refKeys = [...new Set([...src.matchAll(/\\(?:ref|eqref|autoref|pageref|cref|Cref)\s*\{([^}]+)\}/g)].map(m => m[1].trim()))];
  for (const k of refKeys) {
    if (!tex.labels[k]) continue;                       // TeX 未解析（无标签）：不判
    const got = (r.xrefs[k] || '').replace(/^[(\[]|[)\]]$/g, '');
    const want = tex.labels[k].replace(/[{}]/g, '').split('}{')[0].trim();
    if (!got) { errors.push(`引用 \\${k} 在渲染中未解析（TeX=${want}）`); break; }
    if (got !== want) { errors.push(`引用 ${k}：TeX=${want}，渲染=${got}`); break; }
  }

  // 3) 文献编号
  const citeKeys = [...src.matchAll(/\\(?:no)?cite[a-zA-Z]*\*?\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)].flatMap(m => m[1].split(',').map(x => x.trim()));
  if (citeKeys.length) {
    const ay = citeKeys.filter(k => tex.bibYear[k]);
    if (ay.length === citeKeys.length && r.cites.length >= citeKeys.length) {
      for (let i = 0; i < citeKeys.length; i++) {
        const y = tex.bibYear[citeKeys[i]];
        if (!String(r.cites[i] || '').includes(y)) {
          errors.push('作者-年引用第 ' + (i + 1) + ' 个应为 ' + y + '，实际「' + (r.cites[i] || '') + '」');
          break;
        }
      }
    } else {
      const expected = citeKeys.map(k => tex.bib[k] ? '[' + tex.bib[k] + ']' : '[' + k + ']');
      if (expected.join(' ') !== r.cites.join(' ')) {
        errors.push('引用编号：TeX [' + expected.join(' ') + '] vs 渲染 [' + r.cites.join(' ') + ']');
      }
    }
  }

  // 4) 目录条目与页数（页数仅记录，设计上不模拟分页）
  notes.push(`PDF ${tex.pages} 页`);

  // 5) 源文本覆盖：源码里的内容词是否都出现在渲染里（数学/代码/图形除外）
  const srcText = src.replace(/\\begin\{(equation|align|gather|multline|eqnarray|tikzpicture|verbatim|lstlisting|minted|algorithmic)\*?\}[\s\S]*?\\end\{\1\*?\}/g, ' ')
    .replace(/\$[^$]*\$|\\\([^)]*\\\)|\\\[[^\\]]*\\\]/g, ' ')
    .replace(/\\[A-Za-z@]+\*?/g, ' ').replace(/[{}]/g, ' ');
  const rt = readRenderFacts(html);
  const renderPlain = (html.replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<(span|div)[^>]*class="[^"]*\bmath\b[^"]*"[^>]*>[\s\S]*?<\/\1>/g, ' ')
    .replace(/<[^>]+>/g, ' '));
  const toks = (s) => new Set((s.toLowerCase().match(/[\u4e00-\u9fff]|[a-z][a-z'\-]{2,}|\d{4,}/g) || []));
  const st = toks(srcText), rr = toks(renderPlain);
  const missing = [...st].filter(t => !rr.has(t));
  if (missing.length) notes.push('源码有而渲染未见（可能为宏参数/图形/代码）：' + missing.slice(0, 10).join(' '));

  if (errors.length) rendererErrors++;
  rows.push({ rel, errors, notes });
  fs.rmSync(work, { recursive: true, force: true });
}

for (const row of rows) {
  if (!row.errors.length && !row.sample) continue;
  if (row.sample) { console.log('⚠ ' + row.rel + '  ' + row.notes.join('；')); continue; }
  console.log('✗ ' + row.rel);
  row.errors.forEach(e => console.log('    [ERROR] ' + e));
}
console.log('\n=== 汇总 ===');
console.log('  文档 ' + rows.length + '，渲染差异 ' + rendererErrors + '，样例不可编译 ' + sampleErrors);
process.exit(rendererErrors ? 1 : 0);
