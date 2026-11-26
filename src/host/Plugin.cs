// QuickLook.Plugin.TeXViewer — LaTeX 文档预览插件
// ---------------------------------------------------------------------------
// 遵循随包插件的约定：
//   IViewer（插件契约）+ WebpagePanel（WebView2 面板）
//   + Translations.config（多语言）+ SettingHelper / TranslationHelper（框架帮助类）
// ---------------------------------------------------------------------------

using QuickLook.Common.Plugin;
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Windows;
using System.Windows.Threading;

namespace QuickLook.Plugin.TeXViewer
{
    public sealed partial class Plugin : IViewer
    {
        /// <summary>渲染为文档的扩展名。</summary>
        public static readonly string[] RenderedExtensions =
        {
            ".tex", ".latex", ".ltx", ".xtex",
        };

        /// <summary>以纯文本预览的扩展名（宏包/类/文献库）。</summary>
        public static readonly string[] SourceExtensions =
        {
            ".sty", ".cls", ".bib",
        };

        private TeXPanel _panel;

        // 与 .tex 无冲突，取 0；比 TextViewer(-5) 高，比 PluginInstaller(int.MaxValue) 低
        public int Priority => 0;


        public void Init()
        {
            // 复用框架的 WebpagePanel：它在安装目录的插件子目录里，不在宿主基准目录，
            // 用户插件 LoadFrom 时默认探测找不到，注册一次解析即可（不必复制官方 DLL）。
            AppDomain.CurrentDomain.AssemblyResolve += OnAssemblyResolve;
        }

        private static Assembly OnAssemblyResolve(object sender, ResolveEventArgs args)
        {
            try
            {
                string simpleName = new AssemblyName(args.Name).Name;
                if (!string.Equals(simpleName, "QuickLook.Plugin.HtmlViewer", StringComparison.OrdinalIgnoreCase))
                    return null;

                string host = null;
                try { host = Path.GetDirectoryName(Assembly.GetEntryAssembly()?.Location); }
                catch (Exception) { }
                if (string.IsNullOrEmpty(host))
                    host = AppDomain.CurrentDomain.BaseDirectory;

                string[] candidates =
                {
                    Path.Combine(host, @"QuickLook.Plugin\QuickLook.Plugin.HtmlViewer\QuickLook.Plugin.HtmlViewer.dll"),
                    Path.Combine(host, @"QuickLook.Plugin.HtmlViewer.dll"),
                    Path.Combine(host, @"QuickLook.Plugin\QuickLook.Plugin.HtmlViewer.dll"),
                };

                foreach (string path in candidates)
                {
                    if (!File.Exists(path)) continue;
                    TeXPanel.Trace("AssemblyResolve: " + path);
                    return Assembly.LoadFrom(path);
                }
            }
            catch (Exception ex)
            {
                TeXPanel.Trace("AssemblyResolve 失败：" + ex.Message);
            }
            return null;
        }

        public bool CanHandle(string path)
        {
            if (string.IsNullOrEmpty(path) || Directory.Exists(path))
                return false;

            string ext = Path.GetExtension(path);
            if (string.IsNullOrEmpty(ext))
                return false;

            return Matches(ext, RenderedExtensions) || Matches(ext, SourceExtensions);
        }

        public void Prepare(string path, ContextObject context)
        {
            // 与 HtmlViewer / ChmViewer 一致的 Web 内容尺寸
            context.PreferredSize = new Size(1280, 720);

        }

        public void View(string path, ContextObject context)
        {

            // 首屏可见后再收起忙碌指示；页面排版超过 3 秒时会自己显示进度条。
            // 兜底 6 秒：即使页面消息没回来（加载失败等），也不让转圈一直转。
            bool ready = false;
            Action markReady = () =>
            {
                if (ready) return;
                ready = true;
                try { context.IsBusy = false; } catch (Exception) { }
            };

            var guard = new DispatcherTimer { Interval = TimeSpan.FromSeconds(6) };
            guard.Tick += (s, e) => { guard.Stop(); markReady(); };
            guard.Start();

            // 复用上一个 WebView2（跳过冷启动与 MathJax 重新加载）
            var panel = TeXPanel.Acquire();
            panel.PaintedCallback = markReady;
            panel.Show(path, IsSourceOnly(path), context.Theme);

            context.Title = Path.GetFileName(path);

            try
            {
                context.ViewerContent = panel;
            }
            catch (Exception ex)
            {
                // 面板还挂在旧窗口上：丢弃缓存，重建一个
                TeXPanel.Trace("ViewerContent 挂载失败，重建面板：" + ex.Message);
                TeXPanel.Discard();
                panel = TeXPanel.Acquire();
                panel.PaintedCallback = markReady;
                panel.Show(path, IsSourceOnly(path), context.Theme);
                context.ViewerContent = panel;
            }

            _panel = panel;
        }

        public void Cleanup()
        {
            // 故意不 Dispose：保留 WebView2 给下一次预览复用（主要的速度优化）。
            // 进程退出时由系统回收；用户可在 QuickLook.Plugin.TeXViewer.config 里
            // 用 <ReuseWebView>False</ReuseWebView> 关掉复用。
            if (_panel != null) _panel.PaintedCallback = null;
            _panel = null;
        }

        private static bool IsSourceOnly(string path)
        {
            return Matches(Path.GetExtension(path), SourceExtensions);
        }

        private static bool Matches(string ext, string[] set)
        {
            for (int i = 0; i < set.Length; i++)
            {
                if (string.Equals(ext, set[i], StringComparison.OrdinalIgnoreCase))
                    return true;
            }
            return false;
        }
    }
}
