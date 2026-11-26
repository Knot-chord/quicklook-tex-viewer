/*!
 * tex-vocab.js — 渲染器的词汇表/常量（数据与逻辑分离）
 * ------------------------------------------------------------------
 * 这里只有"数据"：哪些宏静默、哪些宏吃几个参数、哪些字符映射成什么。
 * 解析逻辑在 tex-renderer.js；构建时两个文件都会被内联进页面。
 */
(function (global) {
  'use strict';

var MATH_ENVS = {
  'equation': 1, 'equation*': 1,
  'align': 1, 'align*': 1,
  'alignat': 1, 'alignat*': 1,
  'flalign': 1, 'flalign*': 1,
  'gather': 1, 'gather*': 1,
  'multline': 1, 'multline*': 1,
  'eqnarray': 1, 'eqnarray*': 1,
  'displaymath': 1, 'math': 1,
  'split': 1, 'aligned': 1, 'gathered': 1, 'alignedat': 1
};

// 定理类环境
var THEOREM_ENVS = {
  theorem: 1, lemma: 1, definition: 1, proposition: 1,
  corollary: 1, example: 1, remark: 1, proof: 1,
  conjecture: 1, claim: 1, assumption: 1, exercise: 1,
  problem: 1, solution: 1, note: 1
};

// 顶层出现时直接跳过的导言区宏
var SKIP_MACROS = {
  documentclass: 1, usepackage: 1, pagestyle: 1, thispagestyle: 1,
  setlength: 1, addtolength: 1, newcommand: 1,
  renewcommand: 1, providecommand: 1, def: 1, newenvironment: 1,
  renewenvironment: 1, input: 0, include: 0, // input/include 由应用层展开，残留则跳过
  graphicspath: 1, bibliography: 1, bibliographystyle: 1,
  hypersetup: 1, geometry: 1, linespread: 1, numberwithin: 1,
  titleformat: 1, titlerule: 1, ctitlestyle: 1, newtheorem: 1,
  lstset: 1, lstdefinestyle: 1, definecolor: 1, tikzset: 1,
  usetikzlibrary: 1, pageref: 0
};

// 「静默丢弃」的宏：字号、字体开关、条件编译、类/包内部宏。
// 这类宏数量极多，逐条上报只会把 UI 撑成列表；正确做法是认识它们、然后忽略。
var SILENT_MACROS = {
    Return: 1, State: 1, Statex: 1, KwIn: 1, KwOut: 1, KwData: 1, KwResult: 1, KwTo: 1,
    EndIf: 1, EndFor: 1, EndWhile: 1, EndFunction: 1, EndProcedure: 1, Repeat: 1, Until: 1, Loop: 1, EndLoop: 1,
  huge: 1, Huge: 1, LARGE: 1, Large: 1, large: 1, normalsize: 1, small: 1,
  footnotesize: 1, scriptsize: 1, tiny: 1, smaller: 1, larger: 1,
  normalfont: 1, rmfamily: 1, sffamily: 1, ttfamily: 1, mdseries: 1,
  bfseries: 1, upshape: 1, itshape: 1, slshape: 1, scshape: 1,
  if: 1, ifx: 1, ifnum: 1, ifdim: 1, ifdefined: 1, ifcsname: 1,
  ifPDFTeX: 1, ifXeTeX: 1, ifLuaTeX: 1, ifCLASSINFOpdf: 1,
  else: 1, fi: 1, or: 1, orelse: 1, undefined: 1, expandafter: 1, noexpand: 1,
  csname: 1, endcsname: 1, makeatletter: 1, makeatother: 1, AtBeginDocument: 1,
  AtEndDocument: 1, global: 1, long: 1, outer: 1, begingroup: 1, endgroup: 1,
  makeindex: 1, printindex: 1, index: 1, newif: 1, let: 1, edef: 1, gdef: 1,
  xdef: 1, newcounter: 1, setcounter: 1, addtocounter: 1, stepcounter: 1,
  pagestyle: 1, thispagestyle: 1, pagenumbering: 1, appendix: 1,
  frontmatter: 1, mainmatter: 1, backmatter: 1,
  addtocontents: 1, addcontentsline: 1, hypersetup: 1, graphicpath: 1,
  linespread: 1, vskip: 1, hskip: 1, hfil: 1, vfil: 1, hss: 1, vss: 1,
  noindent: 1, indent: 1, centering: 1, raggedright: 1, raggedleft: 1,
  endinput: 1, DeclareMathOperator: 1, DeclareRobustCommand: 1,
  providecommand: 1, newtheorem: 1, usetheme: 1, usecolortheme: 1, usefonttheme: 1,
  institute: 1, titlegraphic: 1, bibliography: 1, bibliographystyle: 1,
  Verbatim: 1, lstset: 1, lstdefinestyle: 1, definecolor: 1, color: 1,
  pdfbookmark: 1, bookmark: 1, phantomsection: 1, nopagebreak: 1,
  leavevmode: 1, fill: 1, rightmark: 1, leftmark: 1, makelabel: 1,
  extracolsep: 1, relax: 1, noalign: 1, string: 1,
  pdfstringdef: 1, texorpdfstring: 1, texorpdfstringstar: 1,
  // 实测最高频的一批（来自 booktabs 表格、pandoc 输出、lshort 的索引宏）
  hline: 1, vrule: 1, arraybackslash: 1, newblock: 1, testdimen: 1,
  advance: 1, cnt: 1, int: 1, p: 1, Gscale: 1, crcmd: 1, cmdindex: 1,
  envindex: 1, pandoc: 1, footnotemark: 1, hrulefill: 1, smallskip: 1,
  medskip: 1, bigskip: 1, noalign: 1, tabularnewline: 1,
  // 类/包内部宏（只影响样式与盒模型，静默处理）
  defaultfontfeatures: 1, UseMicrotypeSet: 1, patchcmd: 1, newsavebox: 1,
  sbox: 1, usebox: 1, savebox: 1, dimexpr: 1, ht: 1, dp: 1, wd: 1,
  medskipamount: 1, smallskipamount: 1, bigskipamount: 1,
  setlength: 1, addtolength: 1, settoheight: 1, settowidth: 1,
  itemsep: 1, parsep: 1, topsep: 1, allowbreak: 1, dotfill: 1,
  flushleft: 1, flushright: 1, leftskip: 1, rightskip: 1,
  ifpdf: 1, pdfoutput: 1, oneinch: 1, lay: 1, em: 1, xydef: 1,
  ifoddsidelayout: 1, documentclass: 1, usepackage: 1, RequirePackage: 1,
  fontdimen: 1, textfont: 1, fancyhead: 1, fancyfoot: 1, oneinchtext: 1,
  LayOutbs: 1, pdffalse: 1, pdftrue: 1, colrule: 1, IEEEpeerreviewmaketitle: 1,
  title: 1, author: 1, date: 1, thanks: 1, affiliation: 1, altaffiliation: 1,
  titlepage: 1, totalheight: 1, labelwidth: 1, bbnumcustom: 1,
  // 最后一批：TeX 内部量/列表参数/字体选择
  itemindent: 1, leftmargin: 1, labelsep: 1, labelwidth: 1, endlist: 1,
  lineskip: 1, newdimen: 1, divide: 1, selectfont: 1, font: 1, char: 1,
  hyphenchar: 1, layoutpicture: 1, printbibliography: 1
};

// 代码/逐字环境统一名单：既是“注释剥离要跳过”的范围，
// 也是“内容原样当代码显示”的范围。类文件里自定义的 example 环境就是这种（内部走 verbatim）。
var CODE_ENVS = 'verbatim\\*?|Verbatim|lstlisting|minted|alltt|filecontents\\*?|code|latexcode|texcode|sample|demo|listing|example\\*?';

// 静默宏里“带参数”的那些：命令丢掉时必须把参数一起吃掉，
// 否则 {\hypersetup{...}} 的正文会漏到页面上（真实事故：标题上方出现 pdfTitle=…）。
// 只做配置、不产生输出的命令（宏包设置类）。语义：吃掉参数，页面上什么都不留。
// 漏了它们，参数会被当正文打印（实测：\setkeys{Gin}{...} 会漏出 "Ginwidth=,..."）。
var CONFIG_ARGS = {
    theoremstyle: 1,
  setkeys: 2, fvset: 1, ctexset: 1, geometry: 1, newgeometry: 1, restoregeometry: 1,
  sisetup: 1, pgfplotsset: 1, psset: 1, graphicspath: 1, captionsetup: 1,
  numberswithin: 1, floatplacement: 1, usefonttheme: 1, setbeamertemplate: 2,
  setbeamercolor: 2, setbeamerfont: 2, urlstyle: 1, declaretheorem: 2
};

var SILENT_ARGS = {
  hypersetup: 1, title: 1, author: 1, date: 1, thanks: 1, affiliation: 1,
  altaffiliation: 1, institute: 1, usetheme: 1, usecolortheme: 1, usefonttheme: 1,
  titlegraphic: 1, newcounter: 1, setcounter: 2, addtocounter: 2, stepcounter: 1,
  pagestyle: 1, thispagestyle: 1, pagenumbering: 1, addcontentsline: 3,
    setCJKmainfont: 1, setCJKsansfont: 1, setCJKmonofont: 1, setCJKfamilyfont: 1,
    setmainfont: 1, setsansfont: 1, setmonofont: 1, setmathfont: 1, newfontfamily: 1,
    setstretch: 1, fontsize: 2, CJKsetup: 1, defaultfontfeatures: 1,
    setlength: 2, addtolength: 2, settowidth: 2, ctexset: 2,
  addtocontents: 2, graphicpath: 1, linespread: 1, vspace: 1, hspace: 1,
  bibliography: 1, bibliographystyle: 1, DeclareMathOperator: 2,
  DeclareRobustCommand: 2, providecommand: 2, newtheorem: 2, newif: 1,
  setlength: 2, addtolength: 2, settoheight: 2, settowidth: 2, index: 1,
  lstset: 1, lstdefinestyle: 2, definecolor: 3, color: 1,
  pdfbookmark: 2, bookmark: 2, pdfstringdef: 1, texorpdfstring: 2,
  pdfstringdef: 1, texorpdfstring: 2
};

// 版面尺寸宏：渲染成空（或水平线），避免被当成未知命令
var DIMENSION_NAMES = {
  textwidth: 1, linewidth: 1, columnwidth: 1, hsize: 1, vsize: 1,
  textheight: 1, paperwidth: 1, paperheight: 1,
  parindent: 1, parskip: 1, baselineskip: 1, baselinestretch: 1,
  topmargin: 1, oddsidemargin: 1, evensidemargin: 1, headheight: 1,
  footskip: 1, arraycolsep: 1, tabcolsep: 1, fboxsep: 1, fboxrule: 1,
  hrule: 'hr', hrulefill: 'hr', dotfill: 0
};

// 这些环境插件不渲染内容语义，但必须原样当代码块显示（而不是逐行误解析）
var RAW_ENVS = {
   code: 1, latexcode: 1, texcode: 1,
  sample: 1, demo: 1, listing: 1,
  'verbatim': '', 'verbatim*': '', 'lstlisting': '', 'minted': '', 'alltt': '',
  'tikzpicture': '',
  'tikzcd': '',
  'pspicture': '',
  'picture': '',
  
  'verbatimtab': ''
};

// 单字符命令
var CHAR_SYMBOLS = {
  '&': '&amp;', '%': '%', '$': '$', '#': '#', '_': '_',
  '{': '{', '}': '}', ' ': '\u00a0', ',': '\u2009', ';': '\u2005',
  ':': '\u2005', '!': '', '/': '', '-': '', '\\': ''
};

var TEXT_SYMBOLS = {
  ldots: '…', dots: '…', textellipsis: '…',
  textbackslash: '\\', textasciitilde: '~', textasciicircum: '^',
  textbar: '|', textless: '&lt;', textgreater: '&gt;',
  copyright: '©', textcopyright: '©', textregistered: '®',
  texttrademark: '™', dag: '†', ddag: '‡', S: '§', P: '¶',
  pounds: '£', euro: '€', texteuro: '€', textdegree: '°',
  textendash: '–', textemdash: '—', textbullet: '•',
  LaTeX: '<span class="tex-logo">LaTeX</span>',
  TeX: '<span class="tex-logo">T<sub>e</sub>X</span>',
  XeLaTeX: '<span class="tex-logo">XeLaTeX</span>',
  LuaLaTeX: '<span class="tex-logo">LuaLaTeX</span>',
  BibTeX: '<span class="tex-logo">BibTeX</span>',
  quad: '\u2003', qquad: '\u2003\u2003', enspace: '\u2002',
  thinspace: '\u2009', negthinspace: '', hfill: '\u2003', hfil: '',
  bigskip: '', smallskip: '', vfill: '',
  centering: '', raggedright: '', raggedleft: '',
  relax: '', protect: '', displaystyle: '', textstyle: '',
  scriptstyle: '', limits: '', nolimits: '', nonumber: '', notag: '',
  newline: '', linebreak: '', pagebreak: '', newpage: '', clearpage: '',
  cleardoublepage: '', par: '', indent: '',
  maketitle: '', tableofcontents: '', listoffigures: '', listoftables: '',
  appendix: '', frontmatter: '', mainmatter: '', backmatter: '',
  // 特殊字母（德语/北欧/法语）
  o: 'ø', O: 'Ø', aa: 'å', AA: 'Å', ss: 'ß', SS: 'SS', ae: 'æ', AE: 'Æ',
  oe: 'œ', OE: 'Œ', l: 'ł', L: 'Ł', i: 'ı', j: 'ȷ',
  textvisiblespace: '␣', textunderscore: '_', fatsemi: '⨿',
  iint: '∬', iiint: '∭', idotsint: '∫⋯∫',
  textasteriskcentered: '＊', textperiodcentered: '·', textdagger: '†',
  textexclamdown: '¡', textquestiondown: '¿',
  textguillemotleft: '«', textguillemotright: '»',
  today: null // 特殊：运行时填日期
};

  // 所有“吃参数但不输出”的命令合并成一张表（原 SILENT_ARGS + CONFIG_ARGS）
  var NO_OUTPUT_ARGS = Object.assign({}, SILENT_ARGS, CONFIG_ARGS);

  global.TeXViewerVocab = {
    MATH_ENVS: MATH_ENVS, THEOREM_ENVS: THEOREM_ENVS, SKIP_MACROS: SKIP_MACROS,
    SILENT_MACROS: SILENT_MACROS, CODE_ENVS: CODE_ENVS, NO_OUTPUT_ARGS: NO_OUTPUT_ARGS,
    DIMENSION_NAMES: DIMENSION_NAMES, RAW_ENVS: RAW_ENVS,
    CHAR_SYMBOLS: CHAR_SYMBOLS, TEXT_SYMBOLS: TEXT_SYMBOLS
  };
})(typeof window !== 'undefined' ? window : globalThis);
