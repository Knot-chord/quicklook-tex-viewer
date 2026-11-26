// PDF 页面渲染：插件（插图内联）与测试工具（PDF 核对）共用同一份实现
using System;
using System.Collections.Generic;
using System.IO;

namespace QuickLook.Plugin.TeXViewer
{
    /// <summary>
    /// 用 Windows 自带的 PDF 渲染（Windows.Data.Pdf，与 Edge 同引擎）把页面转 PNG。
    /// 只有一份实现：插件把 PDF 插图内联到页面，测试工具把编译产物转成 PNG 做对照。
    /// </summary>
    public static class PdfPageRenderer
    {
        /// <summary>渲染指定页，返回 PNG 字节；失败返回 null（不抛异常打断预览）。</summary>
        public static byte[] RenderPageBytes(string pdfPath, int pageIndex, int maxWidth)
        {
#if WINRT_PDF
            try
            {
                var file = Windows.Storage.StorageFile.GetFileFromPathAsync(Path.GetFullPath(pdfPath))
                    .AsTask().GetAwaiter().GetResult();
                var doc = Windows.Data.Pdf.PdfDocument.LoadFromFileAsync(file).AsTask().GetAwaiter().GetResult();
                if (doc.PageCount == 0 || pageIndex < 0 || pageIndex >= doc.PageCount) return null;

                using (var page = doc.GetPage((uint)pageIndex))
                {
                    var opts = new Windows.Data.Pdf.PdfPageRenderOptions();
                    double w = page.Size.Width;
                    opts.DestinationWidth = (uint)Math.Max(200, Math.Min(maxWidth, w * 1.5));
                    using (var stream = new Windows.Storage.Streams.InMemoryRandomAccessStream())
                    {
                        page.RenderToStreamAsync(stream, opts).AsTask().GetAwaiter().GetResult();
                        var bytes = new byte[stream.Size];
                        using (var reader = new Windows.Storage.Streams.DataReader(stream.GetInputStreamAt(0)))
                        {
                            reader.LoadAsync((uint)stream.Size).AsTask().GetAwaiter().GetResult();
                            reader.ReadBytes(bytes);
                        }
                        return bytes;
                    }
                }
            }
            catch (Exception)
            {
                return null;
            }
#else
            return null;
#endif
        }

        /// <summary>渲染全部页（或前 maxPages 页）到 outDir，返回渲染页数。</summary>
        public static int RenderPages(string pdfPath, string outDir, int width = 1600, int maxPages = 0)
        {
#if WINRT_PDF
            if (string.IsNullOrEmpty(pdfPath) || !File.Exists(pdfPath))
                throw new FileNotFoundException("PDF 不存在", pdfPath);
            Directory.CreateDirectory(outDir);

            var file = Windows.Storage.StorageFile.GetFileFromPathAsync(Path.GetFullPath(pdfPath))
                .AsTask().GetAwaiter().GetResult();
            var doc = Windows.Data.Pdf.PdfDocument.LoadFromFileAsync(file).AsTask().GetAwaiter().GetResult();
            int count = (int)doc.PageCount;
            if (maxPages > 0 && maxPages < count) count = maxPages;

            for (int i = 0; i < count; i++)
            {
                byte[] bytes = RenderPageBytes(pdfPath, i, width);
                if (bytes == null) continue;
                File.WriteAllBytes(Path.Combine(outDir, "page-" + (i + 1) + ".png"), bytes);
            }
            return count;
#else
            throw new InvalidOperationException("本构建未启用 WINRT_PDF（缺少 Windows.winmd），无法渲染 PDF 页面");
#endif
        }
    }
}
