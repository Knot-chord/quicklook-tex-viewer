// TeXPanel — 基于 QuickLook 官方 WebpagePanel 的 LaTeX 预览面板
// ---------------------------------------------------------------------------
// 遵循随包插件（ChmViewer / HtmlViewer / MarkdownViewer）的既有做法：
//   * 继承 WebpagePanel：WebView2 生命周期、UserDataFolder、深色底、
//     运行时缺失兜底、外部链接拦截、Dispose 全部交给框架
//   * 虚拟源站用 http://quicklook.invalid/（正常 origin，不是 file://quicklook/）
//   * 嵌入资源用静态字典 + CreateWebResourceResponse
//   * 相对图片回退用基类的 FallbackPath 机制（目录白名单在这里收紧）
// 本项目只补框架没有的三件事：把 tex2html.html + MathJax 挂到虚拟源站、
// 预处理（编码探测 / \input 展开 / 图片内联）、open-tex 消息投递。
// ---------------------------------------------------------------------------

using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using QuickLook.Common.Helpers;
using QuickLook.Common.Plugin;
using QuickLook.Plugin.HtmlViewer;
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Text;
using System.Linq;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;

namespace QuickLook.Plugin.TeXViewer
{
    public sealed partial class TeXPanel : WebpagePanel
    {
        private const string VirtualHost = "http://quicklook.invalid/";

        private const string ResourcePrefix = "QuickLook.Plugin.TeXViewer.Resources.";
        private const int MaxInputDepth = 3;
        private const int MaxInputFiles = 48;

        private static readonly Dictionary<string, byte[]> ResourceMap = LoadResources();

        /// <summary>诊断日志：优先 QuickLook 数据目录，失败退到临时目录。</summary>
        internal static readonly string TracePath = ResolveTracePath();

        private static readonly string TranslationFile =
            Path.Combine(Path.GetDirectoryName(typeof(TeXPanel).Assembly.Location) ?? string.Empty,
                         "Translations.config");

        private byte[] _page;
        private string _message;
        private string _baseDir = string.Empty;
        private int _resourceHits;
        private DateTime _navigatedAt;
        private bool _pageReady;

        /// <summary>首屏文本可见时回调（用于收起 QuickLook 忙碌指示）；复用面板时会被替换。</summary>
        public Action PaintedCallback { get; set; }

        /// <summary>公式排版完成回调（仅诊断计时）。</summary>
        public Action RenderedCallback { get; set; }

        // ---- 编译缓存：{数据目录}\TeXViewer.Cache\<源码hash>.html ----
        private static readonly string CacheDir = Path.Combine(SettingHelper.LocalDataPath, "TeXViewer.Cache");
        private const string CacheVersion = "v2";
        // 上限按“压缩后”的字节算：gzip 后通常只有原 HTML 的 10%~25%
        private const int CacheMaxFiles = 120;
        private const long CacheMaxBytes = 64L * 1024 * 1024;
        private const int CacheTtlDays = 14;

        private bool _cacheEnabled = true;     // Preview 里按配置更新一次
        private string _pkgDefs = string.Empty; // 同目录 .sty/.cls 里抽出的宏定义
        private string _cacheKey;
        private string _errorText;
        private string _cacheUrl;          // 命中时下发给页面；未命中为 null
        private string _cacheWritePath;    // 正在写的 .tmp
        private Stream _cacheWriteStream;

        // ---- 面板复用：跨预览保留 WebView2 与已加载的页面/MathJax ----
        private static TeXPanel _shared;
        private static bool _pruned;

        public static TeXPanel Acquire()
        {
            bool reuse = true;
            try { reuse = SettingHelper.Get("ReuseWebView", true, "QuickLook.Plugin.TeXViewer"); }
            catch (Exception) { }

            if (reuse && _shared != null && _shared.IsUsable())
            {
                Trace("Acquire: 复用已有面板（跳过 WebView2 冷启动与 MathJax 重新加载）");
                return _shared;
            }

            if (_shared != null)
            {
                Trace("Acquire: 旧面板不可用，重建");
                try { _shared.Dispose(); } catch (Exception) { }
                _shared = null;
            }

            if (!_pruned) { _pruned = true; PruneCache(); }
            _shared = new TeXPanel();
            return _shared;
        }

        public static void Discard()
        {
            if (_shared == null) return;
            try { _shared.PaintedCallback = null; _shared.Dispose(); }
            catch (Exception) { }
            _shared = null;
        }

        /// <summary>给宿主判断：这个面板还能不能再拿来用。</summary>
        public bool IsUsable()
        {
            try { return _webView != null && _webView.CoreWebView2 != null; }
            catch (Exception) { return false; }
        }

        internal static string UserDataFolder()
        {
            string overrideDir = Environment.GetEnvironmentVariable("TEXVIEWER_USERDATA");
            if (!string.IsNullOrWhiteSpace(overrideDir)) return overrideDir;
            return Path.Combine(SettingHelper.LocalDataPath, "WebView2_Data");
        }

        public TeXPanel()
        {
            if (_webView == null)
            {
                // 框架已经用“下载 WebView2 运行时”按钮兜底
                Trace("ctor: WebView2 不可用（框架兜底）");
                return;
            }

            if (!ResourceMap.TryGetValue("/tex2html.html", out _page) || _page == null || _page.Length == 0)
            {
                Trace("ctor: 嵌入资源 tex2html.html 缺失");
                Content = BuildNotice("插件资源缺失：tex2html.html（安装包不完整）");
                return;
            }

            // 调试/本地宿主可用环境变量指定独立用户数据目录，避免争抢
            string userData = Environment.GetEnvironmentVariable("TEXVIEWER_USERDATA");
            if (!string.IsNullOrWhiteSpace(userData))
            {
                try
                {
                    _webView.CreationProperties = new CoreWebView2CreationProperties
                    {
                        UserDataFolder = userData,
                    };
                }
                catch (Exception ex) { Trace("ctor: 覆盖 UserDataFolder 失败 " + ex.Message); }
            }

            ApplyBackground();
            StartWatchdog();
        }

        /// <summary>QuickLook 传入的主题（None 表示跟随系统）。</summary>
        public Themes Theme { get; set; } = Themes.None;

        /// <summary>仅供本地宿主测试：拿 CoreWebView2 执行断言脚本。</summary>
        public CoreWebView2 Core => _webView == null ? null : _webView.CoreWebView2;

        private bool IsDark()
        {
            if (Theme == Themes.Dark) return true;
            if (Theme == Themes.Light) return false;
            try { return OSThemeHelper.AppsUseDarkTheme(); }
            catch (Exception) { return false; }
        }

        private void ApplyBackground()
        {
            try
            {
                _webView.DefaultBackgroundColor = IsDark()
                    ? System.Drawing.Color.FromArgb(255, 30, 30, 32)
                    : System.Drawing.Color.White;
            }
            catch (Exception) { }
        }

        private void StartWatchdog()
        {
            var watchdog = new System.Windows.Threading.DispatcherTimer
            {
                Interval = TimeSpan.FromSeconds(10),
            };
            watchdog.Tick += (s, e) =>
            {
                watchdog.Stop();
                if (_webView?.CoreWebView2 != null) return;
                Trace("watchdog: WebView2 初始化超时");
                Content = BuildNotice(T("TeX_WebView2Timeout",
                    "WebView2 初始化超时。\n\n诊断日志：") + (TracePath ?? "-"));
            };
            watchdog.Start();
        }

        /* ------------------------------------------------------------------ */
        /* 对外：准备并显示                                                  */
        /* ------------------------------------------------------------------ */

        public void Preview(string path, bool sourceOnly)
        {
            _errorText = null;
            // 注意：缓存清理由 Show() 在进入后台线程前统一做，这里不要重复调用，
            // 否则会和消息线程上的写缓存流打架。
            try
            {
                _baseDir = Path.GetDirectoryName(path) ?? string.Empty;

                byte[] raw = File.ReadAllBytes(path);
                string text = DecodeText(raw);
                text = text.Replace("\r\n", "\n").Replace('\r', '\n');

                if (!sourceOnly)
                {
                    var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { Path.GetFullPath(path) };
                    text = ExpandInputs(text, _baseDir, 0, seen);
                }

                int noteCount = Regex.Matches(text, @"% \[note\]").Count;
                Trace("Expand: chars=" + text.Length + " notes=" + noteCount);

                // 同目录的 .sty/.cls：把里面的宏定义抽出来一起交给页面（不执行包代码）
                _pkgDefs = CollectPackageDefinitions(text, _baseDir);

                // 编译缓存：键 = 展开后源码 + 包定义 的哈希
                _cacheKey = ComputeCacheKey(text + "\n|pkg|" + _pkgDefs);
                _cacheEnabled = true;
                try { _cacheEnabled = SettingHelper.Get("EnableCache", true, "QuickLook.Plugin.TeXViewer"); }
                catch (Exception) { }
                if (!_cacheEnabled)
                {
                    _cacheUrl = null;
                    Trace("Cache: 已在配置里关闭");
                    _message = BuildMessage(text, Path.GetFileName(path), sourceOnly,
                        CollectImagesJson(text, _baseDir), null);
                    return;
                }
                string cachePath = Path.Combine(CacheDir, _cacheKey + ".html.gz");
                _cacheUrl = null;
                if (File.Exists(cachePath))
                {
                    _cacheUrl = "/__cache__/" + _cacheKey + ".html.gz";
                    Trace("Cache: HIT " + _cacheKey.Substring(0, 12) + " (" +
                          new FileInfo(cachePath).Length + " B)");
                }
                else
                {
                    Trace("Cache: MISS " + _cacheKey.Substring(0, 12));
                }

                string imagesJson = CollectImagesJson(text, _baseDir);
                _message = BuildMessage(text, Path.GetFileName(path), sourceOnly, imagesJson, _cacheUrl, _pkgDefs);

                Trace("Preview: " + path + " bytes=" + raw.Length + " chars=" + text.Length +
                      " sourceOnly=" + sourceOnly + " images=" + (imagesJson == null ? 0 : 1) +
                      " msgLen=" + _message.Length);
            }
            catch (Exception e)
            {
                Trace("Preview 失败：" + e);
                _message = null;
                _errorText = T("TeX_ReadFailed", "读取文件失败：") + e.Message;   // UI 线程再显示，避免跨线程建控件
            }
        }

        /// <summary>
        /// 显示一份文档。页面已就绪时只投递消息（毫秒级）；否则导航加载页面。
        /// </summary>
        public void Show(string path, bool sourceOnly, Themes theme)
        {
            bool themeChanged = theme != Theme;
            Theme = theme;
            ApplyBackground();

            AbortCacheWrite();

            var dispatcher = System.Windows.Application.Current != null
                ? System.Windows.Application.Current.Dispatcher
                : null;

            // 读文件、\input 展开、图片 base64、SHA256 都是纯 CPU/IO：丢线程池执行，窗口不被占住。
            System.Threading.Tasks.Task.Run(() =>
            {
                try { Preview(path, sourceOnly); }
                catch (Exception ex) { Trace("Preview 失败：" + ex.Message); }

                Action apply = () => ApplyPrepared(themeChanged, theme);
                OnUi(dispatcher, apply);

            });
        }

        private static void OnUi(System.Windows.Threading.Dispatcher dispatcher, Action action)
        {
            try
            {
                if (dispatcher == null) action();
                else dispatcher.BeginInvoke(action);
            }
            catch (Exception ex) { Trace("UI 调度失败：" + ex.Message); }
        }

        /// <summary>UI 线程：页面已就绪就直接投递，否则导航加载页面。</summary>
        private void ApplyPrepared(bool themeChanged, Themes theme)
        {
            if (_webView == null)
                return;

            if (!string.IsNullOrEmpty(_errorText))
            {
                Content = BuildNotice(_errorText);
                _errorText = null;
                return;
            }

            if (!_pageReady || _webView.CoreWebView2 == null)
            {
                Navigate();          // 首次：加载页面，NavigationCompleted 里再投递
                return;
            }

            if (themeChanged) SendTheme(theme);
            PostMessage();
        }

        private void SendTheme(Themes theme)
        {
            try
            {
                _webView.CoreWebView2.PostWebMessageAsJson(
                    "{\"type\":\"set-theme\",\"payload\":{\"theme\":\"" +
                    (theme == Themes.Dark ? "dark" : theme == Themes.Light ? "light" : "auto") + "\"}}");
            }
            catch (Exception ex) { Trace("SendTheme 失败：" + ex.Message); }
        }

        private void PostMessage()
        {
            try
            {
                _navigatedAt = DateTime.Now;
                _webView.CoreWebView2.PostWebMessageAsJson(
                    _message ?? BuildMessage(string.Empty, "document.tex", true, null));
                Trace("Show: 复用页面直接投递 (" + (_message == null ? 0 : _message.Length) + " chars)");
            }
            catch (Exception ex)
            {
                Trace("PostMessage 失败，回退到重新导航：" + ex.Message);
                _pageReady = false;
                Navigate();
            }
        }

        /// <summary>开始导航到内置页面（初始化由基类在设置 Source 时触发，不会死锁）。</summary>
        public void Navigate()
        {
            if (_webView == null)
                return;

            // 基类的相对文件回退目录（图片已内联，这里只是兜底）
            FallbackPath = _baseDir;

            string theme = IsDark() ? "dark" : "light";
            Trace("Navigate: " + VirtualHost + "?plugin=1&theme=" + theme);
            NavigateToUri(new Uri(VirtualHost + "?plugin=1&theme=" + theme));
        }

        /* ------------------------------------------------------------------ */
        /* 框架扩展点                                                        */
        /* ------------------------------------------------------------------ */

        protected override void WebView_NavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            base.WebView_NavigationCompleted(sender, e);   // 基类会把背景重置为白色
            ApplyBackground();                             // 恢复主题背景

            Trace("NavigationCompleted: success=" + e.IsSuccess + " status=" + e.WebErrorStatus);

            if (!e.IsSuccess || _webView?.CoreWebView2 == null)
            {
                Content = BuildNotice(T("TeX_PageLoadFailed", "页面加载失败：") +
                                      e.WebErrorStatus + "\n" + (TracePath ?? "-"));
                return;
            }

            try
            {
                _webView.CoreWebView2.WebMessageReceived -= OnWebMessageReceived;
                _webView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;

                _navigatedAt = DateTime.Now;
                _pageReady = true;
                _webView.CoreWebView2.PostWebMessageAsJson(
                    _message ?? BuildMessage(string.Empty, "document.tex", true, null));
                Trace("NavigationCompleted: posted message (" + (_message == null ? 0 : _message.Length) + " chars)");
            }
            catch (Exception ex)
            {
                Trace("NavigationCompleted: post 失败 " + ex);
            }
        }

        private static string MsgType(string json, Dictionary<string, object> parsed)
        {
            if (parsed != null)
            {
                object t;
                if (parsed.TryGetValue("type", out t) && t != null) return Convert.ToString(t);
            }
            // 旧格式/无 type 时退回子串判断（页面版本不一致时的兼容路径）
            string[] known = { "open-file", "math-error", "cache-begin", "cache-chunk", "cache-end", "tex-painted", "tex-rendered" };
            foreach (string k in known) if (json.IndexOf(k, StringComparison.Ordinal) >= 0) return k;
            return null;
        }

        private void OnWebMessageReceived(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            try
            {
                string json = e.WebMessageAsJson ?? string.Empty;
                var msg = ParseJson(json);
                string type = MsgType(json, msg);
                double sinceNav = (DateTime.Now - _navigatedAt).TotalMilliseconds;

                if (type == "open-file")
                {
                    var od = msg;
                    object op;
                    if (od != null && od.TryGetValue("payload", out op))
                    {
                        var opd = op as Dictionary<string, object>;
                        object pth;
                        if (opd != null && opd.TryGetValue("path", out pth) && pth != null)
                        {
                            try
                            {
                                string full = Path.GetFullPath(Path.Combine(_baseDir ?? string.Empty,
                                    pth.ToString().Replace('/', '\\')));
                                string baseFull = Path.GetFullPath(_baseDir ?? string.Empty)
                                    .TrimEnd('\\') + "\\";
                                bool inside = !string.IsNullOrEmpty(_baseDir) &&
                                    full.StartsWith(baseFull, StringComparison.OrdinalIgnoreCase);
                                if (inside && File.Exists(full) &&
                                    string.Equals(Path.GetExtension(full), ".pdf", StringComparison.OrdinalIgnoreCase))
                                {
                                    Trace("OpenFile: 交给 QuickLook → " + full);
                                    QuickLook.Common.Helpers.PluginHelper.InvokePreview(full);
                                }
                                else Trace("OpenFile: 拒绝（越界/不存在/非 PDF）");
                            }
                            catch (Exception ex) { Trace("OpenFile: 失败 " + ex.Message); }
                        }
                    }
                    return;
                }
                if (type == "math-error")
                {
                    var d = msg;
                    object pl;
                    if (d != null && d.TryGetValue("payload", out pl))
                    {
                        var pd = pl as Dictionary<string, object>;
                        object tx;
                        if (pd != null && pd.TryGetValue("tex", out tx))
                            Trace("MathError: " + (tx == null ? "" : tx.ToString().Replace("\n", " ")));
                    }
                    return;
                }

                if (type == "cache-begin") { BeginCacheWrite(); return; }
                if (type == "cache-chunk") { AppendCacheChunk(json, msg); return; }
                if (type == "cache-end") { EndCacheWrite(); return; }

                if (type == "tex-painted")
                {
                    Trace(string.Format("page painted: +{0:F0} ms after navigate", sinceNav));
                    var h = PaintedCallback;
                    if (h != null) h();
                }
                else if (type == "tex-rendered")
                {
                    Trace(string.Format("page rendered: +{0:F0} ms after navigate", sinceNav));
                    var unk = msg;
                    object unkPayload;
                    if (unk != null && unk.TryGetValue("payload", out unkPayload))
                    {
                        var pd = unkPayload as Dictionary<string, object>;
                        object u2;
                        if (pd != null && pd.TryGetValue("unknown", out u2))
                        {
                            var arr = u2 as object[];
                            if (arr != null && arr.Length > 0)
                                Trace("unknown macros: " + string.Join(", ", arr.Select(o => Convert.ToString(o)).ToArray()));
                        }
                    }
                    var h2 = RenderedCallback;
                    if (h2 != null) h2();
                }
            }
            catch (Exception ex)
            {
                Trace("OnWebMessageReceived 异常：" + ex.Message);
            }
        }

        protected override void WebView_WebResourceRequested(object sender, CoreWebView2WebResourceRequestedEventArgs args)
        {
            try
            {
                var uri = new Uri(args.Request.Uri);

                // 非 virtual host 的请求（外链等）交给基类
                if (!string.Equals(uri.Authority, "quicklook.invalid", StringComparison.OrdinalIgnoreCase))
                {
                    base.WebView_WebResourceRequested(sender, args);
                    return;
                }

                _resourceHits++;
                if (_resourceHits <= 12) Trace("WebResource: " + args.Request.Uri);

                string path = Uri.UnescapeDataString(uri.AbsolutePath);

                // 1) 内置页面
                if (path == "/" || string.Equals(path, "/index.html", StringComparison.OrdinalIgnoreCase))
                {
                    args.Response = Respond(_page, "text/html; charset=utf-8", "Cache-Control: no-store");
                    return;
                }

                // 2) 打包的嵌入资源（MathJax）
                if (ResourceMap.TryGetValue(path, out byte[] res) && res != null)
                {
                    // 缓存 1 小时：同一进程内的重复预览直接命中浏览器缓存
                    args.Response = Respond(res, MimeFor(path),
                        "Cache-Control: max-age=3600");
                    return;
                }

                // 3) MathJax 的按需扩展离线不存在：返回空模块，避免 404 刷屏
                if (path.StartsWith("/mathjax/", StringComparison.OrdinalIgnoreCase))
                {
                    args.Response = Respond(Encoding.UTF8.GetBytes("/* offline stub */\n"),
                                           "application/javascript; charset=utf-8");
                    return;
                }

                // 3.5) 编译缓存回放
                if (path.StartsWith("/__cache__/", StringComparison.OrdinalIgnoreCase))
                {
                    string name = path.Substring("/__cache__/".Length);
                    if (Regex.IsMatch(name, "^[0-9a-f]{12}-h[0-9a-f]{8}\\.html\\.gz$"))
                    {
                        string cacheFile = Path.Combine(CacheDir, name);
                        if (File.Exists(cacheFile))
                        {
                            Trace("Cache: 回放 " + name.Substring(0, 12));
                            args.Response = Respond(File.ReadAllBytes(cacheFile),
                                "application/octet-stream", "Cache-Control: no-store");
                            return;
                        }
                    }
                    args.Response = Respond(Array.Empty<byte>(), "text/plain; charset=utf-8");
                    return;
                }

                // 4) 大图/未内联的图片：仅允许 .tex 所在目录子树
                string local = ResolveLocal(path);
                if (local != null)
                {
                    var stream = new FileStream(local, FileMode.Open, FileAccess.Read,
                        FileShare.ReadWrite | FileShare.Delete);
                    args.Response = _webView.CoreWebView2.Environment.CreateWebResourceResponse(
                        stream, 200, "OK", MimeTypes.GetContentType(Path.GetExtension(local)));
                    return;
                }

                args.Response = Respond(Array.Empty<byte>(), "text/plain; charset=utf-8");
            }
            catch (Exception e)
            {
                Trace("WebResource 异常：" + e);
            }
        }

        private string ResolveLocal(string urlPath)
        {
            if (string.IsNullOrEmpty(_baseDir))
                return null;

            string rel = urlPath.TrimStart('/').Replace('/', '\\');
            if (rel.Length == 0) return null;

            string full;
            try { full = Path.GetFullPath(Path.Combine(_baseDir, rel)); }
            catch (Exception) { return null; }
            if (!File.Exists(full)) return null;

            string rootDir = Path.GetFullPath(_baseDir).TrimEnd('\\') + "\\";
            if (!full.StartsWith(rootDir, StringComparison.OrdinalIgnoreCase))
            {
                Trace("ResolveLocal: 拒绝目录外文件 " + rel);
                return null;
            }
            return full;
        }

        private CoreWebView2WebResourceResponse Respond(byte[] bytes, string contentType, string extraHeader = null)
        {
            string headers = "Content-Type: " + contentType;
            if (!string.IsNullOrEmpty(extraHeader)) headers += "\r\n" + extraHeader;
            return _webView.CoreWebView2.Environment.CreateWebResourceResponse(
                new MemoryStream(bytes ?? Array.Empty<byte>(), false), 200, "OK", headers);
        }

        private static string MimeFor(string path)
        {
            switch (Path.GetExtension(path ?? string.Empty).ToLowerInvariant())
            {
                case ".html": case ".htm": return "text/html; charset=utf-8";
                case ".js": return "application/javascript; charset=utf-8";
                case ".css": return "text/css; charset=utf-8";
                case ".svg": return "image/svg+xml";
                case ".png": return "image/png";
                case ".json": return "application/json; charset=utf-8";
                default: return "application/octet-stream";
            }
        }

        /* ------------------------------------------------------------------ */
        /* 预处理                                                              */
        /* ------------------------------------------------------------------ */

        internal static string DecodeText(byte[] bytes)
        {
            if (bytes == null || bytes.Length == 0)
                return string.Empty;

            if (bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF)
                return Encoding.UTF8.GetString(bytes, 3, bytes.Length - 3);

            if (bytes.Length >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE)
                return Encoding.Unicode.GetString(bytes, 2, bytes.Length - 2);

            try
            {
                return new UTF8Encoding(false, true).GetString(bytes);
            }
            catch (DecoderFallbackException)
            {
                try { return Encoding.GetEncoding(54936).GetString(bytes); }   // GB18030
                catch (Exception) { return Encoding.UTF8.GetString(bytes); }
            }
        }

        internal static string ExpandInputs(string text, string baseDir, int depth, HashSet<string> seen)
        {
            if (string.IsNullOrEmpty(text) || depth > MaxInputDepth)
                return text;

            return Regex.Replace(text, @"\\(?:input|include|subfile)\s*\{([^}]+)\}", m =>
            {
                string rel = m.Groups[1].Value.Trim();
                if (rel.Length == 0) return m.Value;

                // 与 LaTeX 一致：先按原样找，找不到再补 .tex。
                // 不能靠“有没有点”判断扩展名——真实文档里 chap.01.basics 这种名字带点但无扩展名。
                string full = null;
                try
                {
                    string dir = baseDir ?? string.Empty;
                    string raw = Path.GetFullPath(Path.Combine(dir, rel.Replace('/', '\\')));
                    if (File.Exists(raw))
                    {
                        full = raw;
                    }
                    else
                    {
                        string withTex = Path.GetFullPath(raw + ".tex");
                        if (File.Exists(withTex)) full = withTex;
                    }
                }
                catch (Exception)
                {
                    return "% [note] invalid path: \\input{" + rel + "}";
                }

                if (full == null) return "% [note] missing include: " + rel;
                if (seen.Contains(full)) return "% [note] skipped duplicate include: " + rel;
                if (seen.Count >= MaxInputFiles) return "% [note] include limit reached: " + rel;

                seen.Add(full);
                try
                {
                    string sub = DecodeText(File.ReadAllBytes(full)).Replace("\r\n", "\n").Replace('\r', '\n');
                    string dir = Path.GetDirectoryName(full) ?? baseDir;
                    return "\n" + ExpandInputs(sub, dir, depth + 1, seen) + "\n";
                }
                catch (Exception e)
                {
                    return "% [note] include failed " + rel + ": " + e.Message;
                }
            });
        }

        /// <summary>
        /// 把 \includegraphics 的图片读成 data URI 随消息下发：页面不需要请求本地文件，
        /// 宿主也不必当“任意文件代理”。单张 2 MB、合计 6 MB。
        /// </summary>
#if WINRT_PDF
        /// <summary>PDF 插图首页 → PNG（实现见 PdfPageRenderer，插件与测试工具共用一份）。</summary>
        private static byte[] RenderPdfFirstPage(string pdfPath, int maxWidth)
        {
            byte[] png = PdfPageRenderer.RenderPageBytes(pdfPath, 0, maxWidth);
            Trace("PdfRender: " + Path.GetFileName(pdfPath) + (png == null ? " 失败" : " → " + png.Length + " B PNG"));
            return png;
        }
#endif
        // 图片失败的事实原因（宿主验证过：missing / too-large / pdf-render-failed）
        private string _imageIssues;

        private string CollectImagesJson(string tex, string baseDir)
        {
            _imageIssues = null;
            if (string.IsNullOrEmpty(tex) || string.IsNullOrEmpty(baseDir))
                return null;

            var issues = new List<string>();

            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var sb = new StringBuilder();
            long total = 0;

            foreach (Match m in Regex.Matches(tex, @"\\includegraphics\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}"))
            {
                string raw = m.Groups[1].Value.Trim();
                if (raw.Length == 0 || !seen.Add(raw)) continue;

                string rel = raw.Split(',')[0].Trim().Replace('/', '\\');
                string full;
                try { full = Path.GetFullPath(Path.Combine(baseDir, rel)); }
                catch (Exception) { issues.Add(JsonString(raw) + ":" + JsonString("invalid-path")); continue; }
                if (!File.Exists(full))
                {
                    issues.Add(JsonString(raw) + ":" + JsonString("missing"));
                    continue;
                }

                string ext = Path.GetExtension(full).ToLowerInvariant();
                bool isPdf = ext == ".pdf";
                bool isImage = ext == ".png" || ext == ".jpg" || ext == ".jpeg" || ext == ".gif" ||
                               ext == ".webp" || ext == ".bmp" || ext == ".svg";
#if WINRT_PDF
                if (!isImage && !isPdf) continue;      // PDF 由系统渲染成 PNG 后内联
#else
                if (!isImage) continue;
#endif

                long len = new FileInfo(full).Length;
                if (len > 2 * 1024 * 1024 || total + len > 6 * 1024 * 1024)
                {
                    issues.Add(JsonString(raw) + ":" + JsonString("too-large"));
                    continue;
                }

                try
                {
                    string mime = ext == ".svg"
                        ? "image/svg+xml"
                        : "image/" + (ext == ".jpg" ? "jpeg" : ext.Substring(1));
                    byte[] payload;
#if WINRT_PDF
                    if (isPdf)
                    {
                        payload = RenderPdfFirstPage(full, 1400);
                        if (payload == null)
                        {
                            issues.Add(JsonString(raw) + ":" + JsonString("pdf-render-failed"));
                            continue;
                        }
                        mime = "image/png";
                    }
                    else payload = File.ReadAllBytes(full);
#else
                    payload = File.ReadAllBytes(full);
#endif
                    string data = "data:" + mime + ";base64," + Convert.ToBase64String(payload);
                    if (sb.Length > 0) sb.Append(',');
                    sb.Append(JsonString(raw)).Append(':').Append(JsonString(data));
                    total += len;
                }
                catch (Exception) { }
            }

            _imageIssues = issues.Count == 0 ? null : string.Join(",", issues.ToArray());
            return sb.Length == 0 ? null : sb.ToString();
        }

        /* ------------------------------------------------------------------ */
        /* 消息 / 日志 / 资源                                                 */
        /* ------------------------------------------------------------------ */

        private string BuildMessage(string text, string name, bool sourceOnly, string imagesJson,
            string cacheUrl = null, string pkgDefs = null)
        {
            byte[] utf8 = Encoding.UTF8.GetBytes(text ?? string.Empty);
            string b64 = Convert.ToBase64String(utf8);
            string mode = sourceOnly ? "source" : "render";
            return "{\"type\":\"open-tex\",\"payload\":{\"base64\":\"" + b64 +
                   "\",\"name\":" + JsonString(name) +
                   ",\"mode\":\"" + mode + "\"" +
                   (string.IsNullOrEmpty(imagesJson) ? "" : ",\"images\":{" + imagesJson + "}") +
                   (string.IsNullOrEmpty(cacheUrl) ? "" : ",\"cache\":\"" + cacheUrl + "\"") +
                   (string.IsNullOrEmpty(pkgDefs) ? "" :
                       ",\"defs\":" + JsonString(pkgDefs)) +
                   (string.IsNullOrEmpty(_imageIssues) ? "" : ",\"issues\":{" + _imageIssues + "}") +
                   "}}";
        }

        // 统一用框架自带的 JSON 序列化（System.Web.Extensions 已引用），不再手写转义
        private static readonly JavaScriptSerializer JsonSer =
            new JavaScriptSerializer { MaxJsonLength = int.MaxValue };

        private static string JsonString(string s) { return JsonSer.Serialize(s ?? string.Empty); }

        private static Dictionary<string, byte[]> LoadResources()
        {
            var dict = new Dictionary<string, byte[]>(StringComparer.OrdinalIgnoreCase);
            Assembly asm = typeof(TeXPanel).Assembly;
            foreach (string name in asm.GetManifestResourceNames())
            {
                if (!name.StartsWith(ResourcePrefix, StringComparison.Ordinal)) continue;
                using (Stream s = asm.GetManifestResourceStream(name))
                {
                    if (s == null) continue;
                    using (var ms = new MemoryStream())
                    {
                        s.CopyTo(ms);
                        string rel = name.Substring(ResourcePrefix.Length).Replace('\\', '/');
                        dict["/" + rel] = ms.ToArray();
                    }
                }
            }
            return dict;
        }

        private static string ResolveTracePath()
        {
            try
            {
                string dir = SettingHelper.LocalDataPath;
                if (!string.IsNullOrWhiteSpace(dir))
                {
                    Directory.CreateDirectory(dir);
                    return Path.Combine(dir, "TeXViewer.trace.log");
                }
            }
            catch (Exception) { }

            try { return Path.Combine(Path.GetTempPath(), "QuickLook.TeXViewer.log"); }
            catch (Exception) { return null; }
        }

        public static void Trace(string message)
        {
            if (string.IsNullOrEmpty(TracePath)) return;
            try
            {
                var fi = new FileInfo(TracePath);
                if (fi.Exists && fi.Length > 512 * 1024) fi.Delete();
                File.AppendAllText(TracePath,
                    DateTime.Now.ToString("HH:mm:ss.fff") + "  " + message + Environment.NewLine);
            }
            catch (Exception)
            {
                // 日志失败不影响预览
            }
        }

        /// <summary>最小 JSON 字符串转义（避免为了一个字段引入序列化器）。</summary>
        /// <summary>计算 SHA256（十六进制小写），用于缓存键。</summary>
        private static string Sha256Hex(string text)
        {
            using (var sha = System.Security.Cryptography.SHA256.Create())
            {
                byte[] h = sha.ComputeHash(Encoding.UTF8.GetBytes(text ?? string.Empty));
                var sb = new StringBuilder(h.Length * 2);
                foreach (byte b in h) sb.Append(b.ToString("x2"));
                return sb.ToString();
            }
        }

        // HTML 产物键：源码哈希（含同目录包定义）+ 页面资源哈希
        private string ComputeCacheKey(string text)
        {
            return Sha256Hex(text).Substring(0, 12) + "-h" + PageHash().Substring(0, 8);
        }

        private static Dictionary<string, object> ParseJson(string json)
        {
            try { return JsonSer.Deserialize<Dictionary<string, object>>(json); }
            catch (Exception ex) { Trace("ParseJson 失败：" + ex.Message); return null; }
        }

        private void BeginCacheWrite()
        {
            try
            {
                if (!_cacheEnabled) return;     // 开关在 Preview 里读取一次，这里不再重复查配置
                if (string.IsNullOrEmpty(_cacheKey) || _cacheUrl != null)
                    return;   // 已有缓存就不重写

                Directory.CreateDirectory(CacheDir);
                _cacheWriteStream?.Dispose();
                _cacheWritePath = Path.Combine(CacheDir, _cacheKey + ".tmp");
                var file = new FileStream(_cacheWritePath, FileMode.Create,
                    FileAccess.Write, FileShare.None);
                _cacheWriteStream = new System.IO.Compression.GZipStream(
                    file, System.IO.Compression.CompressionLevel.Optimal, false);
                Trace("Cache: 开始写 " + _cacheKey.Substring(0, 12));
            }
            catch (Exception ex)
            {
                Trace("Cache: 开始写失败 " + ex.Message);
            }
        }

        private void AppendCacheChunk(string json, Dictionary<string, object> dict)
        {
            if (_cacheWriteStream == null) return;
            try
            {
                object payloadObj;
                if (dict == null || !dict.TryGetValue("payload", out payloadObj)) return;
                var payload = payloadObj as Dictionary<string, object>;
                object textObj;
                if (payload == null || !payload.TryGetValue("text", out textObj) || textObj == null) return;

                byte[] bytes = Encoding.UTF8.GetBytes(textObj.ToString());
                _cacheWriteStream.Write(bytes, 0, bytes.Length);
            }
            catch (Exception ex)
            {
                Trace("Cache: 写块失败 " + ex.Message);
                EndCacheWrite();
            }
        }

        private void EndCacheWrite()
        {
            try
            {
                if (_cacheWriteStream == null) return;
                _cacheWriteStream.Flush();
                _cacheWriteStream.Dispose();
                _cacheWriteStream = null;

                if (string.IsNullOrEmpty(_cacheWritePath) || !File.Exists(_cacheWritePath))
                    return;

                string final = Path.Combine(CacheDir, _cacheKey + ".html.gz");
                if (File.Exists(final)) File.Delete(final);
                File.Move(_cacheWritePath, final);
                Trace("Cache: 已保存 " + new FileInfo(final).Length + " B");
                PruneCache();
            }
            catch (Exception ex)
            {
                Trace("Cache: 保存失败 " + ex.Message);
            }
        }

        /// <summary>
        /// 三层清理：① 1 小时前的半成品 .tmp（进程被杀/换文档会留下）；
        /// ② 超过 14 天的条目；③ 超过 120 个或 64 MB（按压缩后字节）时从最旧删起。
        /// 每次保存后执行，启动时也执行一次——即使一个月只预览一次，也不会无限增长。
        /// </summary>
        private static void PruneCache()
        {
            try
            {
                var dir = new DirectoryInfo(CacheDir);
                if (!dir.Exists) return;

                DateTime staleTmp = DateTime.UtcNow.AddHours(-1);
                foreach (var tmp in dir.GetFiles("*.tmp"))
                {
                    try { if (tmp.LastWriteTimeUtc < staleTmp) tmp.Delete(); }
                    catch (Exception) { }
                }

                var files = new List<FileInfo>();
                files.AddRange(dir.GetFiles("*.html.gz"));
                files.AddRange(dir.GetFiles("*.html"));      // 兼容旧版本留下的文件
                if (files.Count == 0) return;

                files.Sort((a, b) => a.LastWriteTimeUtc.CompareTo(b.LastWriteTimeUtc));
                long total = 0;
                foreach (var f in files) total += f.Length;

                DateTime expire = DateTime.UtcNow.AddDays(-CacheTtlDays);
                int count = files.Count;
                foreach (var f in files)
                {
                    bool tooOld = f.LastWriteTimeUtc < expire;
                    bool overCount = count > CacheMaxFiles;
                    bool overBytes = total > CacheMaxBytes;
                    if (!tooOld && !overCount && !overBytes) break;
                    try { total -= f.Length; count--; f.Delete(); }
                    catch (Exception) { }
                }
                if (count != files.Count)
                    Trace("Cache: 清理后剩余 " + count + " 个 / " + (total / 1024) + " KB");
            }
            catch (Exception) { }
        }

        /// <summary>换文档时丢弃没写完的缓存，避免残留 .tmp。</summary>
        private void AbortCacheWrite()
        {
            try
            {
                if (_cacheWriteStream != null) { _cacheWriteStream.Dispose(); _cacheWriteStream = null; }
                if (!string.IsNullOrEmpty(_cacheWritePath) && File.Exists(_cacheWritePath))
                    File.Delete(_cacheWritePath);
            }
            catch (Exception) { }
            _cacheWritePath = null;
        }

        /// <summary>多语言：走框架的 TranslationHelper，缺语言时回落英文。</summary>
        internal static string T(string key, string failsafe)
        {
            try { return TranslationHelper.Get(key, TranslationFile, failsafe: failsafe); }
            catch (Exception) { return failsafe; }
        }

        private static TextBlock BuildNotice(string text)
        {
            return new TextBlock
            {
                Text = text,
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(28),
                VerticalAlignment = VerticalAlignment.Center,
            };
        }
    }
}