/*!
 * app.js — QuickLook LaTeX 预览页面的外壳逻辑
 * ------------------------------------------------------------------
 * 职责：宿主消息协议、主题、目录、源码/预览切换、MathJax 排版调度。
 * 宿主约定（与 QuickLook.WebPlugins 各包一致）：
 *   收 { type:'open-tex', payload:{ text|base64|url, name, dir } }
 *   收 { type:'set-theme', payload:{ theme:'auto'|'light'|'dark' } }
 *   发 { type:'tex-ready' } / { type:'tex-rendered', payload:{…} } / { type:'tex-error', payload:{…} }
 * ------------------------------------------------------------------
 */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };

  var MAX_RENDER_BYTES = 4 * 1024 * 1024;   // 超过则只给源码视图
  var MAX_INPUT_FILES = 40;
  var MAX_INPUT_DEPTH = 2;

  var state = {
    name: '',
    dir: '',
    source: '',
    result: null,
    view: 'preview',
    tocOpen: true,
    renderedAt: 0,
    hostMode: false
  };

  /* ---------------------------------------------------------------- */
  /* 主题                                                             */
  /* ---------------------------------------------------------------- */

  // 主题只有一个来源：QuickLook 的 context.Theme（None 时=跟随系统）。
  // 不提供独立主题开关，也不落 localStorage——预览工具不该有自己的外观设置。
  function initTheme() {
    var q = new URLSearchParams(location.search).get('theme');

    // 兜底：宿主没给时才问系统（正常路径永远不会走到这里）
    applyTheme(q === 'light' || q === 'dark' ? q : 'auto');

    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var onChange = function () {
      if ((document.documentElement.dataset.themePref || 'auto') === 'auto') applyTheme('auto');
    };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  function currentIsDark(pref) {
    if (pref === 'dark') return true;
    if (pref === 'light') return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function applyTheme(pref) {
    var dark = currentIsDark(pref);
    document.documentElement.dataset.themePref = pref;
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  }

  /* ---------------------------------------------------------------- */
  /* 小工具                                                           */
  /* ---------------------------------------------------------------- */

  var toastTimer = null;
  function toast(msg, ms) {
    var el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, ms || 2600);
  }

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function decodeBase64(b64) {
    var bin = atob(b64.replace(/\s+/g, ''));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return decodeBytes(bytes);
  }

  // 编码探测：BOM → UTF-8 严格 → GB18030 兜底
  function decodeBytes(bytes) {
    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
      return new TextDecoder('utf-8').decode(bytes.subarray(3));
    }
    if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
      return new TextDecoder('utf-16le').decode(bytes.subarray(2));
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (e) {
      try { return new TextDecoder('gb18030').decode(bytes); }
      catch (e2) { return new TextDecoder('utf-8').decode(bytes); }
    }
  }

  const isHostMode = () => {
    try {
      return window.__TEX_PLUGIN === true ||
        (location.protocol === 'file:' && (location.host === 'quicklook' || location.href.indexOf('file://quicklook') === 0));
    } catch (e) { return false; }
  };

  function postToHost(msg) {
    // QuickLook 用 PostWebMessageAsJson，页面侧就是 window.chrome.webview
    try {
      if (window.chrome && window.chrome.webview && window.chrome.webview.postMessage) {
        window.chrome.webview.postMessage(msg);
      }
    } catch (e) { /* 静默 */ }
  }

  /* ---------------------------------------------------------------- */
  /* \input / \include 展开（仅宿主模式可用，受预算保护）             */
  /* ---------------------------------------------------------------- */

  async function expandInputs(src, budget) {
    if (!state.hostMode || budget.depth > MAX_INPUT_DEPTH) return src;

    var re = /\\(?:input|include|subfile)\s*\{([^}]+)\}/g;
    var jobs = [];
    var m;
    while ((m = re.exec(src)) !== null && jobs.length < MAX_INPUT_FILES) {
      jobs.push({ raw: m[0], path: m[1].trim() });
    }
    if (!jobs.length) return src;

    var out = src;
    for (var k = 0; k < jobs.length; k++) {
      var job = jobs[k];
      if (budget.files >= MAX_INPUT_FILES) {
        out = out.split(job.raw).join('% [附注] 已达展开上限，未包含：' + job.path);
        continue;
      }
      var rel = job.path.replace(/\\/g, '/');
      if (!/\.(tex|ltx|txt)$/i.test(rel)) rel += '.tex';
      try {
        var res = await fetch(rel, { cache: 'no-store' });
        if (!res.ok) throw new Error(res.status + '');
        var txt = await res.text();
        budget.files++;
        txt = await expandInputs(txt, { depth: budget.depth + 1, files: budget.files });
        out = out.split(job.raw).join('\n' + txt + '\n');
      } catch (e) {
        out = out.split(job.raw).join('% [附注] 未能读取 \\input{' + job.path + '}（' + e.message + '）');
      }
    }
    return out;
  }

  /* ---------------------------------------------------------------- */
  /* 渲染                                                             */
  /* ---------------------------------------------------------------- */

  async function openDocument(info) {
    var docEl = $('#doc');
    var name = info.name || 'document.tex';

    state.name = name;
    state.dir = info.dir || '';
    state.source = info.text || '';

    var dropEl = $('#drop');
    if (dropEl) dropEl.hidden = true;

    resetTransientUi();

    $('#title').textContent = name;
    document.title = name + ' — LaTeX 预览';
    $('#stats').textContent = '';

    if (!state.source.trim()) {
      docEl.innerHTML = '<div class="empty">文件为空。</div>';
      return;
    }

      // .sty / .cls / .bib 本身就是纯文本：直接排版，不提供“源码视图”
      if (info.mode === 'source') {
        renderPlainText(docEl, state.source);
        $('#stats').textContent = state.source.split('\n').length + ' 行 · ' +
          fmtBytes(new Blob([state.source]).size);
        $('#warn-btn').hidden = true;
        return;
      }

    // 体积保护：超大文件直接给源码
    var bytes = new Blob([state.source]).size;
    if (bytes > MAX_RENDER_BYTES) {
      $('#stats').textContent = fmtBytes(bytes);
        docEl.innerHTML = '<div class="empty">文件较大（' + fmtBytes(bytes) + '），超出预览范围。</div>';
      return;
    }

    var t0 = performance.now();
    var gen = ++renderGen;

    // \input 展开
    var expanded = state.source;
    try {
      expanded = await expandInputs(state.source, { depth: 0, files: 0 });
    } catch (e) { /* 忽略 */ }

    var result;
    try {
      result = window.TeXRender.render(expanded, {
      extraDefs: info.defs || '',
    });
    } catch (e) {
      result = {
        html: '<pre class="code"><code>' +
          (expanded || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') +
          '</code></pre>',
        headings: [], warnings: ['渲染器异常：' + (e && e.message ? e.message : e)],
        meta: {}, stats: { math: 0, blocks: 0, chars: expanded.length, lines: expanded.split('\n').length }
      };
    }
    state.result = result;

    // 正文容器
    var doc = document.createElement('article');
    doc.className = 'latex-doc';
    var metaPackages = (result.meta && result.meta.packages) ? result.meta.packages.join(' ') : '';
    var dcName = (result.meta && result.meta.documentclass) ? result.meta.documentclass : '';
    doc.lang = /ctex|CJK|cjk/i.test(dcName + ' ' + metaPackages) ? 'zh-CN' : 'en';

    // ---- 编译缓存：命中则整块回放（不再加载 MathJax、不再排版）----
    var cachedHtml = await loadCachedDocument(info);
    var fromCache = false;
    if (cachedHtml && gen === renderGen) {
      doc.innerHTML = cachedHtml;
      fromCache = true;
    } else {
      doc.innerHTML = result.html || '<div class="empty">没有可显示的内容。</div>';
    }
    docEl.replaceChildren(doc);


    if (!fromCache) applyInlineImages(doc, info.images);
    bindImageFallbacks(doc, info.issues);

    var headings = result.headings;
    if (fromCache) {
      // 缓存里只有成品 DOM，目录/统计从 DOM 反推
      var rebuilt = rebuildMetaFromDom(doc);
      headings = rebuilt.headings;
      // 统计单一来源：块数/公式数一律用渲染结果（不从 DOM 反推，避免缓存命中时口径不一致）
    }
    buildToc(headings);

    // 首屏：文本已可见，立刻让宿主收起忙碌指示（不要让用户盯着转圈）
    postToHost({
      type: 'tex-painted',
      payload: { ms: Math.round(performance.now() - t0), cache: fromCache }
    });

    // 公式：按需加载 MathJax + 分块排版（慢到 3 秒才出进度条）
    var mathOk = true;
    if (fromCache) {
      hideProgress();
    } else {
      mathOk = await typesetProgressive(doc, gen);
      // 排版完成且没有换文档，就把成品 HTML 交给宿主落盘（下次直接回放）
      if (gen === renderGen) {
        try { await saveCache(doc.innerHTML); } catch (e) { console.warn('[tex] 缓存失败', e); }
      }
    }
    var ms = Math.round(performance.now() - t0);
    state.renderedAt = ms;

    var parts = [];
    parts.push(result.stats.blocks + ' 块');
    if (result.stats.math) parts.push(result.stats.math + ' 个公式');
    parts.push(fmtBytes(bytes));
    parts.push(ms + ' ms');
    var unknown = (result.unknown || []);
    var unknownCount = result.unknownTotal || unknown.length;
    if (unknownCount) parts.push(unknownCount + ' 个宏未识别');
    $('#stats').textContent = parts.join(' · ');
    if (unknown.length) {
      $('#stats').title = '未识别但已保留参数的宏：\n' + unknown.slice(0, 40).join('、');
    }

    if (!mathOk && result.stats.math) {
      toast('公式渲染引擎未就绪，公式以源码显示', 4000);
    }
    var warnGroups = groupWarnings(result.warnings);
    state.warnGroups = warnGroups;
    if (warnGroups.length) {
      var total = warnGroups.reduce(function (n, g) { return n + g.items.length; }, 0);
      $('#warn-btn').hidden = false;
      $('#warn-btn').textContent = warnGroups.length + ' 类 · ' + total + ' 项';
      $('#warn-btn').title = warnGroups.map(function (g) {
        return g.label + '（' + g.items.length + '）：' +
          g.items.slice(0, 6).join('、') + (g.items.length > 6 ? ' …' : '');
      }).join('\n');
    } else {
      $('#warn-btn').hidden = true;
    }

    postToHost({
      type: 'tex-rendered',
      payload: {
        name: name,
        math: result.stats.math,
        blocks: result.stats.blocks,
        warnings: (result.warnings || []).length,
        unknown: unknown.slice(0, 20),
        ms: ms
      }
    });
  }

  // 宿主把 \includegraphics 引用的图片内联成 data URI 下发，这里按路径回填，
  // 页面因此不需要（也不允许）直接请求本地文件。
  function applyInlineImages(container, images) {
    window.__texImages = images || null;
    if (!images) return;
    var keys = Object.keys(images);
    if (!keys.length) return;
    Array.prototype.forEach.call(container.querySelectorAll('img.fig'), function (img) {
      var p = (img.getAttribute('data-path') || '').replace(/\\/g, '/');
      var hit = images[p];
      if (!hit) {
        for (var i = 0; i < keys.length; i++) {
          if (keys[i].toLowerCase() === p.toLowerCase()) { hit = images[keys[i]]; break; }
        }
      }
      if (hit) img.src = hit;
      else if (p) img.src = encodeURI(p);   // 没有内联：交给宿主白名单或独立模式
    });
  }

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // 页内“降级详情”面板（不用 alert：WebView2 会弹原生对话框，标题是站点名）
  function openWarnPanel() {
    var box = $('#dlg-body');
    if (!box) return;
    var groups = state.warnGroups || [];
    var html = '';
    if (!groups.length) {
      html = '<div class="empty">没有降级项。</div>';
    } else {
      groups.forEach(function (g) {
        html += '<div class="dlg-group"><div class="dlg-gtitle">' +
          escHtml(g.label) + '（' + g.items.length + '）</div><ul>';
        g.items.slice(0, 50).forEach(function (it) {
          html += '<li>' + escHtml(it) + '</li>';
        });
        if (g.items.length > 50) {
          html += '<li>… 还有 ' + (g.items.length - 50) + ' 项</li>';
        }
        html += '</ul></div>';
      });
    }
    box.innerHTML = html;
    $('#dlg').hidden = false;
    $('#dlg-close').focus();
  }

  function closeWarnPanel() {
    var d = $('#dlg');
    if (d) d.hidden = true;
  }

  // 面板/页面是复用的：换文档时必须把上一次的对话框、进度条、源码视图、
  // 滚动位置、toast 全部复位，否则会“上一个文件的面板残留到下一个文件”。
  function resetTransientUi() {
    closeWarnPanel();
    hideProgress();

    var toastEl = $('#toast');
    if (toastEl) toastEl.hidden = true;
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }

    var warnBtn = $('#warn-btn');
    if (warnBtn) { warnBtn.hidden = true; warnBtn.textContent = ''; }
    state.warnGroups = [];

    var preview = $('#view-preview');
    if (preview) { preview.hidden = false; preview.scrollTop = 0; }
  }

  var WARN_KINDS = {
    macro: '不认识的宏（不影响正文可读性）',
    env: '未识别的环境',
    image: '无法显示的图形',
    parse: '解析提示'
  };

  // 把 "kind: 内容" 形式的告警按类归并，避免一屏碎信息
  function groupWarnings(list) {
    var groups = {}, order = [];
    (list || []).forEach(function (w) {
      var idx = w.indexOf(': ');
      var kind = idx > 0 ? w.slice(0, idx) : 'other';
      var msg = idx > 0 ? w.slice(idx + 2) : w;
      if (!groups[kind]) { groups[kind] = []; order.push(kind); }
      if (groups[kind].indexOf(msg) < 0) groups[kind].push(msg);
    });
    return order.map(function (k) {
      return { kind: k, label: WARN_KINDS[k] || '其它', items: groups[k] };
    });
  }

  // 图片缺失/损坏时不要显示浏览器破图图标，换成可读的占位框
  // 图片失败的文案由宿主给出的“事实原因”决定（缺失 / 过大 / PDF 渲染失败 / 路径无效）
  var IMAGE_REASON = {
    'missing': '文件不存在',
    'invalid-path': '路径无效',
    'too-large': '体积过大（>2 MB），未内联',
    'pdf-render-failed': 'PDF 渲染失败'
  };

  function bindImageFallbacks(container, issues) {
    issues = issues || {};
    var replace = function (img) {
      if (!img.parentNode) return;
      var span = document.createElement('span');
      var path = img.dataset.path || img.getAttribute('data-path') || '';
      var code = issues[path] || issues[path.replace(/\\/g, '/')] || '';
      var reason = IMAGE_REASON[code] || '无法显示';
      // 只有“文件在、但渲染不出来”才值得点开 QuickLook；文件不存在点也没用
      var clickable = img.getAttribute('data-pdf') && code !== 'missing' && code !== 'invalid-path';
      span.className = 'tex-chip' + (clickable ? ' pdf-open' : '');
      span.setAttribute('title', reason + '：' + path);
      if (clickable) {
        span.setAttribute('role', 'button');
        span.setAttribute('tabindex', '0');
        span.setAttribute('data-path', path);
      }
      span.textContent = '图 ' + reason + '：' + path;
      img.parentNode.replaceChild(span, img);
    };
    Array.prototype.forEach.call(container.querySelectorAll('img.fig'), function (img) {
      img.addEventListener('error', function () { replace(img); });
      if (img.complete && img.naturalWidth === 0) replace(img);
    });
  }

  /* ---------------- MathJax：按需加载 + 分块排版 ---------------- */

  var mathJaxLoading = null;

  // ---------- 编译缓存：命中则瞬间回放，未命中则排版后回传宿主落盘 ----------
  var CACHE_CHUNK = 128 * 1024;      // 单条消息 128 KB，避免一次投递几 MB
  var CACHE_MAX = 8 * 1024 * 1024;   // 超过 8 MB 不缓存
  var CACHE_MIN = 24 * 1024;         // 太小的文档缓存没意义（本来就没几毫秒）

  // 缓存是 gzip 过的（体积约为原 HTML 的 10%~25%），这里解压后使用。
  async function loadCachedDocument(info) {
    if (!info.cache) return null;
    try {
      var res = await fetch(info.cache, { cache: 'no-store' });
      if (!res.ok) return null;

      var buf = new Uint8Array(await res.arrayBuffer());
      if (!buf.length) return null;

      var isGzip = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
      var html;
      if (!isGzip) {
        html = new TextDecoder('utf-8').decode(buf);   // 兼容旧格式 / 降级
      } else if (typeof DecompressionStream === 'function') {
        var stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
        html = await new Response(stream).text();
      } else {
        return null;                                    // 运行时太老，直接走正常渲染
      }
      return html && html.length > 200 ? html : null;
    } catch (e) {
      return null;
    }
  }

  async function saveCache(html) {
    if (!html || html.length < CACHE_MIN || html.length > CACHE_MAX) return;
    try {
      postToHost({ type: 'cache-begin', payload: { size: html.length } });
      for (var i = 0; i < html.length; i += CACHE_CHUNK) {
        postToHost({ type: 'cache-chunk', payload: { text: html.slice(i, i + CACHE_CHUNK) } });
        // 每 4 块让一次主线程，避免几 MB 连续投递把界面顶住
        if ((i / CACHE_CHUNK) % 4 === 3) {
          await new Promise(function (resolve) { window.setTimeout(resolve, 0); });
        }
      }
      postToHost({ type: 'cache-end' });
    } catch (e) {
      console.warn('[tex] 写缓存失败', e);
    }
  }

  // 缓存命中时没有解析结果，用 DOM 反推目录与统计
  function rebuildMetaFromDom(container) {
    var headings = [];
    Array.prototype.forEach.call(container.querySelectorAll('[id^="sec-"]'), function (h) {
      var m = /^h([1-7])$/.exec(h.className.match(/h[1-7]/) ? h.className.match(/h[1-7]/)[0] : 'h3');
      var no = h.querySelector('.secno');
      var title = h.querySelector('.sectitle');
      headings.push({
        level: m ? parseInt(m[1], 10) : 3,
        id: h.id,
        number: no ? no.textContent.trim() : '',
        html: title ? title.innerHTML : h.textContent,
        text: h.textContent
      });
    });
    return {
      headings: headings,
      stats: {
        blocks: container.querySelectorAll('p,h1,h2,h3,h4,h5,ul,ol,dl,pre,table,figure,div').length,
        math: container.querySelectorAll('mjx-container').length,
        chars: 0,
        lines: 0
      }
    };
  }

  // 每次打开新文档都 +1；后台分块的排版循环发现代次变了就立刻退出，
  // 否则旧文档的剩余公式会和新闻档抢主线程（表现为“越用越慢”）。
  var renderGen = 0;

  // 纯文本文档完全不加载这 2 MB；有公式时再注入脚本
  function ensureMathJax() {
    if (window.MathJax && window.MathJax.typesetPromise) return Promise.resolve(true);
    if (mathJaxLoading) return mathJaxLoading;
    mathJaxLoading = new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = 'mathjax/tex-mml-svg.js';
      s.async = true;
      s.onload = function () { resolve(true); };
      s.onerror = function () { resolve(false); };
      document.head.appendChild(s);
    });
    return mathJaxLoading;
  }

  function showProgress() { var el = $('#progress'); if (el) el.hidden = false; }
  function hideProgress() { var el = $('#progress'); if (el) el.hidden = true; }

  function setProgress(p) {
    var f = $('#pbar-fill'), t = $('#ppct');
    if (f) f.style.width = p + '%';
    if (t) t.textContent = p + '%';
  }

  // 分块排版：每块 40 个公式，块间让出主线程，滚动与首屏不被卡住
  // MathJax 排版失败会产生 <merror>。这里把出错的公式标出来并附上原始 TeX，
  // 让"到底渲染了没有"一眼可见，而不是留一堆看不懂的红字。
  // tufte：把 aside.sidenote 抽到右侧独立页边栏，并按其锚点做垂直对齐
function layoutMarginNotes(container) {
  var layout = container.querySelector('.doc-layout[data-profile="tufte"]');
  if (!layout) return;
  var margin = layout.querySelector('.margin-notes');
  if (!margin) return;
  // Chromium 支持 CSS 锚点定位时，垂直对齐由 CSS 完成；这里只做防重叠兜底
  // 锚点定位由 CSS 声明，但浏览器支持程度不一致：这里统一按锚点实测校正一次（inline top 优先）
  var notes = margin.querySelectorAll('aside.sidenote');
  if (!notes.length) return;
  var base = layout.getBoundingClientRect().top;
  var list = [];
  for (var k = 0; k < notes.length; k++) {
    var n = notes[k];
    var ref = layout.querySelector('.note-ref[data-note="' + n.getAttribute('data-note') + '"]');
    var top = ref ? (ref.getBoundingClientRect().top - base) : 0;
    n.style.top = Math.max(0, top) + 'px';
    list.push(n);
  }
  {
    list.sort(function (x, y) { return parseFloat(x.style.top) - parseFloat(y.style.top); });
    var prevBottom = -1e9;
    for (var j = 0; j < list.length; j++) {
      var it = list[j];
      var t = parseFloat(it.style.top) || 0;
      if (t < prevBottom + 6) t = prevBottom + 6;
      it.style.top = t + 'px';
      prevBottom = t + it.offsetHeight;
    }
  }
}

function markMathErrors(container) {
    Array.prototype.forEach.call(container.querySelectorAll('.math'), function (el) {
      // 两种失败都要标记：MathJax 生成了 <merror>，或者根本没生成公式容器（解析直接抛异常）
      var hasError = !!el.querySelector('merror');
      var converted = !!el.querySelector('mjx-container');
      if (!hasError && converted) return;
      if (el.classList.contains('math-failed')) return;
      el.classList.add('math-failed');
      var src = el.getAttribute('data-tex') || '';
      try { postToHost({ type: 'math-error', payload: { tex: src.slice(0, 300) } }); } catch (e) { }
      // 预览优先：原位显示，并写出真实原因（MathJax 报的错，不是笼统“失败”）
      var merr = el.querySelector('merror');
      var reason = merr ? (merr.textContent || '').replace(/\s+/g, ' ').trim() : '排版异常';
      el.textContent = '';
      var why = document.createElement('span');
      why.className = 'formula-reason';
      why.textContent = reason;
      el.appendChild(why);
    });
  }

  async function typesetProgressive(container, gen) {
    var nodes = Array.prototype.slice.call(container.querySelectorAll('.math'));
    if (!nodes.length) return true;

    // 需求：载入超过 3 秒才显示进度条
    var timer = setTimeout(showProgress, 3000);
    var ok = await ensureMathJax();
    if (!ok) { clearTimeout(timer); hideProgress(); return false; }

    try {
      if (window.MathJax.startup && window.MathJax.startup.promise) {
        await window.MathJax.startup.promise;
      }
    } catch (e) { }

    // 首屏优先：先排前 40 个；超过 120 个公式时其余放到空闲时间慢慢排，
    // 这样大文档也能立刻滚动阅读，不会卡在一块。
    var FIRST = 40;
    var IDLE_CHUNK = 24;
    var started = 0;

    if (gen !== renderGen) { clearTimeout(timer); return false; }

    var firstBatch = nodes.slice(0, Math.min(FIRST, nodes.length));
    try { await window.MathJax.typesetPromise(firstBatch); } catch (e) { console.warn('[tex] 首屏公式排版失败', e); }
    started = firstBatch.length;
    setProgress(Math.round(started / nodes.length * 100));

    var idle = window.requestIdleCallback
      ? function (fn) { return window.requestIdleCallback(fn, { timeout: 300 }); }
      : function (fn) { return setTimeout(fn, 16); };

    while (started < nodes.length) {
      if (gen !== renderGen) break;                     // 换文档了：停止剩余排版
      // 关键：每块之前显式让出主线程。否则大文档会连续占用渲染线程，
      // 表现为“按 Enter / Esc 半天没反应”。
      await new Promise(function (resolve) { window.setTimeout(resolve, 16); });

      var batch = nodes.slice(started, started + IDLE_CHUNK);
      started += batch.length;
      try {
        await window.MathJax.typesetPromise(batch);
      } catch (e) {
        console.warn('[tex] 公式排版失败', e);
      }
      setProgress(Math.round(Math.min(started, nodes.length) / nodes.length * 100));
    }
    markMathErrors(container);

    clearTimeout(timer);
    hideProgress();
    return true;
  }

  /* ---------------------------------------------------------------- */
  /* 视图切换                                                         */
  /* ---------------------------------------------------------------- */

  // 纯文本文件（.sty/.cls/.bib）：按文本排版
  function renderPlainText(box, text) {
    var pre = document.createElement('pre');
    pre.className = 'code plain-doc';
    pre.textContent = text;
    box.replaceChildren(pre);
  }


  var shownNote = null;


  /* ---------------------------------------------------------------- */
  /* 目录                                                             */
  /* ---------------------------------------------------------------- */

  function buildToc(headings) {
    var box = $('#toc');
    box.innerHTML = '';
    if (!headings || !headings.length) {
      $('#sidebar').style.display = 'none';   // 没有标题就不占位置（试卷/短文常见）
      return;
    }
    $('#sidebar').style.display = '';
    $('#toc-empty').hidden = true;

    var frag = document.createDocumentFragment();
    headings.forEach(function (h) {
      var plain = String(h.text || '').replace(/\s+/g, ' ').trim();
      var rich = String(h.html || '').replace(/<[^>]*>/g, '').trim();
      if (!plain && !rich) return;        // 空标题不进目录
      var a = document.createElement('a');
      a.className = 'toc-item lvl' + h.level;
      a.href = '#' + h.id;
      a.dataset.target = h.id;
      a.innerHTML = (h.number ? '<span class="toc-no">' + h.number + '</span>' : '') +
        '<span class="toc-text">' + (h.html || h.text) + '</span>';
      a.addEventListener('click', function (ev) {
        ev.preventDefault();
        var t = document.getElementById(h.id);
        if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      frag.appendChild(a);
    });
    box.appendChild(frag);
    observeHeadings();
  }

  var headingObserver = null;
  function observeHeadings() {
    if (headingObserver) { headingObserver.disconnect(); headingObserver = null; }
    if (!('IntersectionObserver' in window)) return;
    var doc = $('#doc');
    if (!doc) return;
    var items = Array.prototype.slice.call(doc.querySelectorAll('[id^="sec-"]'));
    if (!items.length) return;

    headingObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        var id = en.target.id;
        var links = document.querySelectorAll('.toc-item');
        for (var i = 0; i < links.length; i++) {
          links[i].classList.toggle('active', links[i].dataset.target === id);
        }
      });
    }, { root: $('#view-preview'), rootMargin: '-10% 0px -75% 0px', threshold: 0 });

    items.forEach(function (el) { headingObserver.observe(el); });
  }

  function toggleToc() {
    state.tocOpen = !state.tocOpen;
    document.body.classList.toggle('toc-hidden', !state.tocOpen);
  }

  /* ---------------------------------------------------------------- */
  // PDF 图卡片：点击后交给宿主，由 QuickLook 自己的 PDF 插件打开（不重复造栅格化器）
  document.addEventListener('click', function (ev) {
    var t = ev.target;
    while (t && t !== document.body) {
      if (t.classList && t.classList.contains('pdf-open')) {
        ev.preventDefault();
        var p = t.getAttribute('data-path');
        if (p) postToHost({ type: 'open-file', payload: { path: p } });
        return;
      }
      t = t.parentElement;
    }
  }, true);
  /* 宿主消息                                                         */
  /* ---------------------------------------------------------------- */

  function onHostMessage(data) {
    if (!data || typeof data !== 'object') return;
    var type = data.type;

    if (type === 'open-tex' || type === 'open-latex') {
      var p = data.payload || {};
      var text = '';
      try {
        if (p.text != null) text = String(p.text);
        else if (p.base64) text = decodeBase64(p.base64);
      } catch (e) {
        toast('文件解码失败：' + e.message, 5000);
        return;
      }
      if (p.dir) state.dir = p.dir;
      // 透传整个 payload：宿主以后新增字段（issues / defs / cache）
      // 不需要页面再改一次白名单，避免“字段被悄悄丢掉”这类隐性缺陷
      var doc = {};
      for (var k in p) if (Object.prototype.hasOwnProperty.call(p, k)) doc[k] = p[k];
      doc.text = text;
      doc.dir = p.dir || state.dir;
      openDocument(doc);
      return;
    }

    if (type === 'set-theme') {
      var th = data.payload && data.payload.theme;
      if (th === 'auto' || th === 'light' || th === 'dark') applyTheme(th);
      return;
    }

    if (type === 'ping') { postToHost({ type: 'pong' }); return; }
  }

  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (typeof d === 'string') {
      try { d = JSON.parse(d); } catch (e) { return; }
    }
    onHostMessage(d);
  });

  // WebView2 也支持 chrome.webview 的 message 事件（与 window.message 同源）
  if (window.chrome && window.chrome.webview) {
    try {
      window.chrome.webview.addEventListener('message', function (ev) {
        var d = ev.data;
        if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { return; } }
        onHostMessage(d);
      });
    } catch (e) { /* 忽略 */ }
  }

  /* ---------------------------------------------------------------- */
  /* 独立模式：拖放 / 选择文件 / ?tex= 查询参数                        */
  /* ---------------------------------------------------------------- */

  async function openFromFile(file) {
    var buf = await file.arrayBuffer();
    var text = decodeBytes(new Uint8Array(buf));
    state.dir = '';
    openDocument({ name: file.name, dir: '', text: text });
  }

  function bindStandalone() {
    var input = $('#file-input');
    var drop = $('#drop');
    if (input) {
      input.addEventListener('change', function () {
        if (input.files && input.files[0]) openFromFile(input.files[0]);
      });
    }
    ['dragenter', 'dragover'].forEach(function (t) {
      document.addEventListener(t, function (e) { e.preventDefault(); if (drop) drop.classList.add('hover'); });
    });
    ['dragleave', 'drop'].forEach(function (t) {
      document.addEventListener(t, function (e) { e.preventDefault(); if (drop) drop.classList.remove('hover'); });
    });
    document.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) openFromFile(e.dataTransfer.files[0]);
    });

    var q = new URLSearchParams(location.search);
    if (q.get('texBase64')) {
      try { openDocument({ name: q.get('name') || 'document.tex', dir: '', text: decodeBase64(q.get('texBase64')) }); }
      catch (e) { toast('texBase64 解码失败', 4000); }
    } else if (q.get('tex')) {
      fetch(q.get('tex')).then(function (r) { return r.text(); })
        .then(function (t) { openDocument({ name: q.get('name') || 'document.tex', dir: '', text: t }); })
        .catch(function (e) { toast('加载失败：' + e.message, 5000); });
    }
  }

  /* ---------------------------------------------------------------- */
  /* 启动                                                             */
  /* ---------------------------------------------------------------- */

  function bindUi() {
    $('#btn-toc').addEventListener('click', toggleToc);
    $('#warn-btn').addEventListener('click', openWarnPanel);
    $('#dlg-close').addEventListener('click', closeWarnPanel);
    $('#dlg').addEventListener('click', function (ev) {
      if (ev.target === $('#dlg')) closeWarnPanel();   // 点遮罩关闭
    });
    window.addEventListener('keydown', function (e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      var tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'Tab') { e.preventDefault(); toggleToc(); }
      if (e.key === 'Escape') { closeWarnPanel(); }
    });
  }

  var _marginTimer = null;
function layoutMarginNotesDebounced() {
  clearTimeout(_marginTimer);
  _marginTimer = setTimeout(function () {
    var d = $('#doc') && $('#doc').firstElementChild;
    if (d) layoutMarginNotes(d);
  }, 120);
}
window.addEventListener('resize', layoutMarginNotesDebounced);

function boot() {
    initTheme();
    state.hostMode = isHostMode();
    document.body.dataset.mode = state.hostMode ? 'host' : 'standalone';
    bindUi();
    bindStandalone();

    postToHost({ type: 'tex-ready', payload: { version: (window.TeXRender || {}).version || '0' } });

    if (state.hostMode) {
      // 宿主模式下页面即为 \ 文档壳，隐藏空状态提示
      var drop = $('#drop');
      if (drop) drop.hidden = true;
      document.body.classList.add('host');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
