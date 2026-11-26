// TeXPanel.Cache — 编译缓存（键、写入、清理）
// 从 TeXPanel 拆出的单一职责部分（partial）；行为不变，字段仍在 TeXPanel.cs 共享。
using Microsoft.Web.WebView2.Core;
using QuickLook.Common.Plugin;
using QuickLook.Plugin.HtmlViewer;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using QuickLook.Common.Helpers;
using System.Threading.Tasks;
namespace QuickLook.Plugin.TeXViewer
{
    public sealed partial class TeXPanel : WebpagePanel
    {
        /* ---------------- 编译缓存实现 ---------------- */

        // 页面（HTML+JS）的哈希：渲染逻辑一变，所有缓存自动失效，
        // 不用再手工改 CacheVersion，也不会出现"插件升级了却回放旧结果"。
        // 页面资源（HTML + 所有 JS/CSS/MathJax）的哈希：任一资源变化，缓存键就变，
        // 不会出现“插件升级了却回放旧结果”。MathJax 有 2 MB，只在会话内算一次。
        private string _pageHash;

        private string PageHash()
        {
            if (_pageHash != null) return _pageHash;
            try
            {
                var asm = typeof(TeXPanel).Assembly;
                var names = new List<string>(asm.GetManifestResourceNames());
                names.Sort(StringComparer.Ordinal);
                using (var sha = SHA256.Create())
                {
                    var buf = new byte[65536];
                    foreach (string n in names)
                    {
                        byte[] nameBytes = Encoding.UTF8.GetBytes(n + "|");
                        sha.TransformBlock(nameBytes, 0, nameBytes.Length, null, 0);
                        using (var s = asm.GetManifestResourceStream(n))
                        {
                            if (s == null) continue;
                            int read;
                            while ((read = s.Read(buf, 0, buf.Length)) > 0)
                                sha.TransformBlock(buf, 0, read, null, 0);
                        }
                    }
                    sha.TransformFinalBlock(new byte[0], 0, 0);
                    byte[] h = sha.Hash;
                    var sb = new StringBuilder(16);
                    for (int k = 0; k < 8; k++) sb.Append(h[k].ToString("x2"));
                    _pageHash = sb.ToString();
                    Trace("PageHash: " + _pageHash + " （" + names.Count + " 个资源）");
                }
            }
            catch (Exception ex)
            {
                Trace("PageHash 失败：" + ex.Message);
                _pageHash = "nohash";
            }
            return _pageHash;
        }


    }
}