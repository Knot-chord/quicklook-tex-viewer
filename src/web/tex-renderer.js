/*!
 * tex-renderer.js — 轻量 LaTeX 预览渲染器
 * ------------------------------------------------------------------
 * 定位：QuickLook 预览（“瞟一眼”）场景，可读性优先，不追求排版保真。
 * 职责：把 .tex 源码解析成 HTML 骨架；公式输出标准 TeX 定界
 *       \( \) / \[ \]，交给页面里的 MathJax 完成真正的数学排版。
 * 约定：任何解析失败都降级为纯文本，绝不抛异常打断预览。
 * ------------------------------------------------------------------
 */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* 0. 常量                                                             */
  /* ------------------------------------------------------------------ */

  // 整段数学环境：内容原样交给 MathJax
  // 词汇表/常量表在 tex-vocab.js（数据与逻辑分离）
  var V = global.TeXViewerVocab;
  if (!V) throw new Error('tex-vocab.js 未加载');
  var MATH_ENVS = V.MATH_ENVS, THEOREM_ENVS = V.THEOREM_ENVS, SKIP_MACROS = V.SKIP_MACROS,
      SILENT_MACROS = V.SILENT_MACROS, CODE_ENVS = V.CODE_ENVS, NO_OUTPUT_ARGS = V.NO_OUTPUT_ARGS,
      DIMENSION_NAMES = V.DIMENSION_NAMES, RAW_ENVS = V.RAW_ENVS,
      CHAR_SYMBOLS = V.CHAR_SYMBOLS, TEXT_SYMBOLS = V.TEXT_SYMBOLS;

  /* ------------------------------------------------------------------ */
  /* 1. 基础工具                                                         */
  /* ------------------------------------------------------------------ */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function escAttr(s) {
    return esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // LaTeX 转义：\texttt/\verb 里的 \_ \& \% \# \{ \} \- 等要还原成字符本身
  function unescapeLatex(s) {
    return String(s == null ? '' : s)
      .replace(/\\([_&%#${}])/g, '$1')
      .replace(/\\textbackslash\b/g, '\\')
      .replace(/\\textasciitilde\b/g, '~')
      .replace(/\\textasciicircum\b/g, '^')
      .replace(/\\slash\b/g, '/')
      .replace(/\\-/g, '');            // 断词提示，不产生字符
  }

  // 统计一行的净花括号深度（跳过 \{ \} 与 \\）
  function braceDepth(s) {
    var d = 0;
    for (var k = 0; k < s.length; k++) {
      var ch = s[k];
      if (ch === '\\') { k++; continue; }
      if (ch === '{') d++;
      else if (ch === '}') d--;
    }
    return d;
  }

  function readGroup(s, i) {
    if (s[i] !== '{') return null;
    var depth = 0, start = i + 1;
    for (var k = i; k < s.length; k++) {
      var c = s[k];
      if (c === '\\') { k++; continue; }
      if (c === '{') { depth++; }
      else if (c === '}') {
        depth--;
        if (depth === 0) return { text: s.substring(start, k), end: k + 1 };
      }
    }
    return null;
  }

  // 读一个 […] 可选参数
  function readOptional(s, i) {
    if (s[i] !== '[') return null;
    var depth = 0;
    // 注意：必须从 i + 1 开始。从 i 开始会把开头的 "[" 也算进深度，
    // 于是永远读不到结尾 "]"（\\[2.5ex]、\rule[-1ex] 全都因此漏进正文）。
    for (var k = i + 1; k < s.length; k++) {
      var c = s[k];
      if (c === '\\') { k++; continue; }
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') {
        if (c === ']' && depth === 0) return { text: s.substring(i + 1, k), end: k + 1 };
        depth--;
      }
    }
    return null;
  }

  function countOcc(hay, needle) {
    var n = 0, i = 0;
    while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
    return n;
  }

  function safeClass(s) {
    return String(s).replace(/[^a-zA-Z0-9_-]/g, '');
  }

  function today() {
    var d = new Date();
      var MON = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      return MON[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
  }

  /* ------------------------------------------------------------------ */
  /* 2. 数学片段包装                                                     */
  /* ------------------------------------------------------------------ */

  // 数学内容里的零参自定义宏也要展开，否则 $\R$ 只能显示成 R
  // TeX 的参数替换是“词法级”的：宏体里 \textbackslash#1 的控制词在 # 前就结束了，
  // 替换后不能粘成 \textbackslashsidenote —— 先补一个空组隔开（\textbackslash{}sidenote）。
  function substParams(body, args) {
    // TeX 是词法级替换。只有一种情况会出错：宏体里 	extbackslash#1 这种
    // “控制词紧贴 #n”，且替换值以字母开头 —— 这时会粘成一个新命令名，需要插空组。
    // 反之（例如 igl#1 替换成 igllgroup）本身就有反斜杠分隔，不能插空组，
    // 否则 igl{} 会被 MathJax 判成“缺少定界符”。
    var src = String(body || '');
    return src.replace(/#([1-9])/g, function (m, d, off, whole) {
      var v = args[+d - 1];
      if (v == null) v = '';
      var prev = whole.charAt(off - 1);
      var glueRisk = /[A-Za-z]/.test(prev) && /^[A-Za-z]/.test(v);
      return glueRisk ? '{}' + v : v;
    });
  }

  function expandMathMacros(tex, ctx) {
    if (!ctx || !ctx.macros) return tex;
    var out = String(tex);
    for (var pass = 0; pass < 3; pass++) {
      var changed = false;
      out = out.replace(/\\([A-Za-z@]+)/g, function (m, name) {
        var def = ctx.macros[name];
        if (!def || def.n > 0 || String(def.body).indexOf('#') >= 0) return m;
        if (MATH_SAFE[name]) return m;      // 原生命令优先，避免被文档里的重定义破坏
        changed = true;
        return String(def.body);
      });
      if (!changed) break;
    }

    // 带参宏：在数学串里按 \name{arg1}{arg2} 形式替换
    for (var pass2 = 0; pass2 < 3; pass2++) {
      var changed2 = false, buf = '', k = 0;
      while (k < out.length) {
        if (out[k] === '\\') {
          var nm = /^[A-Za-z@]+/.exec(out.substring(k + 1));
          if (nm) {
            var name2 = nm[0];
            var def2 = ctx.macros[name2];
            if (def2 && def2.n > 0) {
              var j = k + 1 + name2.length, args2 = [], ok2 = true;
              var need2 = def2.n;
              if (def2.opt != null) {
                var mo = readOptional(out, j);
                if (mo) { args2.push(mo.text); j = mo.end; }
                else if (def2.opt !== '') { args2.push(def2.opt); }
                else ok2 = false;
                need2--;
              }
              for (var a2 = 0; a2 < need2; a2++) {
                var g2 = readGroup(out, j);
                if (!g2) { ok2 = false; break; }
                args2.push(g2.text);
                j = g2.end;
              }
              if (ok2) {
                buf += substParams(def2.body, args2);
                k = j;
                changed2 = true;
                continue;
              }
            }
          }
        }
        buf += out[k];
        k++;
      }
      out = buf;
      if (!changed2) break;
    }
    return out;
  }

  // MathJax 离线包没有 color 扩展：\color/\textcolor 在数学里会直接报错并漏出源码。
  // 这里把“渲染不了但不影响公式本身”的宏剥掉，换来公式正常排版。
  // 这些是“图形引擎”而不是公式：MathJax 不支持，塞进去只会报错。
  // 与其让用户看到一堆红字，不如按“图以源码显示”处理（与 TikZ 同一套降级）。
  var DIAGRAM_ENGINE = /\\xymatrix\b|\\begin\{xy\}|\\begin\{tikzpicture\}|\\begin\{pspicture\}|\\begin\{circuitikz\}/;

  function diagramAsCode(tex, ctx) {
    // 预览插件不展示源码：未渲染的图形只留中性占位
    var engine = 'TikZ';
    if (/\\xymatrix|\\begin\{xy\}/.test(tex)) engine = 'xypic';
    else if (/\\begin\{pspicture\}|\\psframe/.test(tex)) engine = 'PSTricks';
    else if (/\\begin\{circuitikz\}/.test(tex)) engine = 'circuitikz';
    return '<div class="tex-hold" data-engine="' + engine + '">' + engine + '</div>';
  }

  function sanitizeMath(tex) {
    if (!tex) return tex;
    var s = String(tex);
    s = s.replace(/\\textcolor\s*\{[^}]*\}/g, '');
    s = s.replace(/\\colorbox\s*\{[^}]*\}/g, '');
    s = s.replace(/\\color\s*\{[^}]*\}/g, '');
    s = s.replace(/\\color\s+[A-Za-z]+/g, '');
    s = s.replace(/\\textsc\s*\{([^{}]*)\}/g, '\\text{$1}');
    s = s.replace(/\\ensuremath\s*\{([^{}]*)\}/g, '$1');
    s = s.replace(/\\bm\s*\{/g, '\\boldsymbol{');
    s = s.replace(/\\unit\s*\{([^{}]*)\}/g, '\\mathrm{$1}');
    // 数学串里出现 $ 一定是宏体残留，MathJax 会整条报错 → 去掉
    s = s.replace(/\$/g, '');

    // 编号由我们自己的 \tag 控制：作者写的 \tag 与 \nonumber 一律剥掉，
    // 否则同一条公式里出现两个 \tag，MathJax 直接报错。
    s = s.replace(/\\tag\*?\{[^{}]*\}/g, '');
    s = s.replace(/\\nonumber\b/g, '').replace(/\\notag\b/g, '');

    // `\[...\]` 已经是 display 上下文：内部再套 equation/displaymath 会让 MathJax 报错
    s = s.replace(/\\begin\{(equation\*?|displaymath|math)\}/g, '');
    s = s.replace(/\\end\{(equation\*?|displaymath|math)\}/g, '');

    // MathJax 不支持 eqnarray（LaTeX 也已废弃）：转成 aligned，并归一 &=& 写法
    if (/\\begin\{(eqnarray|eqnarray\*)\}/.test(s)) {
      s = s.replace(/\\begin\{eqnarray\*?\}/g, '\\begin{aligned}');
      s = s.replace(/\\end\{eqnarray\*?\}/g, '\\end{aligned}');
      s = s.replace(/&\s*=\s*&/g, '&=');
      s = s.replace(/&\s*&\s*/g, '&');
      s = s.replace(/\\nonumber\b/g, '').replace(/\\notag\b/g, '');
    }

    // 包自带但 MathJax 没有的符号：换等价写法
    s = s.replace(/\\openone\b/g, '\\mathbb{1}');
    s = s.replace(/\\fatsemi\b/g, '\\mathrel{;}');
    s = s.replace(/\\openmbox\s*\{([^{}]*)\}/g, '\\text{$1}');
    // beamer 覆层宏：\only<2>{x}、\alt{A}{B}、\pause — 只保留内容
    s = s.replace(/\\alt\s*\{([^{}]*)\}\s*\{[^{}]*\}/g, '{$1}');
    s = s.replace(/\\(?:only|uncover|visible|invisible|onslide|alert|structure|action)\s*(?:<[^>]*>)?\s*/g, '');
    s = s.replace(/\\pause\b\s*(?:<[^>]*>)?/g, '');

    // 文本模式的命令跑进数学里时（宏展开常见），MathJax 认不出，直接剥掉。
    // 这是一份有界的“文本命令”清单，不是去穷举数学命令。
    var TEXT_ONLY = ['hbox', 'mbox', 'fbox', 'bfseries', 'itshape', 'ttfamily', 'normalfont',
      'rmfamily', 'sffamily', 'upshape', 'mdseries', 'slshape', 'scshape',
      'normalsize', 'small', 'footnotesize', 'scriptsize', 'tiny', 'large',
      'Large', 'LARGE', 'huge', 'Huge', 'noindent', 'par', 'hfill', 'vfill',
      'centering', 'label', 'index', 'vspace', 'hspace', 'rule', 'parbox', 'makebox'];
    for (var ti = 0; ti < TEXT_ONLY.length; ti++) {
      var nm = TEXT_ONLY[ti];
      s = s.replace(new RegExp('\\\\' + nm + '\\s*\\{[^{}]*\\}', 'g'), '');
      s = s.replace(new RegExp('\\\\' + nm + '\\b', 'g'), '');
    }
    return s;
  }

  // MathJax 原生支持的常用数学命令（白名单）。
  // 不在表里、文档里也没定义的宏：去掉命令、保留 {参数}，避免整条公式报红。
  var MATH_SAFE = {};
  (function () {
    var names = ('frac dfrac tfrac sqrt root sum prod coprod int oint iint iiint lim limsup liminf ' +
      'log ln exp sin cos tan cot sec csc arcsin arccos arctan sinh cosh tanh ' +
      'max min sup inf det gcd deg dim ker hom arg mod bmod pmod ' +
      'mathbf mathrm mathit mathcal mathbb mathfrak mathsf mathtt mathnormal boldsymbol bm ' +
      'text textbf textit textrm textsf texttt mbox hbox operatorname ' +
      'left right middle big Big bigg Bigg bigl bigr Bigl Bigr ' +
      'vec hat bar tilde dot ddot overline underline overrightarrow overleftarrow ' +
      'underbrace overbrace overparen widehat widetilde stackrel overset underset ' +
      'binom choose dbinom tbinom above atop genfrac ' +
      'cdots ldots dots vdots ddots dotsb dotsc dotsi dotsm dotso ' +
      'times cdot div pm mp ast star circ bullet oplus ominus otimes oslash odot ' +
      'leq le geq ge neq ne approx sim simeq cong equiv propto ll gg ' +
      'in notin ni subset supset subseteq supseteq cup cap setminus emptyset varnothing forall exists nexists ' +
      'partial nabla infty aleph hbar ell wp Re Im angle triangle square ' +
      'to rightarrow leftarrow Rightarrow Leftarrow leftrightarrow Leftrightarrow longrightarrow Longrightarrow ' +
      'mapsto longmapsto hookrightarrow rightharpoonup rightleftharpoons uparrow downarrow Uparrow Downarrow ' +
      'quad qquad hspace vspace kern mkern mskip hskip ' +
      'displaystyle textstyle scriptstyle scriptscriptstyle limits nolimits ' +
      'begin end tag nonumber notag hline cr label ref eqref ' +
      'sinh cosh tanh operatorname arg deg exp log ' +
      'alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi varpi rho varrho ' +
      'sigma varsigma tau upsilon phi varphi chi psi omega ' +
      'Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega ' +
      'vert Vert lvert rvert lVert rVert mid nmid setminus backslash ' +
      'lgroup rgroup lmoustache rmoustache arrowvert Arrowvert bracevert ' +
      'lbrack rbrack ulcorner urcorner llcorner lrcorner ' +
      'aleph beth gimel hbar imath jmath wp ell Re Im partial nabla infty ' +
      'langle rangle lfloor rfloor lceil rceil lbrace rbrace ' +
      'uparrow downarrow Uparrow Downarrow updownarrow nearrow searrow swarrow nwarrow ' +
      'oplus ominus otimes oslash odot bigoplus bigotimes bigodot ' +
      'sqcup sqcap bigsqcup bigcap bigcup ' +
      '').split(/\s+/);
    for (var i = 0; i < names.length; i++) if (names[i]) MATH_SAFE[names[i]] = 1;
  })();

  function stripUnknownMath(s) {
    var out = '', i = 0, guard = 0;
    while (i < s.length && guard++ < 200000) {
      if (s[i] !== '\\') { out += s[i]; i++; continue; }

      var nm = /^[A-Za-z@]+/.exec(s.slice(i + 1));
      if (!nm) { out += s.slice(i, i + 2); i += 2; continue; }   // 单字符命令

      var name = nm[0];
      var j = i + 1 + name.length;

      // 吃掉 <overlay> 与 [可选参数]
      var ov = /^\s*<[^>]*>/.exec(s.slice(j));
      if (ov) j += ov[0].length;
      var og = readOptional(s, j);
      while (og) { j = og.end; og = readOptional(s, j); }

      if (MATH_SAFE[name]) { out += s.slice(i, j); i = j; continue; }

      // 未知宏：保留花括号内容，丢掉命令名（内容比红字有用）
      var g = readGroup(s, j);
      if (g) { out += '{' + stripUnknownMath(g.text) + '}'; i = g.end; continue; }
      i = j;
    }
    return out;
  }

  function mathInline(tex, ctx) {
    // 代码上下文里数学不排版：MathJax 按配置跳过 <code>，建节点只会被误判成“渲染失败”
    if (ctx && ctx.inCode) return esc(String(tex).trim());
    if (DIAGRAM_ENGINE.test(tex)) return diagramAsCode(tex, ctx);
    return '<span class="math math-inline" data-tex="' + escAttr(tex) +
      '">\\(' + esc(stripUnknownMath(expandMathMacros(sanitizeMath(tex), ctx))) + '\\)</span>';
  }

  function mathDisplay(tex, cls, ctx, tagNo) {
    if (ctx && ctx.inCode) return esc(String(tex).trim());
    if (DIAGRAM_ENGINE.test(tex)) return diagramAsCode(tex, ctx);
    var body = stripUnknownMath(expandMathMacros(sanitizeMath(tex), ctx));
    return '<div class="math math-display' + (cls ? ' ' + cls : '') + '" data-tex="' +
      escAttr(tex) + '">\\[' + esc(body) + (tagNo ? '\\tag{' + tagNo + '}' : '') + '\\]</div>';
  }

  /* ------------------------------------------------------------------ */
  /* 3. 行内渲染（字符游标，支持递归）                                   */
  /* ------------------------------------------------------------------ */

  // 提示气泡里用“渲染后的纯文本”，不要把原始 LaTeX 塞进去（否则会漏出 \texttt{\textbackslash ...}）
  function plainText(html) {
    return String(html || '')
      .replace(/<[^>]*>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ').trim();
  }

  function renderInline(text, ctx) {
    if (text == null) return '';
    var out = '', i = 0, n = text.length;
    while (i < n) {
      var c = text[i];

      // ---- 反斜杠：命令 / 数学定界 ----
      if (c === '\\') {
        var nx = text[i + 1];

        if (nx === '(') {                       // \( … \)
          var e1 = text.indexOf('\\)', i + 2);
          if (e1 > i) { ctx.math++; out += mathInline(text.substring(i + 2, e1), ctx); i = e1 + 2; continue; }
        }
        if (nx === '[') {                       // \[ … \]
          var e2 = text.indexOf('\\]', i + 2);
          if (e2 > i) { ctx.math++; out += mathDisplay(text.substring(i + 2, e2), null, ctx); i = e2 + 2; continue; }
        }
        if (nx === '\\') {                      // \\ 换行（可带 [2.5ex] 间距）
          i += 2;
          if (text[i] === '*') i++;          // \\* 形式：星号在 [..] 之前
          var brOpt = readOptional(text, i);
          if (brOpt) i = brOpt.end;
          out += '<br />';
          continue;
        }
        if (nx === '*') { i += 2; continue; }   // 少数宏的星号残片

        var m = /^[A-Za-z@]+/.exec(text.substring(i + 1));
        if (m) {
          var name = m[0];
          var r = command(text, i + 1 + name.length, name, ctx);
          out += r.html;
          i = r.end;
          continue;
        }

        // 重音（\'e \"o \~n 这类单字符命令）
        var ach = text[i + 1];
        if (ach && (ach === "'" || ach === '"' || ach === '^' || ach === '~' || ach === '=' || ach === '.')) {
          var ai = i + 2;
          var ag2 = readGroup(text, ai);
          var letter2 = ag2 ? ag2.text : text.charAt(ai);
          if (ag2) { ai = ag2.end; }
          else if (letter2 && /[A-Za-z]/.test(letter2)) { ai++; }
          else if (ach === '~') { out += '&nbsp;'; i += 2; continue; }
          else if (ach === '^' || ach === '=') { out += ' '; i += 2; continue; }
          else { i += 2; continue; }
          out += esc(applyAccent(letter2, ACCENTS[ach]));
          i = ai;
          continue;
        }

        // 单字符命令
        var ch = text[i + 1];
        if (ch === undefined) { i++; continue; }
        if (Object.prototype.hasOwnProperty.call(CHAR_SYMBOLS, ch)) {
          out += CHAR_SYMBOLS[ch];
          i += 2;
          continue;
        }
        if (ch === '~') { out += '&nbsp;'; i += 2; continue; }
        out += esc(ch); i += 2; continue;
      }

      // ---- 数学 ----
      if (c === '$') {
        if (text[i + 1] === '$') {
          var e3 = text.indexOf('$$', i + 2);
          if (e3 > i) { ctx.math++; out += mathDisplay(text.substring(i + 2, e3), null, ctx); i = e3 + 2; continue; }
          out += '$$'; i += 2; continue;
        }
        var e4 = findDollarClose(text, i + 1);
        if (e4 > i) {
          ctx.math++;
          out += mathInline(text.substring(i + 1, e4), ctx);
          i = e4 + 1;
          continue;
        }
        out += '$'; i++; continue;
      }

      // 转义字符（\_ \& \% \# \{ \} \-）在正文里就是字符本身
      if (c === '\\') {
        var escCh = text[i + 1];
        if (escCh && '_&%#${}'.indexOf(escCh) >= 0) { out += esc(escCh); i += 2; continue; }
        if (escCh === '-' || escCh === '/') { i += 2; continue; }
      }

      // 花括号 = 分组：组内的字号/字重/颜色要真的生效（不是简单丢弃）
      if (c === '{') {
        var grp = readGroup(text, i);
        if (grp) { out += renderGroup(grp.text, ctx); i = grp.end; continue; }
        i++; continue;
      }
      if (c === '}') { i++; continue; }

      // ---- 其它字符 ----
      if (c === '~') { out += '&nbsp;'; i++; continue; }
      if (c === '`') {
        if (text[i + 1] === '`') { out += '“'; i += 2; continue; }
        out += '‘'; i++; continue;
      }
      if (c === "'") {
        if (text[i + 1] === "'") { out += '”'; i += 2; continue; }
        out += '’'; i++; continue;
      }
      if (c === '-') {
        if (text[i + 1] === '-' && text[i + 2] === '-') { out += '—'; i += 3; continue; }
        if (text[i + 1] === '-') { out += '–'; i += 2; continue; }
      }
      if (c === '<') { out += '&lt;'; i++; continue; }
      if (c === '>') { out += '&gt;'; i++; continue; }
      if (c === '&') { out += '&amp;'; i++; continue; }
      if (c === '\n') { out += ' '; i++; continue; }

      out += c; i++;
    }
    return out;
  }

  // 找 $…$ 的闭合位置（跳过 \$ 与内部 \\）
  function findDollarClose(text, from) {
    var i = from;
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i] === '$') return i;
      if (text[i] === '\n' && text[i + 1] === '\n') return -1; // 不跨空行
      i++;
    }
    return -1;
  }

  /* ------------------------------------------------------------------ */
  /* 4. 命令分派                                                         */
  /* ------------------------------------------------------------------ */

  // ---- 分组与样式：{\bfseries 粗} {\huge 大} {\color{red} 红} ----
  var FONT_STYLE = {
    bfseries: 'fw', bf: 'fw', mdseries: '', itshape: 'it', it: 'it', slshape: 'it',
    scshape: 'sc', ttfamily: 'tt', sffamily: 'sf', rmfamily: '',
    heiti: 'fw', songti: '', kaishu: 'it', fangsong: '', lishu: 'it', youyuan: 'sf',
    upshape: '', normalfont: ''
  };
  var FONT_SIZE = {
    tiny: 'sz-tiny', scriptsize: 'sz-script', footnotesize: 'sz-foot', small: 'sz-small',
    normalsize: '', large: 'sz-large', Large: 'sz-large2', LARGE: 'sz-large3',
    huge: 'sz-huge', Huge: 'sz-huge2', smaller: 'sz-smaller', larger: 'sz-larger'
  };
  var COLOR_NAMES = {
    red: '#d9534f', blue: '#2f6fbf', green: '#3c8c4a', black: 'inherit',
    white: '#ffffff', gray: '#8a8a8a', grey: '#8a8a8a', orange: '#d9822b',
    purple: '#7b52ab', brown: '#8b5a2b', cyan: '#2aa1af', magenta: '#b0308f',
    yellow: '#c8a415', darkgray: '#555555', lightgray: '#b5b5b5'
  };

  function fmtCounter(n, kind) {
    n = Math.max(0, n | 0);
    if (kind === 'arabic' || kind === 'value') return String(n);
    if (kind === 'roman') return toRoman(n).toLowerCase();
    if (kind === 'Roman') return toRoman(n);
    if (kind === 'alph' || kind === 'Alph') {
      var base = kind === 'alph' ? 97 : 65;
      var idx = (((n - 1) % 26) + 26) % 26;
      return String.fromCharCode(base + idx).repeat(Math.floor((Math.max(n, 1) - 1) / 26) + 1);
    }
    if (kind === 'fnsymbol') return ['*', '\u2020', '\u2021', '\u00a7', '\u00b6', '\u2016', '**', '\u2020\u2020', '\u2021\u2021'][Math.min(n, 9) - 1] || String(n);
    return String(n);
  }
  function toRoman(n) {
    if (n <= 0) return '';
    var map = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
    var out = '';
    for (var i = 0; i < map.length; i++) while (n >= map[i][0]) { out += map[i][1]; n -= map[i][0]; }
    return out;
  }
  var ACCENTS = {
    "'": '\u0301', '^': '\u0302', '"': '\u0308', '~': '\u0303',
    '=': '\u0304', '.': '\u0307', 'u': '\u0306', 'v': '\u030C',
    'H': '\u030B', 'c': '\u0327', 'd': '\u0323', 'b': '\u0331',
    'r': '\u030A', 'k': '\u0328', 't': '\u0361'
  };
  function applyAccent(letter, comb) {
    var base = String(letter || '').trim().charAt(0);
    if (!base) return '';
    return (base + comb).normalize('NFC');
  }

  function cssColor(name) {
    var n = String(name || '').trim().toLowerCase();
    if (COLOR_NAMES[n]) return COLOR_NAMES[n];
    if (/^#[0-9a-f]{3,8}$/.test(n)) return n;
    if (/^rgb/.test(n)) return n;
    return null;
  }

  // 解析一个 {} 组：先吃掉组首的样式命令（字号/字重/颜色），再渲染剩余内容
  function renderGroup(inner, ctx) {
    var s = inner, styles = [], size = null, color = null, guard = 0;

    while (guard++ < 24) {
      var m = /^\s*\\([A-Za-z@]+)\s*/.exec(s);
      if (!m) break;
      var nm = m[1];

      if (Object.prototype.hasOwnProperty.call(FONT_STYLE, nm)) {
        if (FONT_STYLE[nm]) styles.push(FONT_STYLE[nm]);
        s = s.slice(m[0].length);
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(FONT_SIZE, nm)) {
        size = FONT_SIZE[nm] || null;
        s = s.slice(m[0].length);
        continue;
      }
      if (nm === 'color') {
        var cg = readGroup(s, m[0].length);
        if (!cg) break;
        var cc = cssColor(cg.text);
        if (cc) color = cc;
        s = s.slice(cg.end);
        continue;
      }
      break;
    }

    var html = renderInline(s, ctx);
    if (size) html = '<span class="' + size + '">' + html + '</span>';
    if (styles.length) html = '<span class="' + styles.join(' ') + '">' + html + '</span>';
    if (color) html = '<span style="color:' + color + '">' + html + '</span>';
    return html;
  }

  function command(text, i, name, ctx) {
    var start = i;

    // 星号变体（\vspace*{1}、\hspace*{2em}）：不吞掉会漏出 "*{1}" 这种残片
    if (text[i] === '*') i++;

    // beamer 覆层参数：\only<2->{x}、\alert<1>{y} —— <...> 不能漏进正文
    var ovl = /^\s*<[^>]*>/.exec(text.slice(i));
    if (ovl) i += ovl[0].length;

    // TeX 规则：控制词后的一个空格被吞掉。代码上下文里必须执行，
    // 否则 \texttt{\textbackslash footnote} 会显示成 “\ footnote”（多一个空格）。
    if (ctx.inCode && text[i] === ' ') i++;

    function opt() {
      var r = readOptional(text, i);
      if (r) { i = r.end; return r.text; }
      return null;
    }

    function arg() {
      var r = readGroup(text, i);
      if (r) { i = r.end; return r.text; }
      return null;
    }

    // TeX 定界参数：\Url|addr| 这种写法（url 宏包）；先于 done 定义以便各处调用
    function delim() {
      var c = text[i];
      if (!c || /[\s{\[]/.test(c) || !/[|!@*\/+=]/.test(c)) return null;
      var closeAt = text.indexOf(c, i + 1);
      if (closeAt < 0 || closeAt - i > 400) return null;
      var v = text.slice(i + 1, closeAt);
      i = closeAt + 1;
      return v;
    }

    function done(html) { return { html: html, end: i }; }

    // ---- 引用：数字型 [1,2] / natbib 作者-年 (Author, 1984)、Author (1984) ----
    if (/^(?:no)?cite[a-zA-Z]*$|^(?:par|text|auto|foot|super|smart|vol|not)cite[a-zA-Z]*$|^Cite[a-zA-Z]*$/.test(name)) {
      var preNote = readOptional(text, i); if (preNote) i = preNote.end;
      var postNote = readOptional(text, i); if (postNote) i = postNote.end;
      var cg = readGroup(text, i);
      if (!cg) return done('');
      i = cg.end;
      var citeKeys = cg.text.split(',').map(function (k) { return k.trim(); }).filter(Boolean);
      var lower = name.toLowerCase();

      var metas = citeKeys.map(function (k) { return ctx.bibLabels[k]; });
      if (metas.length && metas.every(Boolean)) {
        var body;
        if (/^citeyear/.test(lower)) {
          body = metas.map(function (m) { return esc(m.year); }).join(', ');
        } else if (/^citeauthor$/.test(lower)) {
          body = metas.map(function (m) { return esc(m.author); }).join('; ');
        } else if (/^(?:citet|textcite)$/.test(lower)) {
          body = metas.map(function (m) { return esc(m.author) + ' (' + esc(m.year) + ')'; }).join('; ');
        } else if (/^citealp$/.test(lower)) {
          body = metas.map(function (m) { return esc(m.author) + ', ' + esc(m.year); }).join('; ');
        } else {
          body = '(' + metas.map(function (m) { return esc(m.author) + ', ' + esc(m.year); }).join('; ') + ')';
        }
        return done('<span class="cite cite-ay">' + body + '</span>');
      }

      var citeNums = citeKeys.map(function (k) {
        var n = ctx.bibIndex[k];
        if (n === undefined && /^[0-9]+$/.test(k)) n = k;
        return n === undefined ? k : String(n);
      }).filter(Boolean);
      return done('<span class="cite">[' + citeNums.join(',') + ']</span>');
    }


    // ---- 计数器 ----
    if (name === 'newcounter') {
      var ncName = readGroup(text, i); if (!ncName) return done('');
      i = ncName.end;
      var ncParent = readOptional(text, i); if (ncParent) i = ncParent.end;
      if (ctx.counterStore[ncName.text.trim()] === undefined) ctx.counterStore[ncName.text.trim()] = 0;
      return done('');
    }
    if (name === 'setcounter' || name === 'addtocounter') {
      var scName = readGroup(text, i); if (!scName) return done('');
      i = scName.end;
      var scVal = readGroup(text, i); if (!scVal) return done('');
      i = scVal.end;
      var ck = scName.text.trim();
      var nv = parseInt(String(scVal.text).trim(), 10); if (isNaN(nv)) nv = 0;
      ctx.counterStore[ck] = (name === 'setcounter') ? nv : (ctx.counterStore[ck] || 0) + nv;
      return done('');
    }
    if (/^(arabic|roman|Roman|alph|Alph|fnsymbol|value)$/.test(name)) {
      var cv = readGroup(text, i); if (!cv) return done('');
      i = cv.end;
      return done(fmtCounter(ctx.counterStore[cv.text.trim()] || 0, name));
    }

    // ---- 字母重音（\c{c} \u{a} 等）----
    if (ACCENTS[name]) {
      var ag = readGroup(text, i);
      var letter = ag ? ag.text : (text.charAt(i) || '');
      if (ag) i = ag.end; else if (letter) i++;
      return done(applyAccent(letter, ACCENTS[name]));
    }

    // ---- 删除线/下划线（ulem）----
    if (name === 'sout' || name === 'xout' || name === 'st') {
      var sg = readGroup(text, i); if (!sg) return done('');
      i = sg.end;
      return done('<del>' + renderInline(sg.text, ctx) + '</del>');
    }
    if (name === 'uline' || name === 'uuline') {
      var ug2 = readGroup(text, i); if (!ug2) return done('');
      i = ug2.end;
      return done('<u>' + renderInline(ug2.text, ctx) + '</u>');
    }

    // ---- 致谢 ----
    if (name === 'thanks') {
      var tg = readGroup(text, i); if (!tg) return done('');
      i = tg.end;
      return done(marginAside(renderInline(tg.text, ctx), ctx));
    }

// 尺寸命令要产生可见宽度/高度，不能被“无输出参数”静默吞掉
      if ((SILENT_MACROS[name] || NO_OUTPUT_ARGS[name]) && !/^(hspace|vspace|kern|hskip|setlength)$/.test(name)) {
      // 先吃掉 [可选参数]，再吃掉已知个数的 {必选参数}
      while (opt() !== null) { /* 可选参数 */ }
      var need = NO_OUTPUT_ARGS[name] || 0;
      for (var si = 0; si < need; si++) { arg(); }
      return done('');
    }

    // 带参宏：\doccmd{...} 这类在正文里也要展开，否则参数内容会被当字面量
    if (ctx.macros && Object.prototype.hasOwnProperty.call(ctx.macros, name)) {
      var dp = ctx.macros[name];
      if (dp && dp.n > 0) {
        var callArgs = [], okArgs = true, jArg = i;
        for (var ai = 0; ai < dp.n; ai++) {
          // TeX 定界参数：\def\mailto|#1| 的调用写作 \mailto|url|，先按定界符取参
          var dc = text[jArg];
          if (dc && !/[\s{\[]/.test(dc) && /[|!@*\/+=]/.test(dc)) {
            var closeAt = text.indexOf(dc, jArg + 1);
            if (closeAt > 0 && closeAt - jArg < 400) {
              callArgs.push(text.slice(jArg + 1, closeAt));
              jArg = closeAt + 1;
              continue;
            }
          }
          var ga = readGroup(text, jArg);
          if (!ga) { okArgs = false; break; }
          callArgs.push(ga.text);
          jArg = ga.end;
        }
        if (okArgs) {
          i = jArg;
          // TeX 是词法级替换：\textbackslash#1 必须变成 \textbackslash{}sidenote，而不是粘成 \textbackslashsidenote
          var bodyT = substParams(dp.body, callArgs);
          return done(renderInline(bodyT, ctx));
        }
      }
    }

    // 文档里定义过的零参宏：就地展开（不依赖预展开通道，避免“定义了却仍算未知”）
    if (ctx.macros && Object.prototype.hasOwnProperty.call(ctx.macros, name)) {
      var def0 = ctx.macros[name];
      if (def0 && def0.n === 0) {
        ctx.macroDepth = (ctx.macroDepth || 0) + 1;
        if (ctx.macroDepth < 12) {
          var expanded0 = String(def0.body);
          ctx.macroDepth--;
          return done(renderInline(expanded0, ctx));
        }
        ctx.macroDepth--;
        return done('');
      }
    }

    switch (name) {
      /* ---- 字体与格式 ---- */
      /* TeX 原始命令：\accent"7F<字母>。重音符号本身不显示，保留被加注字符 */
      case 'accent': {
        var acc = /^\s*"[0-9A-Fa-f]{1,4}/.exec(text.slice(i));
        if (acc) { i += acc[0].length; return done(''); }
        if (text[i]) i++;            // 单个字符形式：\accent~e
        return done('');
      }
      case 'textbf': case 'bfseries': {
        var t = arg();
        return done(t == null ? '' : '<strong>' + renderInline(t, ctx) + '</strong>');
      }
      case 'textit': case 'emph': case 'itshape': case 'slshape': case 'textsl': {
        var em = arg();
        return done(em == null ? '' : '<em>' + renderInline(em, ctx) + '</em>');
      }
      case 'texttt': case 'ttfamily': case 'lstinline': {
        var tt = arg();
        if (tt == null) return done('');
        // \texttt 里的内容是“文本”：展开宏、还原转义（\verb 才保持字面量）。
        // 同时标记“代码上下文”：里面出现的未知命令要原样显示（\alpha 就该显示成 \alpha）。
        ctx.inCode = (ctx.inCode || 0) + 1;
        var ttHtml;
        try { ttHtml = renderInline(tt, ctx); } finally { ctx.inCode--; }
        return done('<code class="tt">' + ttHtml + '</code>');
      }
      case 'textsf': case 'sffamily': {
        var sf = arg();
        return done(sf == null ? '' : '<span class="sans">' + renderInline(sf, ctx) + '</span>');
      }
      case 'textrm': case 'rmfamily': {
        var rm = arg();
        return done(rm == null ? '' : '<span class="serif">' + renderInline(rm, ctx) + '</span>');
      }
      case 'textsc': case 'scshape': {
        var sc = arg();
        return done(sc == null ? '' : '<span class="smallcaps">' + renderInline(sc, ctx) + '</span>');
      }
        case 'underline': case 'uline': {
          var ul = arg();
          if (ul == null) return done('');
          var onlySpace = /^\s*\\hspace\s*\{([^}]+)\}\s*$/.exec(ul);
          if (onlySpace) {
            return done('<span class="blank" style="display:inline-block;width:' + onlySpace[1] + ';border-bottom:1px solid currentColor;"></span>');
          }
          return done('<u>' + renderInline(ul, ctx) + '</u>');
        }
      case 'textsuperscript': {
        var sup = arg();
        return done(sup == null ? '' : '<sup>' + renderInline(sup, ctx) + '</sup>');
      }
      case 'textsubscript': {
        var sub = arg();
        return done(sub == null ? '' : '<sub>' + renderInline(sub, ctx) + '</sub>');
      }
      case 'textnormal': {
        var tn = arg();
        return done(tn == null ? '' : renderInline(tn, ctx));
      }
      case 'uppercase': {
        var up = arg();
        return done(up == null ? '' : esc(up.toUpperCase()));
      }
      case 'lowercase': {
        var lo = arg();
        return done(lo == null ? '' : esc(lo.toLowerCase()));
      }
      case 'textcolor': case 'colorbox': case 'fcolorbox': {
        // \textcolor{c}{文本} / \colorbox{c}{文本} / \fcolorbox[frame]{bg}{文本}
        if (name === 'fcolorbox') opt();
        var colorName = arg();
        var colorBody = arg();
        if (colorBody == null) return done('');
        var css = cssColor(colorName);
        var attr = name === 'textcolor' ? 'color' : 'background';
        var colored = renderInline(colorBody, ctx);
        return done(css ? '<span style="' + attr + ':' + css + '">' + colored + '</span>' : colored);
      }
      case 'emph2': return done('');

      /* ---- 链接 / 引用 ---- */
      case 'href': case 'hyperlink': {
        var url = arg(); var label = arg();
        if (url == null) return done('');
        if (label == null) label = url;
        return done('<a class="ext" href="' + escAttr(url) + '">' + renderInline(label, ctx) + '</a>');
      }
      case 'url': case 'nolinkurl': case 'Url': case 'path': {
        var u = arg() || delim();
        if (u == null) return done('');
        if (name === 'Url') return done('<code>' + esc(u) + '</code>');
        return done('<a class="ext" href="' + escAttr(u) + '">' + esc(u) + '</a>');
      }
      case 'eqref': {
        var ek = arg();
        if (ek == null) return done('');
        return done('<span class="xref" data-key="' + escAttr(ek.trim()) + '" data-paren="1"></span>');
      }
      case 'ref': case 'autoref': case 'pageref': case 'cref': case 'Cref': {
        var key = arg();
        if (key == null) return done('');
        return done('<span class="xref" data-key="' + escAttr(key.trim()) + '" data-paren="0"></span>');
      }
      case 'label': {
        var lbl = arg();
        return done('<span class="anchor" data-label="' + escAttr(lbl || '') + '"></span>');
      }
      case 'footnote': case 'footnotetext': {
        var fn = arg();
        if (fn == null) return done('');
        if (/tufte/.test(ctx.docClass)) {   // tufte 的语义：脚注即页边注
          return done(marginAside(renderInline(fn, ctx), ctx));
        }
        var id = 'fn' + (ctx.fn = (ctx.fn || 0) + 1);
        var fnHtml = renderInline(fn, ctx);
        ctx.footnotes.push({ id: id, html: fnHtml });
        return done('<sup class="fnref" title="' + escAttr(plainText(fnHtml)) +
          '"><a href="#' + id + '">' + ctx.fn + '</a></sup>');
      }
      case 'thanks': {
        var th = arg();
        if (th == null) return done('');
        return done(marginAside(renderInline(th, ctx), ctx));
      }
      // 页边注：作者意图是放到页边（tufte），不是插进正文句子中间
      case 'marginpar': case 'sidenote': case 'marginnote': {
        var side = arg();
        if (side == null) return done('');
        return done(marginAside(renderInline(side, ctx), ctx));
      }

      /* ---- 图片 ---- */
      case 'includegraphics': {
        var gopt = opt();
        var gpath = arg();
        if (gpath == null) return done('');
        return done(imageHtml(gpath, gopt, ctx));
      }

      /* ---- 杂项 ---- */
      case 'LaTeX': return done(TEXT_SYMBOLS.LaTeX);
      case 'TeX': return done(TEXT_SYMBOLS.TeX);
      case 'BibTeX': return done(TEXT_SYMBOLS.BibTeX);
      case 'today': return done(today());
      case 'quad': return done('\u2003');
      case 'qquad': return done('\u2003\u2003');
      case 'verb': {
        var delim = text[i];
        if (!delim) return done('');
        var close = text.indexOf(delim, i + 1);
        if (close < 0) return done('');
        var v = text.substring(i + 1, close);
        i = close + 1;
        return done('<code class="tt">' + esc(v) + '</code>');
      }
      case 'rule': opt(); arg(); arg(); return done('');

      // fancyvrb 的行内等宽：\Verb|...| / \Verb[opts]|...|
      case 'Verb': {
        while (opt() !== null) { /* 吃掉 [formatcom=...] 之类 */ }
        var vd2 = text[i];
        if (!vd2) return done('');
        var ve2 = text.indexOf(vd2, i + 1);
        if (ve2 < 0) { i++; return done(''); }
        var code2 = unescapeLatex(text.substring(i + 1, ve2));
        i = ve2 + 1;
        return { html: '<code>' + esc(code2) + '</code>', end: i };
      }

      case 'LaTeXe': return done('LaTeX2e');

      // beamer 的帧标题：当作三级标题渲染（这一条对幻灯片类文档观感影响很大）
      case 'frametitle': case 'framesubtitle': {
        var ft = arg();
        if (!ft) return done('');
        var cls = name === 'frametitle' ? 'frame-title' : 'frame-subtitle';
        return done('<div class="' + cls + '">' + renderInline(ft, ctx) + '</div>');
      }

      // \ensuremath{x}：正文里就是 x
      case 'ensuremath': {
        var ee = arg();
        return done(ee ? mathInline(ee, ctx) : '');
      }

      // 单位：\unit{m/s} 或 siunitx 的 \si{...}
      case 'unit': case 'si': {
        var un = arg();
        return done(un ? '<span class="unit">' + esc(un) + '</span>' : '');
      }

      // 盒子：\makebox[w][a]{x} \parbox[w][a]{x} — 保留文本内容即可
      case 'makebox': case 'parbox': case 'mbox': case 'framebox': case 'fbox': {
        opt(); opt();
        var boxBody = arg();
        if (boxBody == null) boxBody = arg();
        return done(boxBody ? renderInline(boxBody, ctx) : '');
      }

      // \char`\\ 这类写法（lshort 的 \cmd 定义用到）：输出对应字符
      case 'char': {
        var s2 = text.slice(i);
        var cm = /^\s*`\s*(\\.|[^\\])/.exec(s2);
        if (!cm) return done('');
        i += cm[0].length;
        var ch2 = cm[1];
        if (ch2 === '\\\\') return done('\\');
        if (ch2 === '\\%') return done('%');
        return done(esc(ch2));
      }

      // 表格线：表格内部由 renderTable 处理，这里兜住单元格里的残留
      case 'hline': case 'midrule': case 'toprule': case 'bottomrule':
        return done('<span class="trule"></span>');
      case 'cline': arg(); return done('<span class="trule"></span>');

      // lshort 的包链接宏：文字就是包名，用代码样式呈现
      case 'CTAN': {
        var pk = arg();
        return done(pk ? '<code>' + esc(pk) + '</code>' : '');
      }

      // 数学尖括号在文本里出现时，给真字符而不是消失
      // lshort 的 \CTEX{...}：显示后缀名即可
      case 'CTEX': {
        var cx = arg();
        return done(cx ? '<code>' + esc(cx) + '</code>' : '');
      }

      // \lipsum[n]：占位段落（总比留个未识别宏好）
      case 'lipsum': {
        var lc = opt() || '1';
        var lk = Math.max(1, Math.min(5, parseInt(lc, 10) || 1));
        var lp = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod ' +
          'tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis ' +
          'nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.';
        var lb = '';
        for (var li = 0; li < lk; li++) lb += '<p>' + lp + '</p>';
        return done(lb);
      }

      // \string\foo：TeX 里输出命令名字符
      case 'string': {
        var sm = /^\s*\\([A-Za-z@]+)/.exec(text.slice(i));
        if (!sm) return done('');
        i += sm[0].length;
        return done(esc(sm[1]));
      }

      case 'langle': return done('⟨');
      case 'rangle': return done('⟩');

      // \rlap/\llap/\clap：只保留内容
      case 'rlap': case 'llap': case 'clap': case 'smash': {
        var g2 = arg();
        return done(g2 ? renderInline(g2.text, ctx) : '');
      }

      // 计数器的“展示形式”：\the、\year、\month
      case 'the': { while (opt() !== null) { } return done(''); }
      case 'year': return done(String(new Date().getFullYear()));
      case 'month': return done(String(new Date().getMonth() + 1));
        case 'hspace': case 'vspace': case 'kern': case 'hskip': {
          var hg = readGroup(text, i);
          if (!hg) return done('');
          i = hg.end;
          var len = String(hg.text).trim();
          if (!/^-?\d+(\.\d+)?\s*(cm|mm|pt|em|ex|in|bp|pc)?$/.test(len)) return done('');
          if (name === 'vspace' || name === 'kern') return done('<span class="vspace" style="display:block;height:' + len + '"></span>');
          return done('<span class="hspace" style="display:inline-block;width:' + len + '"></span>');
        }
        case 'setlength': arg(); arg(); return done('');
      case 'begin': case 'end': {
        // 行内出现环境标记（如“空列表/空表格”这种写法）直接丢掉，不产生噪音
        arg();
        ctx.inlineEnvMarks = (ctx.inlineEnvMarks || 0) + 1;
        return done('');
      }
      case 'item': return done('');
      case 'newline': case 'linebreak': case 'par':
        return done('<br />');
      case 'and': return done('、');
      case 'ldots': case 'dots': return done('…');
      case 'textbackslash': return done('\\');
      case 'textendash': return done('–');
      case 'textemdash': return done('—');
      case 'space': return done(' ');
    }

    // 文本符号表
    if (Object.prototype.hasOwnProperty.call(TEXT_SYMBOLS, name)) {
      var v2 = TEXT_SYMBOLS[name];
      if (v2 === null) return done(today());
      return done(v2);
    }

    // ---- 用户自定义宏（\newcommand / \def）展开 ----
    if (Object.prototype.hasOwnProperty.call(ctx.macros, name)) {
      var def = ctx.macros[name];
      var args = [], gi2;
      var needArgs = def.n || 0;
      if (needArgs > 0 && def.opt != null) {
        var optArg = readOptional(text, i);
        if (optArg) { args.push(optArg.text); i = optArg.end; }
        else if (def.opt !== '') args.push(def.opt);
        needArgs--;
      }
      for (var ai = 0; ai < needArgs; ai++) {
        gi2 = readGroup(text, i);
        if (!gi2) break;
        args.push(gi2.text);
        i = gi2.end;
      }
      if (ctx.macroDepth >= 8) return done('');   // 防递归
      ctx.macroDepth++;
      var expanded = substParams(def.body, args);
      var outHtml = renderInline(expanded, ctx);
      ctx.macroDepth--;
      return done(outHtml);
    }

    // ---- 尺寸宏：\textwidth 之类不该算“未知命令” ----
    if (DIMENSION_NAMES[name]) {
      if (DIMENSION_NAMES[name] === 'hr') return done('<hr class="rule" />');
      return done('');
    }

    // 未知命令：有花括号参数就保留参数内容，否则丢弃（只记类别，不刷屏）
    var g = readGroup(text, i);
    if (g) { i = g.end; return done(renderInline(g.text, ctx)); }
    // 连定义关键字本身都漏到正文里（\def 没被清理）：把 \name 与 {body} 一起吃掉
    if (name === 'def' || name === 'gdef' || name === 'edef' || name === 'xdef') {
      var dm = /^\s*\\[A-Za-z@]+/.exec(text.slice(i));
      if (dm) i += dm[0].length;
      for (var dg = 0; dg < 4; dg++) { if (arg() === null) break; }
      return done('');
    }

    // 代码上下文（\texttt）里显示的是命令名本身，原样输出且不算“未识别”
    // 代码上下文（\texttt）里显示的是命令名本身，原样输出且不算“未识别”；
    // 但“文本符号宏”必须先执行：作者用 \textbackslash 输出反斜杠（\doccmd{sidenote} → \sidenote）
    if (ctx.inCode) {
      if (text[i] === '{' && text[i + 1] === '}') i += 2;   // \textbackslash{} 的空组
      // TeX 控制词后的一个空格被吞掉：\textbackslash sidenote 显示为 \sidenote
      if (text[i] === ' ') i++;
      var inCodeSym = TEXT_SYMBOLS[name];
      if (inCodeSym != null) return done(esc(inCodeSym));
      if (CHAR_SYMBOLS[name] != null) return done(esc(CHAR_SYMBOLS[name]));
      return done(esc('\\' + name));
    }

    // 兜底有界：只留前 200 个名字用于排查，其余只记总数
    // 未知宏若紧跟定界参数（\mailto|url|），把参数整体吃掉：保留正文，不把 |url| 漏出来
    var uc = text[i];
    if (uc && !/[\s{\[]/.test(uc) && /[|!@*\/+=]/.test(uc)) {
      var uclose = text.indexOf(uc, i + 1);
      if (uclose > 0 && uclose - i < 400) i = uclose + 1;
    }
    // \name@internal 这类带 @ 的名字是 TeX 内部实现（\makeatletter 下才可用），
    // 不产生正文；未定义时静默跳过，不计入“未识别”，也不留 @xx 残片
    if (name.indexOf('@') >= 0 && !(ctx.macros && Object.prototype.hasOwnProperty.call(ctx.macros, name))) {
      return done('');
    }
    if (ctx.unknown.length < 200) ctx.unknown.push(name);
    ctx.unknownTotal = (ctx.unknownTotal || 0) + 1;
    // 注意：这里的 i 已经在命令名之后，再减 name.length 会吞掉后面一个命令名的字符
    return done('');
  }

  /* ------------------------------------------------------------------ */
  /* 5. 图片                                                             */
  /* ------------------------------------------------------------------ */

  function imageHtml(path, opts, ctx) {
    var clean = String(path).trim().replace(/^["']|["']$/g, '');
    var uniq = clean.split(',')[0].trim();      // 去 latex 的路径优先级列表
    var ext = (uniq.split('.').pop() || '').toLowerCase();
    var style = '';
    if (opts) {
      var w = /width\s*=\s*([^,]+)/.exec(opts);
      if (w) {
        var wv = w[1].trim();
        var mw = /^([\d.]+)\s*\\(textwidth|linewidth|columnwidth|paperwidth)/.exec(wv);
        if (mw) style = 'width:' + (parseFloat(mw[1]) * 100) + '%';
        else if (/^[\d.]+$/.test(wv)) style = 'width:' + wv + 'px';
        else if (/^[\d.]+(cm|mm|in|pt|pc|em)$/.test(wv)) style = 'width:' + wv;
      }
      var h = /height\s*=\s*([^,]+)/.exec(opts);
      if (h && /^[\d.]+(cm|mm|in|pt|px)$/.test(h[1].trim())) style += ';height:' + h[1].trim();
    }

    if (ext === 'pdf') {
      // 宿主会用 Windows 自带的 PDF 渲染把首页转成 PNG 内联；转不出来时页面再降级成可点卡片
      return '<img class="fig" data-pdf="1" alt="' + escAttr(uniq) +
        '"' + (style ? ' style="' + escAttr(style) + '"' : '') +
        ' data-path="' + escAttr(uniq) + '" title="PDF 图：' + escAttr(uniq) + '" />';
    }
    if (ext === 'eps' || ext === 'ps') {
      ctx.warn('image', uniq + '（' + ext.toUpperCase() + ' 需要先转成 PDF/PNG）');
      return '<span class="tex-chip img-missing" title="' + escAttr(uniq) + '">' +
        esc(uniq) + '</span>';
    // 不在 HTML 里写 src：宿主会把图片内联成 data URI 后由页面回填，
    }
    // 这样页面不会主动去请求本地文件（也少一次无用请求）。
    return '<img class="fig" alt="' + escAttr(uniq) +
      '"' + (style ? ' style="' + escAttr(style) + '"' : '') +
      ' data-path="' + escAttr(uniq) + '" />';
  }

  /* ------------------------------------------------------------------ */
  /* 6. 块级解析                                                         */
  /* ------------------------------------------------------------------ */

  // 从任意文本里取出某个环境的内容（不要求 \begin 出现在第一行）
  function envText(text, env) {
    var open = '\\begin{' + env + '}', close = '\\end{' + env + '}';
    var b = text.indexOf(open);
    if (b < 0) return null;
    var depth = 0, i = b, end = -1;
    while (i < text.length) {
      if (text.substr(i, open.length) === open) { depth++; i += open.length; continue; }
      if (text.substr(i, close.length) === close) {
        depth--;
        if (depth === 0) { end = i; break; }
        i += close.length; continue;
      }
      i++;
    }
    if (end < 0) end = text.length;
    return text.substring(b + open.length, end);
  }

  // 把 \label{key} 记进标签表并从正文里摘掉
  function takeLabels(text, ctx, value) {
    return text.replace(/\\label\s*\{([^}]+)\}/g, function (m, key) {
      var k = key.trim();
      if (k && value != null) ctx.labels[k] = String(value);
      return '';
    });
  }

  function envBounds(lines, i, env) {
    var open = '\\begin{' + env + '}', close = '\\end{' + env + '}';
    var depth = 0;
    for (var j = i; j < lines.length; j++) {
      depth += countOcc(lines[j], open) - countOcc(lines[j], close);
      if (depth <= 0) return j;
    }
    return lines.length - 1;
  }

  function envInner(lines, i, j, env) {
    var text = lines.slice(i, j + 1).join('\n');
    var open = '\\begin{' + env + '}', close = '\\end{' + env + '}';
    var b = text.indexOf(open);
    var e = text.lastIndexOf(close);
    if (b < 0) return text;
    if (e < 0) e = text.length;
    return text.substring(b + open.length, e);
  }

  // 在顶层（不在嵌套环境、不在数学里）切分
  function splitTopLevel(text, sep) {
    var parts = [], buf = '', depth = 0, i = 0, inMath = false;
    while (i < text.length) {
      // 分隔符优先判定：表格换行符 \\ 本身以反斜杠开头，不能被转义分支吃掉
      if (!inMath && depth === 0 && text.substr(i, sep.length) === sep) {
        parts.push(buf); buf = ''; i += sep.length; continue;
      }

      var c = text[i];
      if (c === '\\') {
        if (text[i + 1] === '(' || text[i + 1] === '[') { inMath = true; }
        if (text[i + 1] === ')' || text[i + 1] === ']') { inMath = false; }
        if (text.substr(i, 8) === '\\begin{') { depth++; }
        if (text.substr(i, 6) === '\\end{') { depth = Math.max(0, depth - 1); }
        buf += text.substr(i, 2); i += 2; continue;
      }
      if (c === '$') { inMath = !inMath; buf += c; i++; continue; }
      if (c === '{') { depth++; buf += c; i++; continue; }
      if (c === '}') { depth = Math.max(0, depth - 1); buf += c; i++; continue; }
      buf += c; i++;
    }
    parts.push(buf);
    return parts;
  }


  // 块级宏展开：body 里含 \begin{...} 的宏按块展开（保留环境，交给块解析器）
  function expandBlockMacros(text, ctx) {
    for (var pass = 0; pass < 3; pass++) {
      var changed = false;
      for (var name in ctx.macros) {
        if (!Object.prototype.hasOwnProperty.call(ctx.macros, name)) continue;
        var def = ctx.macros[name];
        if (!def || String(def.body).indexOf('\\begin{') < 0) continue;
        var needle = '\\' + name, from = 0, out = '';
        while (true) {
          var at = text.indexOf(needle, from);
          if (at < 0) { out += text.slice(from); break; }
          var nextCh = text.charAt(at + needle.length);
          if (/[A-Za-z@]/.test(nextCh)) { out += text.slice(from, at + needle.length); from = at + needle.length; continue; }
          out += text.slice(from, at);
          var pos = at + needle.length, args = [], need = def.n || 0, ok = true;
          if (need > 0 && def.opt != null) {
            var mo = readOptional(text, pos);
            if (mo) { args.push(mo.text); pos = mo.end; }
            else if (def.opt !== '') args.push(def.opt);
            need--;
          }
          for (var k = 0; k < need; k++) {
            var g = readGroup(text, pos);
            if (!g) { ok = false; break; }
            args.push(g.text);
            pos = g.end;
          }
          if (!ok) { out += needle; from = at + needle.length; continue; }
          out += substParams(def.body, args);
          from = pos;
          changed = true;
        }
        text = out;
      }
      if (!changed) break;
    }
    return text;
  }

  // 只影响间距/字号的布局环境：去掉 begin/end（及 \begin{spacing}{1} 的参数），内容照常排版
  function flattenLayoutEnvs(text) {
    var envs = ['spacing', 'singlespace', 'onehalfspace', 'doublespace', 'setspace',
      'small', 'footnotesize', 'scriptsize', 'tiny', 'large', 'Large', 'LARGE', 'huge', 'Huge', 'normalsize'];
    for (var i = 0; i < envs.length; i++) {
      var e = envs[i];
      var reBegin = new RegExp('\\\\begin\\{' + e + '\\}(?:\\s*\\{[^{}]*\\})?', 'g');
      var reEnd = new RegExp('\\\\end\\{' + e + '\\}', 'g');
      text = text.replace(reBegin, '').replace(reEnd, '');
    }
    return text;
  }
  // resizebox/scalebox：把内部内容提升到块级，避免表格被拍平
  function unwrapBoxes(text) {
    var names = ['resizebox', 'scalebox'];
    for (var ni = 0; ni < names.length; ni++) {
      var name = names[ni], from = 0, out = '', guard = 0;
      while (guard++ < 200) {
        var pos = text.indexOf('\\' + name, from);
        if (pos < 0) { out += text.slice(from); break; }
        var after = text.charAt(pos + 1 + name.length);
        if (/[A-Za-z@]/.test(after)) { out += text.slice(from, pos + 1 + name.length); from = pos + 1 + name.length; continue; }
        out += text.slice(from, pos);
        var p = pos + 1 + name.length, okk = true;
        var need2 = name === 'resizebox' ? 2 : 1;
        for (var k = 0; k < need2; k++) { var g = readGroup(text, p); if (!g) { okk = false; break; } p = g.end; }
        if (!okk) { out += '\\' + name; from = pos + 1 + name.length; continue; }
        var body = readGroup(text, p);
        if (!body) { out += '\\' + name; from = pos + 1 + name.length; continue; }
        out += body.text;
        from = body.end;
      }
      text = out;
    }
    return text;
  }

  function parseBlocks(lines, ctx, depth) {
    // 块级宏（body 里含 \begin{...}）必须先在块层面展开，否则内联展开会把环境拍平成文本
    lines = expandBlockMacros(lines.join('\n'), ctx).split('\n');
  lines = flattenLayoutEnvs(lines.join('\n')).split('\n');
  lines = unwrapBoxes(lines.join('\n')).split('\n');
    var html = '', i = 0, para = [];

    function flush() {
      if (!para.length) return;
      var t = para.join(' ').replace(/\s+/g, ' ').trim();
      para = [];
      if (t) html += '<p>' + renderInline(t, ctx) + '</p>\n';
    }

    var guard = 0;
    while (i < lines.length) {
      // 防御：任何游标计算失误都不允许把整篇文档卡死
      if (i < 0) i = 0;
      if (++guard > lines.length * 4 + 200) {
        ctx.warn('解析提前终止：块数超出预期');
        break;
      }

      var rawLine = lines[i];
      var line = rawLine;
      var trim = line.trim();

      if (!trim) { flush(); i++; continue; }

      // ---- 结束标记（父级已消费）----
      if (/^\\end\{/.test(trim)) { i++; continue; }

      // 定义类命令：整行丢弃（定义体不是正文内容）
      var DEF_MACROS = { def: 1, gdef: 1, edef: 1, xdef: 1, let: 1, 'long\def': 0,
        newcommand: 1, renewcommand: 1, providecommand: 1, DeclareRobustCommand: 1,
        DeclareMathOperator: 1, NewDocumentCommand: 1, RenewDocumentCommand: 1,
        ProvideDocumentCommand: 1, DeclareDocumentCommand: 1,
        newenvironment: 1, renewenvironment: 1, NewDocumentEnvironment: 1 };

      // ---- 导言区宏 ----
      var sm = /^\\([A-Za-z@]+)/.exec(trim);
      if (sm && SKIP_MACROS[sm[1]]) {
        if (DEF_MACROS[sm[1]]) {
          // 定义行可能含多行定义体：按括号深度整段跳过
          var dd = braceDepth(line);
          i++;
          var dg = 0;
          while (dd > 0 && i < lines.length && dg++ < 400) { dd += braceDepth(lines[i]); i++; }
          continue;
        }
        flush();
        var rest = line, consumedAll = true, guard3 = 0;
        while (guard3++ < 40) {
          var lm = /^[ \t]*\\([A-Za-z@]+)/.exec(rest);
          if (!lm || !SKIP_MACROS[lm[1]]) break;
          if (DEF_MACROS[lm[1]]) break;   // 定义命令交给下一轮整行丢弃，绝不能只删 \def 留下定义体
          var pos3 = rest.indexOf('\\') + 1 + lm[1].length;
          var moved = true;
          while (moved) {
            moved = false;
            var op3 = readOptional(rest, pos3);
            if (op3) { pos3 = op3.end; moved = true; continue; }
            var gr3 = readGroup(rest, pos3);
            if (gr3) { pos3 = gr3.end; moved = true; }
          }
          rest = rest.slice(pos3);
          consumedAll = (rest.trim() === '');
          if (consumedAll) break;
        }
        if (!consumedAll) { lines[i] = rest; continue; }
        var dep = braceDepth(line);
        i++;
        var skipGuard = 0;
        while (dep > 0 && i < lines.length && skipGuard++ < 200) { dep += braceDepth(lines[i]); i++; }
        continue;
      }

      // ---- \begin{env} ----
      var bm = /^\\begin\s*\{([^}]+)\}/.exec(trim);
      if (bm) {
        var env = bm[1];

        // 整段数学
        if (MATH_ENVS[env]) {
          flush();
          var endM = envBounds(lines, i, env);
          var inner = envInner(lines, i, endM, env);
          // 只有“整段一个编号”的环境才加 \tag；align/alignat/flalign 是多行编号，
          // 加单个 \tag 既不准确又显著拖慢 MathJax，直接不编号。
          var multiRow = env === 'align' || env === 'align*' || env === 'alignat' || env === 'alignat*' ||
            env === 'flalign' || env === 'flalign*' || env === 'split' || env === 'aligned' ||
            env === 'gathered' || env === 'alignedat';
          var starred = env.indexOf('*') >= 0 || env === 'displaymath' || env === 'math' || multiRow;
          var eqNo = null;
          if (!starred) {
            ctx.eqNum = (ctx.eqNum || 0) + 1;
            eqNo = String(ctx.eqNum);
          }
          inner = takeLabels(inner, ctx, eqNo);
          ctx.math++;
          var texBody = '\\begin{' + env + '}' + inner + '\\end{' + env + '}';
          html += mathDisplay(texBody, null, ctx, eqNo) + '\n';
          i = endM + 1;
          continue;
        }

        // 逐字环境 / 不渲染语义的图形与算法环境：原样当代码块（绝不逐行误解析）
        if (Object.prototype.hasOwnProperty.call(RAW_ENVS, env) || (env === 'example' && !ctx.theoremDecls.example)) {
          flush();
          var endV = envBounds(lines, i, env);
          var bodyV = lines.slice(i + 1, endV).join('\n');
          if (env === 'minted') bodyV = bodyV.replace(/^[ \t]*\{[^}]*\}[ \t]*\n/, '');
          // 图形引擎：与公式里的图形共用同一套“折叠源码”，避免两种提示风格
          if (/^(tikzpicture|tikzcd|pspicture|circuitikz|xy)$/.test(env)) {
            html += diagramAsCode('\\begin{' + env + '}\n' + bodyV + '\n\\end{' + env + '}', ctx) + '\n';
            i = endV + 1;
            continue;
          }
          var rawNote = RAW_ENVS[env];
          if (rawNote) html += '<div class="tex-hint">' + esc(rawNote) + '</div>\n';
          html += '<pre class="code"><code>' + esc(bodyV) + '</code></pre>\n';
          i = endV + 1;
          continue;
        }

        // 列表
        if (env === 'itemize' || env === 'enumerate' || env === 'description' ||
            env === 'compactitem' || env === 'compactenum') {
          flush();
          var r = parseList(lines, i, env, ctx, depth);
          html += r.html;
          i = r.next;
          continue;
        }

        // 表格
        if (env === 'tabular' || env === 'tabularx' || env === 'tabular*' ||
            env === 'longtable' || env === 'supertabular') {
          flush();
          var endT = envBounds(lines, i, env);
          var bodyT = envInner(lines, i, endT, env);
          html += '<div class="table-wrap">' + renderTable(bodyT, ctx) + '</div>\n';
          i = endT + 1;
          continue;
        }

        // 浮动体
        if (env === 'figure' || env === 'figure*' || env === 'algorithm' || env === 'algorithm*' || env === 'wrapfigure' ||
            env === 'table' || env === 'table*' || env === 'subfigure') {
          flush();
          var endF = envBounds(lines, i, env);
          var bodyF = envInner(lines, i, endF, env);
          html += renderFloat(bodyF, env, ctx, depth) + '\n';
          i = endF + 1;
          continue;
        }

        // 定理类
        if ((Object.prototype.hasOwnProperty.call(THEOREM_ENVS, env) && (env !== 'example' || ctx.theoremDecls.example)) || /^(theorem|lemma|definition|proposition|corollary|remark|proof)/.test(env)) {
          flush();
          var endH = envBounds(lines, i, env);
          var bodyH = envInner(lines, i, endH, env);
          var ht = /^\s*\[([^\]]*)\]/.exec(bodyH);
          var htitle = ht ? ht[1] : '';
          if (ht) bodyH = bodyH.substring(ht[0].length);
          // 名称来自文档（\newtheorem / \proofname）
          var thmKey = ctx.theoremShare[env] || env;
          var isProof = /^proof/.test(env);
          var label = ctx.theoremNames[env] || (isProof ? ctx.names.proof : env);
          ctx.thm = (ctx.thm = ctx.thm || {});
          if (!isProof) { ctx.thm[thmKey] = (ctx.thm[thmKey] || 0) + 1; }
          var thmNo = isProof ? '' : String(ctx.thm[thmKey]);
          if (!isProof && ctx.theoremParent[env]) {
            var pname = ctx.theoremParent[env];
            var chapteredDoc = /report|book/.test(ctx.docClass || '');
            var pno;
            if (pname === 'chapter') pno = String(ctx.counters[2] || 0);
            else if (pname === 'section') pno = (chapteredDoc && ctx.counters[2] ? ctx.counters[2] + '.' : '') + (ctx.counters[3] || 0);
            else pno = String(ctx.counters[LEVEL_OF[pname] || 3] || 0);
            thmNo = pno + '.' + thmNo;
          }
          bodyH = takeLabels(bodyH, ctx, isProof ? '' : thmNo);
          html += '<div class="thmbox env-' + safeClass(env) + '">' +
            '<div class="thm-head">' + esc(label) + (isProof ? '. ' : ' ' + thmNo + '. ') +
            (htitle ? '<span class="thm-title">（' + renderInline(htitle, ctx) + '）</span>' : '') +
            '</div>' + parseBlocks(bodyH.split('\n'), ctx, depth + 1) + (isProof ? '<span class="qed">□</span>' : '') + '</div>\n';
          i = endH + 1;
          continue;
        }

        // 算法伪代码：去控制命令，保留可读文字
        if (/^(algorithmic|algorithmicx|algpseudocode|algorithm2e|pseudocode)$/.test(env)) {
          flush();
          var endA = envBounds(lines, i, env);
          var bodyA = lines.slice(i + 1, endA).join('\n');
          bodyA = bodyA
            .replace(/\\(State|Statex|Return|EndIf|EndFor|EndWhile|EndProcedure|EndFunction|Else|ElsIf|Repeat|Until|Loop|EndLoop)\b/g, '\n')
            .replace(/\\(For|ForAll|While|If|IfThenElse|Procedure|Function)\s*(\{[^{}]*\}|\[[^\]]*\])/g, '')
            .replace(/\\textbf\s*\{([^{}]*)\}/g, '$1')
            .replace(/\\Comment\s*\{[^{}]*\}/g, '')
            .replace(/\\[A-Za-z]+\s*/g, '');
          var algoLines = bodyA.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
          html += '<pre class="algo"><code>' + esc(algoLines.join('\n')) + '</code></pre>\n';
          i = endA + 1;
          continue;
        }

        // 摘要：LaTeX 会印出 \abstractname 作为标题
        if (env === 'abstract') {
          flush();
          var endAb = envBounds(lines, i, env);
          var bodyAb = envInner(lines, i, endAb, env);
          html += '<div class="env-block env-abstract"><div class="abstract-head">' + esc(ctx.names.abstract) + '</div>' +
            parseBlocks(bodyAb.split('\n'), ctx, depth + 1) + '</div>\n';
          i = endAb + 1;
          continue;
        }


        // 参考文献
        if (env === 'thebibliography') {
          flush();
          var endB = envBounds(lines, i, env);
          var bodyB = envInner(lines, i, endB, env).replace(/^\s*\{[^{}]*\}\s*/, '');
          var items = bodyB.split(/\\bibitem\b/).slice(1);
          var bibHtml = '<ol class="bib">';
          for (var bi = 0; bi < items.length; bi++) {
            var item = items[bi].replace(/^\s*(?:\[[^\]]*\])?\s*\{[^}]*\}/, '').trim();
            bibHtml += '<li>' + renderInline(item, ctx) + '</li>';
          }
          bibHtml += '</ol>';
          html += '<div class="env-block env-thebibliography">' + bibHtml + '</div>\n';
          i = endB + 1;
          continue;
        }

        // 其它环境：通用包裹后递归
        flush();
        var endG = envBounds(lines, i, env);
        var bodyG = envInner(lines, i, endG, env);
        if (env === 'document') {
          // 用环境体替换 \begin{document}…\end{document}（可能整篇都在一行），再重新解析该位置
          lines.splice(i, endG - i + 1, ...bodyG.split('\n'));
          continue;
        }

        // 带必选参数的环境：先把 {..} 参数剥掉，别让 “0.6\textwidth” 出现在正文里
        var ARG_ENVS = { minipage: 1, multicols: 1, 'multicols*': 1, wrapfigure: 2, adjustbox: 1, subfigure: 1 };
        for (var an = 0; an < (ARG_ENVS[env] || 0); an++) {
          var ga = /^\s*\{[^{}]*\}/.exec(bodyG);
          if (!ga) break;
          bodyG = bodyG.substring(ga[0].length);
        }

        html += '<div class="env-block env-' + safeClass(env) + '">' +
          parseBlocks(bodyG.split('\n'), ctx, depth + 1) + '</div>\n';
        i = endG + 1;
        continue;
      }

      // ---- 块级横线 ----
      if (/^\\(hrule|hrulefill|rule\s*\{[^}]*\}\s*\{[^}]*\})$/.test(trim)) {
        flush();
        html += '<hr class="rule" />\n';
        i++;
        continue;
      }

      // ---- 行间数学：\[ … \] 或 $$ … $$ ----
      if (/^\\\[/.test(trim)) {
        flush();
        var buf = trim;
        var j = i;
        while (buf.indexOf('\\]') < 0 && j + 1 < lines.length) { j++; buf += '\n' + lines[j]; }
        var innerD = buf.replace(/^\\\[/, '').replace(/\\\][\s\S]*$/, '');
        ctx.math++;
        html += mathDisplay(innerD, null, ctx) + '\n';
        i = j + 1;
        continue;
      }
      if (/^\$\$/.test(trim)) {
        flush();
        var buf2 = trim;
        var j2 = i;
        while (buf2.indexOf('$$', 2) < 0 && j2 + 1 < lines.length) { j2++; buf2 += '\n' + lines[j2]; }
        var innerE = buf2.replace(/^\$\$/, '').replace(/\$\$[\s\S]*$/, '');
        ctx.math++;
        html += mathDisplay(innerE, null, ctx) + '\n';
        i = j2 + 1;
        continue;
      }

      // ---- 标题 ----
      var hm = /^\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)(\*?)\s*(\[[^\]]*\])?\s*\{/.exec(trim);
      if (hm) {
        flush();
        var gi = hm.index + hm[0].length - 1;
        var g = readGroup(trim, gi);
        if (g) {
          html += heading(hm[1].toLowerCase(), hm[2] === '*', g.text, ctx);
          var hnum = ctx.lastNumber;
          takeLabels(trim.slice(g.end), ctx, hnum);   // 同一行尾部的 \label
          i++;
          // 标题后紧跟的 \label{...} 归到该节编号
          while (i < lines.length && /^\s*\\label\s*\{/.test(lines[i])) {
            takeLabels(lines[i], ctx, hnum);
            i++;
          }
          continue;
        }
      }

      // ---- \appendix ----
      if (/^\\appendix\b/.test(trim)) {
        ctx.appendix = true;
        ctx.counters[2] = 0;
        for (var ai = 3; ai <= 7; ai++) ctx.counters[ai] = 0;
        i++;
        continue;
      }

      // ---- \maketitle ----
      if (/^\\maketitle\b/.test(trim)) {
        flush();
        html += titleBlock(ctx);
        i++;
        continue;
      }

      // ---- \tableofcontents ----
      if (/^\\tableofcontents\b/.test(trim)) {
        flush();
        html += '';   // 目录由侧栏呈现，不在正文里写提示文字
        i++;
        continue;
      }

      // ---- \title / \author 等（无 document 环境的片段里可能出现）----
      if (/^\\(title|author|date|subtitle|institute|affil)\s*\{/.test(trim)) {
        flush();
        i++;
        continue;
      }

      // ---- 空行分段，其余进段落 ----
      para.push(trim);
      i++;
    }

    flush();
    return html;
  }

  /* ------------------------------------------------------------------ */
  /* 7. 标题 / 标题块 / 目录                                             */
  /* ------------------------------------------------------------------ */

  var LEVEL_OF = {
    part: 1, chapter: 2, section: 3, subsection: 4,
    subsubsection: 5, paragraph: 6, subparagraph: 7
  };

  function heading(kind, starred, titleTex, ctx) {
    var level = LEVEL_OF[kind] || 3;
    var counters = ctx.counters;
    if (!starred) {
      counters[level] = (counters[level] || 0) + 1;
      for (var k = level + 1; k <= 7; k++) counters[k] = 0;
    }
    var chaptered = /report|book/.test(ctx.docClass || '');
    var number = '';
    if (!starred) {
      if (level === 1) {
        number = fmtCounter(counters[1], 'Roman');
      } else if (ctx.appendix && level === 2) {
        number = String.fromCharCode(64 + counters[2]);
      } else if (chaptered) {
        number = counters.slice(2, level + 1).join('.');
        if (ctx.appendix && counters[2]) number = String.fromCharCode(64 + counters[2]) + (level > 2 ? '.' + counters.slice(3, level + 1).join('.') : '');
      } else {
        number = counters.slice(3, level + 1).join('.');
      }
    }

    var text = renderInline(titleTex, ctx);
    if (!text.replace(/<[^>]*>/g, '').trim()) {
      text = esc(titleTex.replace(/\\[A-Za-z@]+\*?/g, '').replace(/[{}]/g, '').trim());
    }
    var id = 'sec-' + (ctx.headings.length + 1);
    ctx.headings.push({ level: level, text: titleTex.replace(/\s+/g, ' ').trim(), html: text, id: id, number: number });
    ctx.lastNumber = number;

    var htag = level <= 2 ? 'h1' : (level <= 3 ? 'h2' : (level <= 4 ? 'h3' : (level <= 5 ? 'h4' : 'h5')));
    return '<' + htag + ' id="' + id + '" class="heading h' + level + '">' +
      (number ? '<span class="secno">' + number + '</span>' : '') +
      '<span class="sectitle">' + text + '</span></' + htag + '>\n';
  }

  // 页边注：tufte 类文档里正文只留锚点，注释放进独立页边栏（结构性的，不靠事后搬 DOM）
function marginAside(innerHtml, ctx) {
  if (!/tufte/.test(ctx.docClass || '')) return '<aside class="sidenote">' + innerHtml + '</aside>';
  var n = (ctx.marginNotes.length || 0) + 1;
  ctx.marginNotes.push(innerHtml);
  return '<span class="note-ref" data-note="' + n + '" style="anchor-name:--qln' + n + '"></span>';
}

function titleBlock(ctx) {
    var m = ctx.meta;
    var tufte = /tufte/.test(ctx.docClass || '');
    var cls = 'doc-title' + (m.thanks && m.thanks.length ? ' has-notes' : '');
    var main = '<div class="title-main">';
    if (m.title) main += '<div class="t">' + renderInline(m.title, ctx) + '</div>';
    if (m.author) main += '<div class="a">' + renderInline(m.author, ctx) + '</div>';
    if (m.date) main += '<div class="d">' + renderInline(m.date, ctx) + '</div>';
    main += '</div>';
    var notes = '';
    if (m.thanks && m.thanks.length) {
      notes = '<div class="doc-thanks">' + m.thanks.map(function (txt, i) {
        return '<aside class="sidenote title-note"><sup>' + (i + 1) + '</sup> ' + renderInline(txt, ctx) + '</aside>';
      }).join('') + '</div>';
    }
    return '<header class="' + cls + '">' + main + notes + '</header>';
  }

  /* ------------------------------------------------------------------ */
  /* 8. 列表                                                             */
  /* ------------------------------------------------------------------ */

  function parseList(lines, i, env, ctx, depth) {
    var end = envBounds(lines, i, env);
    var inner = envInner(lines, i, end, env);

    var items = splitItems(inner);
    var html;

    if (env === 'description') {
      html = descriptionList(items, ctx, depth);
    } else {
      var tag = env === 'enumerate' || env === 'compactenum' ? 'ol' : 'ul';
      html = '<' + tag + ' class="list">';
      for (var k = 0; k < items.length; k++) {
        var body = items[k].replace(/^\s*\[[^\]]*\]\s*/, '');
        var inner2 = parseBlocks(body.split('\n'), ctx, depth + 1)
          .replace(/^<p>/, '').replace(/<\/p>\s*$/, '');
        html += '<li>' + (inner2 || '') + '</li>';
      }
      html += '</' + tag + '>';
    }

    // 游标必须推进到 \end{env} 之后，否则上层循环会原地打转
    return { html: html + '\n', next: end + 1 };
  }

  function descriptionList(items, ctx, depth) {
    var out = '<dl class="desc">';
    for (var k = 0; k < items.length; k++) {
      var it = items[k];
      var m = /^\s*\[([^\]]*)\]/.exec(it);
      var term = m ? m[1] : '';
      var body = m ? it.substring(m[0].length) : it;
      var inner = parseBlocks(body.split('\n'), ctx, depth + 1)
        .replace(/^<p>/, '').replace(/<\/p>\s*$/, '');
      out += '<dt>' + renderInline(term, ctx) + '</dt><dd>' + inner + '</dd>';
    }
    out += '</dl>';
    return out;
  }

  // 按顶层 \item 切分
  function splitItems(text) {
    var items = [], buf = '', i = 0, depth = 0;
    while (i < text.length) {
      if (text.substr(i, 7) === '\\begin{') { depth++; buf += '\\begin{'; i += 7; continue; }
      if (text.substr(i, 5) === '\\end{') { depth = Math.max(0, depth - 1); buf += '\\end{'; i += 5; continue; }
      if (depth === 0 && text.substr(i, 5) === '\\item') {
        var after = text[i + 5] || '';
        if (!/[A-Za-z]/.test(after)) {
          items.push(buf); buf = ''; i += 5; continue;
        }
      }
      buf += text[i]; i++;
    }
    if (buf.trim()) items.push(buf);
    if (items.length > 1 && !items[0].trim()) items.shift();
    return items;
  }

  /* ------------------------------------------------------------------ */
  /* 9. 表格                                                             */
  /* ------------------------------------------------------------------ */

  // 表格里的宏展开只针对“行模板”宏（body 里含 & 或 \\ 的宏）：只有这类宏会改变行列结构，
  // 其余内容（尤其数学）必须原样交给 MathJax。
  function expandRowMacros(text, ctx) {
    if (!ctx || !ctx.macros) return String(text);
    var out = String(text);
    Object.keys(ctx.macros).forEach(function (name) {
      var d = ctx.macros[name];
      if (!d) return;
      var body = String(d.body || '');
      if (body.indexOf('&') < 0 && body.indexOf('\\\\') < 0) return;
      var n = d.n || 0;
      var safe = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      var re = new RegExp('\\\\' + safe + '\\s*');
      var loop = 0;
      while (loop++ < 200) {
        var m = re.exec(out);
        if (!m) break;
        var j = m.index + m[0].length, got = [], ok = true;
        for (var k = 0; k < n; k++) { var g = readGroup(out, j); if (!g) { ok = false; break; } got.push(g.text); j = g.end; }
        if (!ok) break;
        out = out.slice(0, m.index) + substParams(body, got) + out.slice(j);
      }
    });
    return out;
  }

  function renderTable(text, ctx) {
    // 去掉 tabular 的 [位置] 与 {列格式}（tabularx 还多一个宽度参数）
      // 列格式里可能有嵌套花括号（*{7}{p{1.45cm}|}），必须用花括号感知的读取
      {
        var tspec = String(text).replace(/^\s+/, '');
        if (/^\{[^{}]*\}\s*\{[lcrpmbX*|@><!.]/.test(tspec)) {
          var wg0 = readGroup(tspec, 0);
          if (wg0) tspec = tspec.slice(wg0.end).replace(/^\s+/, '');
        }
        if (tspec.charAt(0) === '[') {
          var optSpec = readOptional(tspec, 0);
          if (optSpec) tspec = tspec.slice(optSpec.end);
        }
        tspec = tspec.replace(/^\s+/, '');
        if (tspec.charAt(0) === '{') {
          var grpSpec = readGroup(tspec, 0);
          if (grpSpec) tspec = tspec.slice(grpSpec.end);
        }
        text = tspec;
      }

    var body = expandRowMacros(text, ctx)   // 只展开行模板宏（body 含 & 或 \\\\）
      .replace(/\\hline/g, '')
      .replace(/\\(toprule|midrule|bottomrule)\b/g, '')
      .replace(/\\cmidrule(\([^)]*\))?\s*\{[^}]*\}/g, '')
      .replace(/\\cline\s*\{[^}]*\}/g, '')
      .replace(/\\endhead|\\endfirsthead|\\endfoot|\\endlastfoot/g, '')
      .trim();

    var rows = splitTopLevel(body, '\\\\').filter(function (r) { return r.trim(); });
    var html = '<table class="tabular">';
    for (var r = 0; r < rows.length; r++) {
      var cells = splitTopLevel(rows[r], '&');
        var colCount = Math.max.apply(null, rows.map(function (row) {
          return splitTopLevel(row, '&').length;
        }));
      var isHead = r === 0 && rows.length > 1 && /\\(hline|midrule)/.test(text);
      if (isHead) html += '<thead>';
      html += '<tr>';
      for (var c = 0; c < cells.length; c++) {
        var cell = cells[c].trim();
          if (!cell) { html += '<' + (isHead ? 'th' : 'td') + '></' + (isHead ? 'th' : 'td') + '>'; continue; }
        var mc = /^\\multicolumn\s*\{(\d+)\}/.exec(cell);
        if (mc) {
          var rest = cell.substring(mc[0].length);
          var spec = readGroup(rest, 0);
          if (spec) rest = rest.substring(spec.end);
          var content = readGroup(rest, 0);
          html += '<td colspan="' + mc[1] + '">' +
            renderInline(content ? content.text : rest, ctx) + '</td>';
          continue;
        }
        var tag2 = isHead ? 'th' : 'td';
        html += '<' + tag2 + '>' + renderInline(cell, ctx) + '</' + tag2 + '>';
      }
        for (var pad = cells.length; pad < colCount; pad++) {
          html += '<' + (isHead ? 'th' : 'td') + '></' + (isHead ? 'th' : 'td') + '>';
        }
      html += '</tr>';
      if (isHead) html += '</thead><tbody>';
    }
    if (/<thead>/.test(html)) html += '</tbody>';
    html += '</table>';
    return html;
  }

  /* ------------------------------------------------------------------ */
  /* 10. 浮动体                                                          */
  /* ------------------------------------------------------------------ */

  function renderFloat(body, env, ctx, depth) {
      // 组图：父 figure 含 subfigure 时，子图全渲染、父标题放最后
      if (/^figure/.test(env) && /\\begin\{(subfigure|subcaptionbox)\}/.test(body)) {
        var lastEnd = Math.max(body.lastIndexOf('\\end{subfigure}'), body.lastIndexOf('\\end{subcaptionbox}'));
        var tail = lastEnd >= 0 ? body.slice(lastEnd) : '';
        var pcap = /\\caption\s*(?:\[[^\]]*\])?\s*\{/.exec(tail);
        var pcapHtml = '';
        if (pcap) {
          var pg = readGroup(tail, pcap.index + pcap[0].length - 1);
          if (pg) {
            pcapHtml = renderInline(pg.text, ctx);
            body = body.slice(0, lastEnd + 1) + tail.replace(pcap[0], '').replace(/\\label\s*\{[^}]*\}/g, '');
          }
        }
        var pno = null;
        if (/^figure/.test(env)) { ctx.figNum = (ctx.figNum || 0) + 1; pno = String(ctx.figNum); }
        takeLabels(body, ctx, pno);
        var innerHtml = parseBlocks(body.replace(/\\centering\b/g, '').split('\n'), ctx, depth + 1);
        return '<figure class="float is-figure">' + innerHtml +
          (pcapHtml ? '<figcaption><span class="float-no">' + ctx.names.figure + ' ' + pno + '</span>: ' + pcapHtml + '</figcaption>' : '') +
          '</figure>';
      }
    var isTable = env.indexOf('table') === 0;

    // 去掉 \begin{table}[htbp] 带出来的可选参数与居中指令
    body = body.replace(/^\s*\[[^\]]*\]/, '').replace(/\\centering\b/g, '');

    // 内部表格
    var tabM = /\\begin\{(tabular|tabularx|longtable|supertabular)\}/.exec(body);
    var tabHtml = '';
    if (tabM) {
      var innerT = envText(body, tabM[1]);
      if (innerT != null) tabHtml = '<div class="table-wrap">' + renderTable(innerT, ctx) + '</div>';
    }

    // 图片
    var imgM = /\\includegraphics\s*(\[[^\]]*\])?\s*\{([^}]+)\}/.exec(body);
    var imgHtml = imgM ? imageHtml(imgM[2], imgM[1], ctx) : '';

    // 编号：表/图各自计数
    var no = null;
    if (isTable) { ctx.tabNum = (ctx.tabNum || 0) + 1; no = String(ctx.tabNum); }
    else if (env.indexOf('figure') === 0 || imgHtml) { ctx.figNum = (ctx.figNum || 0) + 1; no = String(ctx.figNum); }

    if (no) takeLabels(body, ctx, no);

    // 标题
    var capM = /\\caption\s*(\[[^\]]*\])?\s*\{/.exec(body);
    var capHtml = '';
    if (capM) {
      var gi = capM.index + capM[0].length - 1;
      var g = readGroup(body, gi);
      if (g) capHtml = renderInline(g.text, ctx);
    }

    if (!imgHtml && !tabHtml) {
      // 只有文本内容的浮动体
      var cleaned = body
        .replace(/\\caption\s*(\[[^\]]*\])?\s*\{[\s\S]*?\}[ \t]*$/m, '')
        .replace(/\\label\s*\{[^}]*\}/g, '');
      var rest = parseBlocks(cleaned.split('\n'), ctx, depth + 1).trim();
      var ownCap = capHtml
        ? '<figcaption>' + (no ? '<span class="float-no">' + (isTable ? ctx.names.table : ctx.names.figure) + ' ' + no + '</span>: ' : '') + capHtml + '</figcaption>'
        : '';
      return '<div class="float-block">' + rest + ownCap + '</div>';
    }

    var capBlock = '';
    if (capHtml) {
      capBlock = '<figcaption>' +
        (no ? '<span class="float-no">' + (isTable ? ctx.names.table : ctx.names.figure) + ' ' + no + '</span>' : '') +
        (no ? ': ' : '') + capHtml + '</figcaption>';
    }

    return '<figure class="float ' + (isTable ? 'is-table' : 'is-figure') + '">' +
      (isTable ? tabHtml : imgHtml) + capBlock + '</figure>';
  }

  /* ------------------------------------------------------------------ */
  /* 11. 主入口                                                          */
  /* ------------------------------------------------------------------ */

  function firstArg(text, name) {
    var re = new RegExp('\\\\' + name + '\\s*(\\[[^\\]]*\\])?\\s*\\{');
    var m = re.exec(text);
    if (!m) return '';
    var gi = m.index + m[0].length - 1;
    var g = readGroup(text, gi);
    return g ? g.text : '';
  }

  // 收集导言区/正文里的宏定义：\newcommand / \renewcommand / \providecommand /
  // \DeclareRobustCommand / \def —— 这样文档自定义的宏能真正展开，而不是一律“未知”。
  // LaTeX 注释语义：% 到行尾是注释（\% 除外）。
  // 不做这件事的话，数学里的 "A^2% \right\}" 会被 MathJax 当成注释吞掉后半行，导致公式报错。
  function stripComments(text) {
    // 逐字（verbatim/lstlisting/minted）里 % 是普通字符，必须原样保留
    var verb = new RegExp('\\\\begin\\{(' + CODE_ENVS + ')\\}[\\s\\S]*?\\\\end\\{\\1\\}', 'g');
    var strip = function (s) { return String(s).replace(/(^|[^\\])%[^\n]*/g, '$1'); };
    var out = '', last = 0, m;
    while ((m = verb.exec(text)) !== null) {
      out += strip(text.slice(last, m.index)) + m[0];
      last = m.index + m[0].length;
    }
    return out + strip(text.slice(last));
  }

  // 定义本身不该出现在正文里。以“行首”为准整段删除，避免误删行内 \def。
  function stripDefinitions(text) {
    // verbatim/代码环境里的 \def 是示例内容，绝不能被删
    var spans = [], vre = /\\begin\{(verbatim\*?|Verbatim|lstlisting|minted|alltt|example\*?)\}[\s\S]*?\\end\{\1\}/g, vm;
    while ((vm = vre.exec(text)) !== null) spans.push([vm.index, vm.index + vm[0].length]);
    function inVerb(pos) {
      for (var si = 0; si < spans.length; si++) {
        if (pos > spans[si][0] && pos < spans[si][1]) return true;
      }
      return false;
    }

    var out = [], last = 0;
    var re = /(^|\n)([ \t]*)(?:\\(?:long|global|outer|protected|relax)\s*)*\\(newcommand|renewcommand|providecommand|DeclareRobustCommand|DeclareMathOperator|NewDocumentCommand|def|gdef|edef|xdef|let)\b\*?/g;
    var m;
    while ((m = re.exec(text)) !== null) {
      var start = m.index;
      if (inVerb(start)) { re.lastIndex = start + m[0].length; continue; }

      var j = start + m[0].length, guard = 0;
      while (j < text.length && guard++ < 200) {
        var ch = text[j];
        if (ch === ' ' || ch === '\t' || ch === '\r') { j++; continue; }   // 换行 = 定义结束
        if (ch === '[') { var op = readOptional(text, j); if (!op) break; j = op.end; continue; }
        if (ch === '{') { var gp = readGroup(text, j); if (!gp) break; j = gp.end; continue; }
        if (ch === '\\') {
          var nm = /^\\[A-Za-z@]+/.exec(text.slice(j));
          j += nm ? nm[0].length : 1;
          continue;
        }
        if (ch === '=' || ch === '#' || /[0-9]/.test(ch)) { j++; continue; }
        break;
      }

      // 安全阀：必须把这一行吃干净才算定义；否则说明解析跑偏，宁可不删
      var eol = text.indexOf('\n', j);
      if (eol < 0) eol = text.length;
      if (text.slice(j, eol).trim() !== '') { re.lastIndex = start + m[0].length; continue; }

      if (text[j] === '\n') j++;
      out.push(text.slice(last, start));
      last = j;
      re.lastIndex = j;
    }
    out.push(text.slice(last));
    return out.join('');
  }
  function collectMacros(src, ctx) {
    var reNew = /\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand)\*?\s*\{?\s*\\([A-Za-z@]+)\s*\}?\s*(?:\[(\d+)\])?\s*(?:\[([^\]]*)\])?\s*\{/g;
    var m;
    while ((m = reNew.exec(src)) !== null) {
      var name = m[1];
      if (Object.prototype.hasOwnProperty.call(ctx.macros, name)) continue;
      var g = readGroup(src, m.index + m[0].length - 1);
      if (!g) continue;
      ctx.macros[name] = { n: m[2] ? parseInt(m[2], 10) : 0, body: g.text, opt: m[3] != null ? m[3] : null };
    }

    // \DeclareMathOperator(*){\name}{body}：数学里当作 \operatorname{body} 处理
    var reOp = /\\DeclareMathOperator(\*)?\s*\{?\s*\\([A-Za-z@]+)\s*\}?\s*\{/g;
    var om;
    while ((om = reOp.exec(src)) !== null) {
      var opName = om[2];
      if (!Object.prototype.hasOwnProperty.call(ctx.macros, opName)) {
        var gOp = readGroup(src, om.index + om[0].length - 1);
        if (gOp) ctx.macros[opName] = { n: 0, body: '\\operatorname' + (om[1] ? '*' : '') + '{' + gOp.text + '}' };
      }
    }

    var reDef = /\\def\s*\\([A-Za-z@]+)\s*((?:#[1-9])*)\s*\{/g;
    while ((m = reDef.exec(src)) !== null) {
      var name2 = m[1];
      if (Object.prototype.hasOwnProperty.call(ctx.macros, name2)) continue;
      var g2 = readGroup(src, m.index + m[0].length - 1);
      if (!g2) continue;
      var n2 = (m[2].match(/#/g) || []).length;
      ctx.macros[name2] = { n: n2, body: g2.text };
    }
  }

  function resolveRefs(html, ctx) {
    return html.replace(/<span class="xref" data-key="([^"]*)" data-paren="([01])"><\/span>/g,
      function (m, key, paren) {
        var v = ctx.labels[key];
        var has = v != null && v !== '';
        var txt = has ? v : '?';
        var title = has ? ('\\label{' + key + '}') : ('未找到引用键：' + key);
        return '<span class="xref" title="' + escAttr(title) + '">' +
          (paren === '1' ? '(' + esc(txt) + ')' : esc(txt)) + '</span>';
      });
  }

  // 名称只来自文档（\newtheorem / \renewcommand）；没有声明就用 LaTeX 默认，不做语言翻译。
  // \renewcommand{\figurename} 等显式声明优先（作者意图）。
  function buildNames(src, docClass) {

    var names = {
      figure: 'Figure',
      table: 'Table',
      proof: 'Proof',
      abstract: 'Abstract',
      contents: 'Contents'
    };
    var map = { figurename: 'figure', tablename: 'table', proofname: 'proof', abstractname: 'abstract', contentsname: 'contents' };
    for (var key in map) {
      var re = new RegExp('\\\\renewcommand\\s*\\{\\\\?' + key + '\\}\\s*\\{([^{}]*)\\}');
      var m = re.exec(src);
      if (m) names[map[key]] = m[1].trim();
    }
    return names;
  }

  function render(source, opts) {
    opts = opts || {};
    var src = String(source == null ? '' : source).replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');

    var ctx = {
      docClass: (function () {
        var m = /\\documentclass\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/.exec(src);
        return m ? m[1].trim().toLowerCase() : '';
      })(),
      headings: [], math: 0, warnings: [], footnotes: [], labels: {},
      counters: [0, 0, 0, 0, 0, 0, 0, 0],
        theoremDecls: {},
        theoremNames: {},
        theoremShare: {},
        theoremParent: {},
        counterStore: {},
        bibOrder: [], bibIndex: {}, bibLabels: {},
      marginNotes: [],
      meta: { title: '', author: '', date: '', documentclass: '', packages: [] },
      warn: function (kind, msg) {
        // kind: macro | env | image | parse —— 页面按类聚合展示，避免一屏碎信息
        var line = kind + ': ' + msg;
        var sameKind = 0;
        for (var i = 0; i < this.warnings.length; i++) {
          if (this.warnings[i].indexOf(kind + ': ') === 0 && ++sameKind >= 24) return;
        }
        if (this.warnings.length < 80 && this.warnings.indexOf(line) < 0) this.warnings.push(line);
      },
      macros: {},
      macroDepth: 0,
      unknown: [],
      unknownTotal: 0,
    };

  // \newtheorem{name} 声明的环境按“定理”处理；没声明的 example 是逐字示例
  {
    var thmRe = /\\newtheorem\*?\s*\{([^}]+)\}\s*(?:\[([^\]]*)\])?\s*\{([^}]*)\}\s*(?:\[([^\]]*)\])?/g;
    var tm;
    while ((tm = thmRe.exec(src)) !== null) {
      var envName = tm[1].trim();
      ctx.theoremDecls[envName] = 1;
      if (tm[3]) ctx.theoremNames[envName] = tm[3].trim();
      if (tm[2]) ctx.theoremShare[envName] = tm[2].trim();
      if (tm[4]) ctx.theoremParent[envName] = tm[4].trim();
    }
  }

  ctx.names = buildNames(src);
    // 文献：\\bibitem 顺序 + natbib 可选标签（Author(1984)）
    var bibRe = /\\bibitem(?:\s*\[([^\]]*)\])?\s*\{([^}]+)\}/g;
    var bm;
    while ((bm = bibRe.exec(src)) !== null) {
      var bk = bm[2].trim();
      if (ctx.bibIndex[bk] === undefined) {
        ctx.bibIndex[bk] = ctx.bibOrder.length + 1;
        ctx.bibOrder.push(bk);
      }
      var blabel = bm[1] ? bm[1].trim() : '';
      if (blabel) {
        var yearM = /(\d{4})/.exec(blabel);
        var author = blabel.replace(/\(\d{4}\)/, '').replace(/,?\s*\d{4}\s*$/, '')
          .replace(/\\[A-Za-z]+\s*/g, '').trim();
        if (author && yearM) ctx.bibLabels[bk] = { author: author, year: yearM[1] };
      }
    }

// ---- 导言区 ----
    // 注意：不能按 `\begin{document}` / `\end{document}` 切分正文——
    // 真实文档（如 lshort）的代码示例里会出现这两个字面量的字符串，
    // 一旦按“第一个 \end{document}”截断，整章内容就会被吞掉。
    // 导言区宏由 parseBlocks 的 SKIP_MACROS 跳过，document 标记按普通标记丢弃。
    var preamble = src;

    // 定义行整段删除（\newcommand/\def/\let/\NewDocumentCommand…）：
    // 否则定义本身会当正文渲染出来，这是“未识别宏”残留的主要来源。
    var body = stripDefinitions(stripComments(src));

    ctx.meta.title = firstArg(preamble, 'title');
    ctx.meta.author = firstArg(preamble, 'author');
    ctx.meta.date = firstArg(preamble, 'date');
    var dcm = /\\documentclass\s*(\[[^\]]*\])?\s*\{([^}]+)\}/.exec(preamble);
    if (dcm) ctx.meta.documentclass = dcm[2];
    var pkgRe = /\\usepackage\s*(\[[^\]]*\])?\s*\{([^}]+)\}/g, pm;
    while ((pm = pkgRe.exec(preamble)) && ctx.meta.packages.length < 40) {
      pm[2].split(',').forEach(function (p) {
        var v = p.trim();
        if (v && ctx.meta.packages.indexOf(v) < 0) ctx.meta.packages.push(v);
      });
    }
    // \title 里可能的 \\ 换行 → 空格
    // 标题/作者/日期里的 \thanks：收集并在原位置留上标编号
    ctx.meta.thanks = [];
    (function () {
      var mark = 0;
      ['title', 'author', 'date'].forEach(function (k) {
        ctx.meta[k] = String(ctx.meta[k] || '').replace(/\\thanks\s*\{([^{}]*)\}/g, function (m, t) {
          mark++;
          ctx.meta.thanks.push(t);
          return '\\textsuperscript{' + mark + '}';
        });
      });
    })();
    ['title', 'author', 'date'].forEach(function (k) {
      ctx.meta[k] = String(ctx.meta[k] || '').replace(/\\\\/g, ' ').replace(/\\thanks\s*\{[^}]*\}/g, '');
    });

    // ---- 宏定义先收集，正文里才能展开 ----
    // 1) 同目录 .sty/.cls 里抽出来的定义（宿主提供）：优先收集，
    //    这样 \cmd、\CTAN 这类包内宏能真正展开，而不是按未知处理。
    if (opts && opts.extraDefs) collectMacros(opts.extraDefs, ctx);
    // 2) 文档自己的定义
    collectMacros(src, ctx);

    // ---- 正文 ----
    var html;
    try {
      html = parseBlocks(body.split('\n'), ctx, 0);
    } catch (e) {
      ctx.warn('解析异常：' + (e && e.message ? e.message : e));
      html = '<pre class="code"><code>' + esc(src) + '</code></pre>';
    }

    // 标题块：有 \title 但正文没 \maketitle
    if (ctx.meta.title && html.indexOf('doc-title') < 0) {
      html = titleBlock(ctx) + html;
    }

    // 交叉引用：把所有占位 span 换成已知编号（解析在全部内容之后统一做）
    html = resolveRefs(html, ctx);

    // 脚注区
    if (ctx.footnotes.length) {
      html += '<hr class="fn-sep" /><div class="footnotes">';
      ctx.footnotes.forEach(function (f, idx) {
        html += '<div class="fn" id="' + f.id + '"><span class="fn-no">' + (idx + 1) + '.</span> ' +
          f.html + '</div>';
      });
      html += '</div>';
    }

    // 版式配置：documentclass/宏包 → profile，结构与 CSS 都只认 profile
    var profile = 'default';
    var dc = String(ctx.docClass || '');
    if (/tufte/.test(dc)) profile = 'tufte';
    else if (/beamer/.test(dc)) profile = 'beamer';
    else if (/ctex/i.test(dc)) profile = 'cjk';

    var hEnd = html.indexOf('</header>');
    var head = '', rest = html;
    if (hEnd > 0) { head = html.slice(0, hEnd + 9); rest = html.slice(hEnd + 9); }
    var notesHtml = '';
    if (profile === 'tufte' && ctx.marginNotes && ctx.marginNotes.length) {
      notesHtml = '<div class="margin-notes">' + ctx.marginNotes.map(function (h, i) {
        var n = i + 1;
        return '<aside class="sidenote" data-note="' + n +
          '" style="position-anchor:--qln' + n + '; top:anchor(--qln' + n + ' top)">' + h + '</aside>';
      }).join('') + '</div>';
    }
    html = '<div class="doc-layout" data-profile="' + profile + '">' + head +
      '<div class="doc-main">' + rest + '</div>' + notesHtml + '</div>';

    return {
      html: html,
      meta: ctx.meta,
      headings: ctx.headings,
      warnings: ctx.warnings,
      unknown: ctx.unknown,
      unknownTotal: ctx.unknownTotal || ctx.unknown.length,
      stats: {
        math: ctx.math,
        blocks: (html.match(/<(p|h[1-5]|ul|ol|dl|pre|table|figure|div)\b/g) || []).length,
        chars: src.length,
        lines: src.split('\n').length
      }
    };
  }

  global.TeXRender = { render: render, version: '1.0.0' };

})(window);
