// TeXPanel.Packages — 只读文档同目录（含一级子目录）的 .sty/.cls 宏定义
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
        /// <summary>
        /// 读同目录下的 .sty/.cls，抽出其中的宏定义（不执行包代码）。
        /// LaTeX 的 \usepackage 只是"引用"，定义都在包文件里；预览器只要拿到定义就能正确展开。
        /// </summary>
        /// <summary>只读文档同目录（含一级子目录）的 .sty/.cls 里的宏定义；不调用任何外部程序。</summary>
        private static string CollectPackageDefinitions(string text, string baseDir)
        {
            if (string.IsNullOrEmpty(text) || string.IsNullOrEmpty(baseDir)) return string.Empty;

            var names = new List<string>();
            foreach (Match m in Regex.Matches(text, @"\\(?:documentclass|usepackage)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}"))
                foreach (string part in m.Groups[1].Value.Split(','))
                {
                    string n = part.Trim();
                    if (n.Length > 0 && !names.Contains(n)) names.Add(n);
                }

            var sb = new StringBuilder();
            foreach (string name in names)
            {
                foreach (string ext in new[] { ".sty", ".cls" })
                {
                    string rel = name.Replace('/', '\\') + ext;
                    string file = Path.Combine(baseDir, rel);
                    if (!File.Exists(file) && rel.IndexOf('\\') < 0)
                    {
                        try
                        {
                            foreach (string sub in Directory.GetDirectories(baseDir))
                            {
                                string cand = Path.Combine(sub, rel);
                                if (File.Exists(cand)) { file = cand; break; }
                            }
                        }
                        catch (Exception) { }
                    }
                    if (!File.Exists(file)) continue;

                    string key = (name + ext).ToLowerInvariant();
                    if (_pkgDefsCache.ContainsKey(key))
                    {
                        if (_pkgDefsCache[key].Length > 0) sb.Append(_pkgDefsCache[key]).Append('\n');
                        break;
                    }
                    try
                    {
                        string defs = ExtractDefinitions(File.ReadAllText(file));
                        _pkgDefsCache[key] = defs;
                        if (defs.Length > 0)
                        {
                            sb.Append(defs).Append('\n');
                            Trace("Pkg: " + key + " → 定义 " + defs.Length + " 字符");
                        }
                    }
                    catch (Exception ex) { _pkgDefsCache[key] = string.Empty; Trace("Pkg: 读取失败 " + key + " " + ex.Message); }
                    break;
                }
            }
            return sb.ToString();
        }

        private static readonly Dictionary<string, string> _pkgDefsCache =
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);




        private static string NormalizeDefinition(string snippet)
        {
            if (string.IsNullOrEmpty(snippet)) return null;
            if (Regex.IsMatch(snippet, @"\\@for|\\csname|\\expandafter|\\futurelet|\\noexpand|\\afterassignment"))
                return null;

            // \newcommand 家族：原样保留（renderer 自己能解析）
            if (Regex.IsMatch(snippet, @"^\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand|DeclareMathOperator)\b"))
                return snippet;

            // \def\name{|,}#1{|,}{body}
            var mDef = Regex.Match(snippet, @"^\\(?:long|global|outer|protected)\s*\\(?:def|gdef|edef|xdef)\s*\\([A-Za-z@][A-Za-z0-9@]*)\s*([^\{#]*)#1\s*([^\{#]*)(\{[\s\S]*)$");
            if (mDef.Success)
            {
                string name = mDef.Groups[1].Value;
                string pre = mDef.Groups[2].Value.Trim();
                string post = mDef.Groups[3].Value.Trim();
                string body = mDef.Groups[4].Value.TrimEnd();
                // 只接受“定界符在前后一致”或“无定界符”两种形态
                bool symmetric = pre.Length == 1 && post.Length == 1 && pre == post;
                bool plain = pre.Length == 0 && post.Length == 0;
                if (symmetric || plain) return "\\newcommand{\\" + name + "}[1]" + body;
                return null;
            }

            // \def\name#1#2…{body}：无定界的多参数
            var mMulti = Regex.Match(snippet, @"^\\(?:long|global|outer|protected)\s*\\(?:def|gdef|edef|xdef)\s*\\([A-Za-z@][A-Za-z0-9@]*)\s*((?:#[1-9])+)\s*(\{[\s\S]*)$");
            if (mMulti.Success)
            {
                string name = mMulti.Groups[1].Value;
                string pars = mMulti.Groups[2].Value;
                string body = mMulti.Groups[3].Value.TrimEnd();
                return "\\newcommand{\\" + name + "}[" + Regex.Matches(pars, "#").Count + "]" + body;
            }

            // \def\name{body}：零参数
            var mZero = Regex.Match(snippet, @"^\\(?:long|global|outer|protected)\s*\\(?:def|gdef|edef|xdef)\s*\\([A-Za-z@][A-Za-z0-9@]*)\s*(\{[\s\S]*)$");
            if (mZero.Success)
            {
                string name = mZero.Groups[1].Value;
                string body = mZero.Groups[2].Value.TrimEnd();
                return "\\newcommand{\\" + name + "}" + body;
            }

            return null;   // \let 等其他形态：不抽
        }
        private static string ExtractDefinitions(string src)
        {
            var sb = new StringBuilder();
            var re = new Regex(@"(?m)^[ \t]*(?:\\(?:long|global|outer|protected)\s*)*\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand|DeclareMathOperator|def|gdef|edef|xdef|let)\b");
            foreach (Match m in re.Matches(src))
            {
                int start = m.Index, depth = 0, end = -1;
                for (int k = start; k < src.Length; k++)
                {
                    char ch = src[k];
                    if (ch == '\\') { k++; continue; }
                    if (ch == '{') depth++;
                    else if (ch == '}')
                    {
                        depth--;
                        if (depth == 0) { end = k + 1; break; }
                    }
                }
                if (end < 0)
                {
                    int nl = src.IndexOf('\n', start);
                    end = nl > 0 ? nl : src.Length;
                }
                string snippet = src.Substring(start, end - start).Trim();
                string normalized = NormalizeDefinition(snippet);
                if (!string.IsNullOrEmpty(normalized)) sb.Append(normalized).Append('\n');
                if (sb.Length > 400 * 1024) break;
            }
            return sb.ToString();
        }


    }
}