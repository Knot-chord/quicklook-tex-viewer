// 本地宿主测试程序：真实 WebView2 + 真实 TeXPanel，用来在 QuickLook 之外复现问题。
// 两种模式：
//   TeXViewerHarness.exe <file.tex>       → 走插件面板（默认）
//   TeXViewerHarness.exe --raw [<url>]    → 只放一个裸 WebView2，用于区分“环境问题 / 插件问题”
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using QuickLook.Plugin.TeXViewer;
using System;
using System.IO;
using System.Windows;

namespace TeXViewerHarness
{
    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            var app = new Application { ShutdownMode = ShutdownMode.OnMainWindowClose };
            app.DispatcherUnhandledException += (s, e) =>
            {
                TeXPanel.Trace("harness 未处理异常：" + e.Exception);
                MessageBox.Show(e.Exception.ToString(), "harness 异常");
                e.Handled = true;
            };

            if (args.Length > 0 && args[0] == "--pdf2png")
            {
                RunPdf2Png(args.Length > 1 ? args[1] : null, args.Length > 2 ? args[2] : null);
                return;
            }

            if (args.Length > 0 && args[0] == "--pdf")
            {
                RunPdfProbe(app, args.Length > 1 ? args[1] : null);
                return;
            }

            if (args.Length > 0 && args[0] == "--raw")
            {
                RunRaw(app, args.Length > 1 ? args[1] : null);
                return;
            }

            if (args.Length == 0 || !File.Exists(args[0]))
            {
                MessageBox.Show("用法：TeXViewerHarness.exe <file.tex> | --raw [url] | --pdf <pdf> | --pdf2png <pdf> <outDir>", "TeXViewer Harness");
                return;
            }

            RunPanel(app, args[0]);
        }

        /// <summary>把 PDF 每页渲染为 PNG（复用插件的 PdfPageRenderer，不另写实现）。</summary>
        private static void RunPdf2Png(string pdf, string outDir)
        {
            try
            {
                if (string.IsNullOrEmpty(outDir)) outDir = Path.Combine(Path.GetTempPath(), "texviewer-pdf2png");
                int pages = PdfPageRenderer.RenderPages(pdf, outDir, 1600, 0);
                Console.WriteLine("pages=" + pages + " out=" + outDir);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("pdf2png 失败: " + ex.Message);
                Environment.ExitCode = 1;
            }
        }

        /// <summary>探测 WebView2 能否直接显示本地 PDF（决定“真编译出 PDF”路线是否可行）。</summary>
        private static void RunPdfProbe(Application app, string pdf)
        {
            TeXPanel.Trace("=== harness(pdf) 探测：" + pdf);
            var web = new WebView2();
            var window = MakeWindow("PDF probe");
            window.Content = web;

            window.Loaded += async (s, e) =>
            {
                try
                {
                    string userData = Path.Combine(Path.GetTempPath(), "texviewer-pdfprobe");
                    var env = await CoreWebView2Environment.CreateAsync(null, userData);
                    await web.EnsureCoreWebView2Async(env);
                    web.CoreWebView2.NavigationCompleted += async (s2, e2) =>
                    {
                        TeXPanel.Trace("pdf nav: success=" + e2.IsSuccess + " source=" + web.CoreWebView2.Source);
                        try
                        {
                            string js = "(function(){return JSON.stringify({ct:document.contentType,title:document.title,children:document.body?document.body.children.length:-1,hasPlugin:!!document.querySelector('embed,object')});})()";
                            string r = await web.CoreWebView2.ExecuteScriptAsync(js);
                            TeXPanel.Trace("pdf probe: " + r);
                        }
                        catch (Exception ex) { TeXPanel.Trace("pdf probe 脚本失败：" + ex.Message); }

                        var t = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromSeconds(2) };
                        t.Tick += (s3, e3) => { t.Stop(); window.Close(); };
                        t.Start();
                    };
                    web.Source = new Uri(new FileInfo(pdf).FullName);
                }
                catch (Exception ex)
                {
                    TeXPanel.Trace("pdf probe 初始化失败：" + ex.Message);
                    window.Close();
                }
            };
            app.Run(window);
        }

        private static void RunPanel(Application app, string tex)
        {
            TeXPanel.Trace("=== harness(panel) 启动：" + tex);

            bool probe = Array.IndexOf(Environment.GetCommandLineArgs(), "--probe") >= 0;

            var panel = TeXPanel.Acquire();                    // 与插件一致：走复用入口
            panel.Show(tex, false, panel.Theme);               // 首次会导航加载页面

            var window = MakeWindow("TeXViewer Host Harness — " + Path.GetFileName(tex));
            window.Content = panel;
            window.Loaded += (s, e) =>
                TeXPanel.Trace("harness: 窗口已显示，panel.Content=" +
                               (panel.Content == null ? "null" : panel.Content.GetType().Name));

            if (probe)
            {
                bool second = false;
                var timer = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromSeconds(6) };
                timer.Tick += async (s, e) =>
                {
                    timer.Stop();
                    try
                    {
                        var core = panel.Core;
                        if (core == null) { TeXPanel.Trace("probe: CoreWebView2 为空"); }
                        else
                        {
                            const string js =
                                "(function(){var imgs=document.querySelectorAll('img.fig');var all=document.querySelectorAll('img');" +
                                "var dp=document.querySelectorAll('[data-path]');var miss=document.querySelectorAll('.img-missing');" +
                                "var first=dp.length?dp[0].getAttribute('data-path'):null;" +
                                "var firstSrc=dp.length?dp[0].getAttribute('src'):null;" +
                                "var keys=(window.__texImages&&Object.keys(window.__texImages).slice(0,3))||null;" +
                                "var d=0;Array.prototype.forEach.call(imgs,function(i){if((i.getAttribute('src')||'').indexOf('data:')===0)d++;});" +
                                "var cs=getComputedStyle(document.body);" +
                                "return JSON.stringify({theme:document.documentElement.dataset.theme," +
                                "bg:cs.backgroundColor,fg:cs.color,imgs:imgs.length,dataImgs:d," +
                                "mjx:document.querySelectorAll('mjx-container').length," +
                                "envNote:document.querySelectorAll('.env-note').length," +
                                "pre:document.querySelectorAll('pre.code').length," +
                                "miss:document.querySelectorAll('.img-missing').length," +
                                "dlgHidden:(document.querySelector('#dlg')||{}).hidden," +
                                "merror:document.querySelectorAll('merror').length," +
                                "failed:document.querySelectorAll('.math-failed').length," +
                                "mathSrc:(document.querySelector('.math-src')||{}).textContent||''," +
                                "notes:document.querySelectorAll('.tex-note').length," +
                                "chipText:(document.querySelector('.tex-chip')||{}).textContent||''," +
                                "unk:(window.__lastUnknown||[]).join('|')," +
                                "formulaReason:(document.querySelector('.formula-reason')||{}).textContent||''," +
                                "failedCode:document.querySelectorAll('.math-failed code').length," +
                                "mathTex:(document.querySelector('.math')||{}).textContent||''," +
                                "srcHidden:(document.querySelector('#view-source')||{}).hidden," +
                                "warn:(document.querySelector('#warn-btn')||{}).textContent||''," +
                                "stats:(document.querySelector('#stats')||{}).textContent});})()";
                            var json = await core.ExecuteScriptAsync(js);
                            TeXPanel.Trace("probe: " + json);
                        }
                    }
                    catch (Exception ex) { TeXPanel.Trace("probe 异常：" + ex.Message); }

                    if (!second)
                    {
                        second = true;
                        // 第二轮：新建面板（模拟用户再预览一次），检验预热与缓存效果
                        var p2 = TeXPanel.Acquire();       // 复用第一个面板（模拟真实连续预览）
                        p2.Show(tex, false, panel.Theme);
                        window.Content = p2;
                        panel = p2;
                        timer.Interval = TimeSpan.FromSeconds(5);
                        timer.Start();
                        return;
                    }

                    app.Shutdown();
                };
                timer.Start();
            }

            app.Run(window);
        }

        // 只放一个裸 WebView2：如果它也初始化不了，说明是本机 WebView2 环境问题，
        // 而非插件代码问题。
        private static void RunRaw(Application app, string url)
        {
            TeXPanel.Trace("=== harness(raw) 启动");

            var wv = new WebView2();
            TeXPanel.Trace("raw: WebView2 控件已创建，CreationProperties=" +
                           (wv.CreationProperties == null ? "null" : "notnull"));

            wv.CoreWebView2InitializationCompleted += (s, e) =>
                TeXPanel.Trace("raw: InitCompleted success=" + e.IsSuccess +
                               (e.InitializationException != null ? " err=" + e.InitializationException : ""));

            wv.NavigationCompleted += (s, e) =>
                TeXPanel.Trace("raw: NavigationCompleted success=" + e.IsSuccess +
                               " status=" + e.WebErrorStatus);

            var window = MakeWindow("WebView2 raw probe");
            window.Content = wv;
            window.Loaded += (s, e) => TeXPanel.Trace("raw: 窗口已显示");

            window.ContentRendered += (s, e) =>
            {
                TeXPanel.Trace("raw: 首帧渲染完成，开始注入内容");
                wv.NavigateToString("<html><body style='font:16px sans-serif'><h1>RAW OK</h1>" +
                                    "<p>如果看到这段文字，说明 WebView2 环境正常。</p></body></html>");
            };

            app.Run(window);
        }

        private static Window MakeWindow(string title)
        {
            return new Window
            {
                Title = title,
                Width = 1120,
                Height = 780,
                WindowStartupLocation = WindowStartupLocation.CenterScreen,
                Background = System.Windows.Media.Brushes.White,
            };
        }
    }
}
