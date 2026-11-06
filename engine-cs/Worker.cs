using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace GalleryEngine
{
    // C# 版下载 worker：拉专辑页 -> 解析图 URL -> 下载
    static class Worker
    {
        public static volatile bool Alive = false;
        static int _dlLock = 0;

        public static bool TryLock() { return System.Threading.Interlocked.CompareExchange(ref _dlLock, 1, 0) == 0; }
        public static void Unlock() { System.Threading.Interlocked.Exchange(ref _dlLock, 0); }
        public static bool IsBusy { get { return System.Threading.Volatile.Read(ref _dlLock) != 0; } }
        public static volatile string LogRoot = null;
        static string ROOT, DEST, STASH, PAGES;
        static string UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
        static readonly Regex ImgRe = new Regex(@"https://cdn\.sshs\.rip/[a-z0-9/]+\.webp", RegexOptions.IgnoreCase | RegexOptions.Compiled);

        // 用系统 curl.exe 抓网页（.NET 4.0 的 TLS 太老）
        static string JsonEscapeW(string v)
        {
            if (string.IsNullOrEmpty(v)) return "";
            var sb = new StringBuilder();
            foreach (char c in v)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            return sb.ToString();
        }

        // 用 HttpClient 下载（twimg 需要 TLS1.2 + Referer）
        static string HttpDownload(string url, string outFile)
        {
            try
            {
                ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072 | (SecurityProtocolType)768;
                ServicePointManager.ServerCertificateValidationCallback = delegate { return true; };

                var handler = new HttpClientHandler();
                handler.AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate;
                handler.AllowAutoRedirect = true;
                handler.UseProxy = true;
                handler.Proxy = new WebProxy("http://127.0.0.1:7890", false);

                using (var hc = new HttpClient(handler))
                {
                    hc.Timeout = TimeSpan.FromSeconds(60);
                    hc.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", UA);
                    hc.DefaultRequestHeaders.TryAddWithoutValidation("Referer", "https://x.com/");
                    hc.DefaultRequestHeaders.TryAddWithoutValidation("Accept", "image/avif,image/webp,image/png,image/*,*/*;q=0.8");

                    var bytes = hc.GetByteArrayAsync(url).GetAwaiter().GetResult();
                    if (bytes != null && bytes.Length > 100)
                    {
                        File.WriteAllBytes(outFile, bytes);
                        return null;
                    }
                    return "empty";
                }
            }
            catch (Exception ex)
            {
                return ex.GetType().Name + ": " + ex.Message;
            }
        }

        public static string DownloadFromPageJson(string pageJson, string destRoot, string tweetUrl)
        {
            try
            {
                var m = Regex.Match(tweetUrl ?? "", @"(?:twitter\.com|x\.com)/([^/]+)/status/(\d+)");
                string author = m.Success ? m.Groups[1].Value : "unknown";
                string id = m.Success ? m.Groups[2].Value : DateTime.Now.Ticks.ToString();

                var urls = new List<string>();
                foreach (Match u in Regex.Matches(pageJson, "\"(https://pbs[.]twimg[.]com/media/[^\"]+)\""))
                {
                    string x = u.Groups[1].Value.Replace("\\/", "/");
                    if (!urls.Contains(x)) urls.Add(x);
                }
                foreach (Match u in Regex.Matches(pageJson, "\"(https://video[.]twimg[.]com/[^\"]+)\""))
                {
                    string x = u.Groups[1].Value.Replace("\\/", "/");
                    if (!urls.Contains(x)) urls.Add(x);
                }

                if (urls.Count == 0)
                {
                    bool sens = pageJson.IndexOf("\"sensitive\":true", StringComparison.Ordinal) >= 0;
                    bool logged = pageJson.IndexOf("\"loggedIn\":true", StringComparison.Ordinal) >= 0;
                    string why = sens ? "sensitive needs login" : (logged ? "no media on page" : "not logged in");
                    return "{\"ok\":false,\"msg\":\"" + JsonEscapeW(why) + "\"}";
                }

                string dir = Path.Combine(destRoot, "X", author, id);
                Directory.CreateDirectory(dir);

                int ok = 0;
                foreach (var u in urls)
                {
                    try
                    {
                        string fn = Path.GetFileName(new Uri(u).AbsolutePath);
                        fn = Regex.Replace(fn, "[^a-zA-Z0-9._-]", "_");
                        if (fn.IndexOf('.') < 0) fn += ".jpg";
                        string dst = Path.Combine(dir, fn);
                        if (File.Exists(dst) && new FileInfo(dst).Length > 1000) { ok++; continue; }
                        string err = (u.IndexOf("twimg.com", StringComparison.OrdinalIgnoreCase) >= 0) ? HttpDownload(u, dst) : CurlGet(u, dst);
                        if (err == null && File.Exists(dst) && new FileInfo(dst).Length > 100) ok++;
                        else { }
                    }
                    catch (Exception) { }
                }

                var sb = new StringBuilder();
                sb.Append("{\"ok\":true,\"author\":\"").Append(JsonEscapeW(author)).Append("\"");
                sb.Append(",\"id\":\"").Append(id).Append("\"");
                sb.Append(",\"mediaTotal\":").Append(urls.Count);
                sb.Append(",\"mediaSaved\":").Append(ok);
                sb.Append(",\"dir\":\"").Append(JsonEscapeW(dir)).Append("\"}");
                return sb.ToString();
            }
            catch (Exception ex)
            {
                return "{\"ok\":false,\"msg\":\"" + JsonEscapeW(ex.Message) + "\"}";
            }
        }

        static string CurlGetRaw(string url)
        {
            try
            {
                var psi = new System.Diagnostics.ProcessStartInfo();
                psi.FileName = "curl.exe";
                psi.Arguments = "-s -L -k --compressed --max-time 40 -x http://127.0.0.1:7890 -A \"" + UA + "\" \"" + url + "\"";
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                psi.StandardOutputEncoding = Encoding.UTF8;
                var proc = System.Diagnostics.Process.Start(psi);
                string so = proc.StandardOutput.ReadToEnd();
                proc.WaitForExit(60000);
                return so;
            }
            catch { return null; }
        }

        public static string XDownload(string tweetUrl, string destRoot)
        {
            try
            {
                var m = Regex.Match(tweetUrl ?? "", @"(?:twitter\.com|x\.com)/[^/]+/status/(\d+)");
                if (!m.Success) return "{\"ok\":false,\"msg\":\"no tweet id\"}";
                string id = m.Groups[1].Value;

                string json = CurlGetRaw("https://api.fxtwitter.com/status/" + id);
                if (string.IsNullOrEmpty(json) || json.Length < 20)
                    return "{\"ok\":false,\"msg\":\"API 无响应（检查代理 7890）\"}";
                if (json.IndexOf("NOT_FOUND", StringComparison.Ordinal) >= 0)
                    return "{\"ok\":false,\"msg\":\"推文不存在或账号受限（NSFW/私密/已删）\"}";

                string author = Regex.Match(json, "\"screen_name\":\"([^\"]+)\"").Groups[1].Value;
                string text = Regex.Match(json, "\"text\":\"([^\"]{0,160})").Groups[1].Value;

                var urls = new List<string>();
                // 优先从 media 块里取（覆盖 photo/video/gif）
                try
                {
                    int mstart = json.IndexOf("\"media\"", StringComparison.Ordinal);
                    if (mstart > 0)
                    {
                        // 从 media 开始，取到 "all":[...] 这一段
                        int allIdx = json.IndexOf("\"all\":", mstart, StringComparison.Ordinal);
                        if (allIdx > 0)
                        {
                            int arrStart = json.IndexOf('[', allIdx);
                            int depth2 = 0;
                            int arrEnd = arrStart;
                            for (int i = arrStart; i < json.Length; i++)
                            {
                                if (json[i] == '[') depth2++;
                                else if (json[i] == ']') { depth2--; if (depth2 == 0) { arrEnd = i; break; } }
                            }
                            if (arrEnd > arrStart)
                            {
                                string block = json.Substring(arrStart, arrEnd - arrStart + 1);
                                foreach (Match mu in Regex.Matches(block, "\"url\":\"(https://[^\"]+)\""))
                                {
                                    string u0 = mu.Groups[1].Value.Replace("\\/", "/");
                                    if (!urls.Contains(u0)) urls.Add(u0);
                                }
                            }
                        }
                    }
                }
                catch { }

                foreach (Match v in Regex.Matches(json, "\"url\":\"(https://video[.]twimg[.]com/[^\"]+)\""))
                    urls.Add(v.Groups[1].Value.Replace("\\/", "/"));
                foreach (Match im in Regex.Matches(json, "\"url\":\"(https://pbs[.]twimg[.]com/media/[^\"]+)\""))
                {
                    string u = im.Groups[1].Value.Replace("\\/", "/");
                    if (!urls.Contains(u)) urls.Add(u);
                }

                // 兜底：直接扫 video/pbs 域名
                if (urls.Count == 0)
                {
                    foreach (Match v in Regex.Matches(json, "https://video[.]twimg[.]com/[^\"\\s]+"))
                    {
                        string u0 = v.Value;
                        if (!urls.Contains(u0)) urls.Add(u0);
                    }
                    foreach (Match im in Regex.Matches(json, "https://pbs[.]twimg[.]com/media/[^\"\\s]+"))
                    {
                        string u0 = im.Value;
                        if (!urls.Contains(u0)) urls.Add(u0);
                    }
                }
                if (urls.Count == 0) return "{\"ok\":false,\"msg\":\"no media\"}";

                string dir = Path.Combine(destRoot, "X", string.IsNullOrEmpty(author) ? "unknown" : author, id);
                Directory.CreateDirectory(dir);

                int ok = 0;
                foreach (var u in urls)
                {
                    try
                    {
                        string fn = Path.GetFileName(new Uri(u).AbsolutePath);
                        fn = Regex.Replace(fn, "[^a-zA-Z0-9._-]", "_");
                        if (fn.IndexOf('.') < 0) fn += ".jpg";
                        string dst = Path.Combine(dir, fn);
                        if (File.Exists(dst) && new FileInfo(dst).Length > 1000) { ok++; continue; }
                        string err = (u.IndexOf("twimg.com", StringComparison.OrdinalIgnoreCase) >= 0) ? HttpDownload(u, dst) : CurlGet(u, dst);
                        if (err == null && File.Exists(dst) && new FileInfo(dst).Length > 100) ok++;
                    }
                    catch { }
                }

                var sb = new StringBuilder();
                sb.Append("{\"ok\":true,\"id\":\"").Append(id).Append("\"");
                sb.Append(",\"author\":\"").Append(JsonEscapeW(author)).Append("\"");
                sb.Append(",\"text\":\"").Append(JsonEscapeW(text)).Append("\"");
                sb.Append(",\"mediaTotal\":").Append(urls.Count);
                sb.Append(",\"mediaSaved\":").Append(ok);
                sb.Append(",\"dir\":\"").Append(JsonEscapeW(dir)).Append("\"");
                sb.Append("]");
                sb.Append("]}");
                return sb.ToString();
            }
            catch (Exception ex)
            {
                return "{\"ok\":false,\"msg\":\"" + JsonEscapeW(ex.Message) + "\"}";
            }
        }

        // 用 yt-dlp 下载视频（X / YouTube / B站 全支持）
        public static string YtDlpDownload(string url, string outDir, string exeDir)
        {
            try
            {
                string yt = Path.Combine(exeDir, "yt-dlp.exe");
                if (!File.Exists(yt)) return "yt-dlp missing";

                Directory.CreateDirectory(outDir);
                var psi = new System.Diagnostics.ProcessStartInfo();
                psi.FileName = yt;
                psi.Arguments = "--proxy http://127.0.0.1:7890 --no-warnings --no-progress "
                    + "--no-playlist -o \"" + Path.Combine(outDir, "%(id)s.%(ext)s").Replace("\\", "/") + "\" "
                    + "\"" + url + "\"";
                psi.WorkingDirectory = exeDir;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                psi.StandardOutputEncoding = Encoding.UTF8;
                psi.StandardErrorEncoding = Encoding.UTF8;

                var proc = System.Diagnostics.Process.Start(psi);
                string so = proc.StandardOutput.ReadToEnd();
                string se = proc.StandardError.ReadToEnd();
                proc.WaitForExit(180000);

                string all = so + "\n" + se;
                if (all.IndexOf("No video could be found", StringComparison.OrdinalIgnoreCase) >= 0)
                    return "no-video";
                return (proc.ExitCode == 0) ? null : (se.Length > 0 ? se.Substring(0, Math.Min(150, se.Length)) : "exit " + proc.ExitCode);
            }
            catch (Exception ex)
            {
                return ex.GetType().Name + ": " + ex.Message;
            }
        }

        static string CurlGet(string url, string outFile)
        {
            try
            {
                string referer = (url.IndexOf("twimg.com", StringComparison.OrdinalIgnoreCase) >= 0)
                    ? "https://x.com/" : "https://www.hentaiclub.net/";

                // 直接拼参数（-K 反而踩坑，回滚）
                var args = new StringBuilder();
                args.Append("-s -L -k --compressed --max-time 60 --retry 2 ");
                args.Append("-x http://127.0.0.1:7890 ");
                args.Append("-A \"");
                args.Append(UA.Replace("\"", "\\\""));
                args.Append("\" ");
                args.Append("-e \"");
                args.Append(referer);
                args.Append("\" ");
                if (outFile != null)
                {
                    args.Append("-o \"");
                    args.Append(outFile);
                    args.Append("\" ");
                }
                args.Append("\"");
                args.Append(url);
                args.Append("\"");

                var psi = new System.Diagnostics.ProcessStartInfo();
                psi.FileName = "curl.exe";
                psi.Arguments = args.ToString();
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;

                var proc = System.Diagnostics.Process.Start(psi);
                string stdout = proc.StandardOutput.ReadToEnd();
                string stderr = proc.StandardError.ReadToEnd();
                proc.WaitForExit(120000);

                if (outFile != null)
                {
                    if (File.Exists(outFile) && new FileInfo(outFile).Length > 500) return null;
                    return "fail(code=" + proc.ExitCode + ")" + (string.IsNullOrEmpty(stderr) ? "" : ": " + stderr.Substring(0, Math.Min(120, stderr.Length)));
                }
                return stdout;
            }
            catch (Exception ex)
            {
                return "curl err: " + ex.Message;
            }
        }

        public static HttpClient MakeClient()
        {
            var handler = new HttpClientHandler();
            handler.AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate;
            handler.AllowAutoRedirect = true;
            try
            {
                handler.UseProxy = true;
                handler.Proxy = new WebProxy("http://127.0.0.1:7890", false);
            }
            catch { }
            var mc = new HttpClient(handler);
            mc.Timeout = TimeSpan.FromSeconds(60);
            mc.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", UA);
            mc.DefaultRequestHeaders.TryAddWithoutValidation("Referer", "https://www.hentaiclub.net/");
            mc.DefaultRequestHeaders.TryAddWithoutValidation("Accept-Language", "zh-CN,zh;q=0.9");
            return mc;
        }

        public static void Log(string msg)
        {
            // 写两个地方：data\worker.log（主）和 data\worker_err.log（失败兜底）
            string line = DateTime.Now.ToString("HH:mm:ss") + "  " + msg;
            try
            {
                string rr = LogRoot;
                if (string.IsNullOrEmpty(rr)) rr = ROOT;
                if (string.IsNullOrEmpty(rr)) rr = System.IO.Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
                if (string.IsNullOrEmpty(rr)) rr = ".";
                string baseRoot = rr;
                string dir = Path.Combine(baseRoot, "data");
                try { Directory.CreateDirectory(dir); } catch { }
                string p = Path.Combine(dir, "worker.log");
                using (var fs = new FileStream(p, FileMode.Append, FileAccess.Write, FileShare.ReadWrite))
                using (var sw = new StreamWriter(fs, new UTF8Encoding(false)))
                {
                    sw.WriteLine(line);
                }
            }
            catch (Exception ex)
            {
                try
                {
                    string dir2 = Path.Combine(string.IsNullOrEmpty(ROOT) ? (System.IO.Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location) ?? ".") : ROOT, "data");
                    try { Directory.CreateDirectory(dir2); } catch { }
                    File.AppendAllText(Path.Combine(dir2, "worker_err.log"),
                        DateTime.Now.ToString("HH:mm:ss") + "  LOGFAIL: " + ex.Message + " | " + msg + "\r\n");
                }
                catch { }
                try { Console.Error.WriteLine("LOG FAIL: " + ex.Message); } catch { }
            }
        }

        // 主入口：由 /api/start 调用
        public static void Run(string root, string exedir, int minutes, double quotaGB, string onlyCoser)
        {
            ROOT = root;
            DEST = Path.Combine(root, "cosplay");
            STASH = Path.Combine(root, "data", "_stash");
            PAGES = Path.Combine(root, "data", "_pages");

            try {
                string cfg = Path.Combine(root, "data", "config.json");
                if (File.Exists(cfg))
                {
                    var m = Regex.Match(File.ReadAllText(cfg, Encoding.UTF8), "\"saveDir\"\\s*:\\s*\"([^\"]+)\"");
                    if (m.Success) DEST = m.Groups[1].Value.Replace("\\\\", "\\");
                }
            } catch { }

            Directory.CreateDirectory(DEST);
            Directory.CreateDirectory(STASH);
            Directory.CreateDirectory(PAGES);

            Alive = true;
            Log("worker start: minutes=" + minutes + " quota=" + quotaGB + (string.IsNullOrEmpty(onlyCoser) ? "" : " coser=" + onlyCoser));

            CachedMinutes = minutes;
            DateTime deadline = DateTime.Now.AddMinutes(minutes);
            long quotaBytes = (long)(quotaGB * 1073741824);
            long runBytes = 0;
            int runImages = 0;
            int curDone = 0;

            var groups = LoadGroups(Path.Combine(root, "data", "coser_groups.json"));
            if (groups.Count == 0) { Log("no coser_groups"); WriteStatus(false, "无 coser 数据"); return; }

            int startIdx = 0;
            if (!string.IsNullOrEmpty(onlyCoser))
            {
                startIdx = groups.FindIndex(g =>
                {
                    string a = (g.Coser ?? "").Trim();
                    string b = (onlyCoser ?? "").Trim();
                    if (a.Length == 0 || b.Length == 0) return false;
                    return a == b || a.Contains(b) || b.Contains(a);
                });
                if (startIdx < 0) { Log("coser not found: [" + onlyCoser + "] len=" + (onlyCoser ?? "").Length + " groups=" + groups.Count + " sample=" + (groups.Count > 0 ? groups[0].Coser : "?")); WriteStatus(false, "没找到 " + onlyCoser); return; }
            }

            using (var http = MakeClient())
            {
                for (int gi = startIdx; gi < groups.Count; gi++)
                {
                    if (!Alive) { Log("worker aborted (stopped)"); return; }
                    // 列表模式：本地已有目录的直接跳过（避免每次都从头刷蠢沫沫）
                    if (string.IsNullOrEmpty(onlyCoser))
                    {
                        try
                        {
                            string cdir = Path.Combine(root, "cosplay", groups[gi].Coser);
                            if (Directory.Exists(cdir) && Directory.GetFiles(cdir, "*", SearchOption.AllDirectories).Length > 5)
                                continue;
                        }
                        catch { }
                    }
                    if (DateTime.Now > deadline) { Log("time budget reached"); break; }
                    if (runBytes >= quotaBytes) { Log("quota reached"); break; }

                    var g = groups[gi];
                    Log("coser " + (gi + 1) + "/" + groups.Count + ": " + g.Coser + " albums=" + g.Albums.Count);
                    WriteStatus(true, null, g.Coser, runBytes, runImages, g.EstImages, curDone, gi, groups.Count, g.Albums.Count, gi);

                    foreach (var al in g.Albums)
                    {
                        if (!Alive) { Log("worker aborted (stopped)"); return; }
                        if (DateTime.Now > deadline) break;
                        if (runBytes >= quotaBytes) break;

                        string id = ExtractId(al.Url);
                        if (string.IsNullOrEmpty(id)) continue;

                        try
                        {
                            string pageFile = Path.Combine(PAGES, id + ".html");
                            string html;
                            if (File.Exists(pageFile) && new FileInfo(pageFile).Length > 3000)
                                html = File.ReadAllText(pageFile, Encoding.UTF8);
                            else
                            {
                                string perr = CurlGet(al.Url, pageFile);
                                if (perr != null) throw new Exception("curl: " + perr);
                                html = File.ReadAllText(pageFile, Encoding.UTF8);
                            }

                            var imgs = ImgRe.Matches(html).Cast<Match>().Select(m => m.Value).Distinct().ToList();
                            if (imgs.Count == 0) { Log("  no imgs: " + al.Title); continue; }

                            var sp = SplitTitle(al.Title, g.Coser); string work = sp[0], role = sp[1];
                            string dstDir = Path.Combine(DEST, g.Coser, work, role);
                            Directory.CreateDirectory(dstDir);
                            Log("  album " + al.Title + " imgs=" + imgs.Count + " -> " + dstDir);
                            WriteStatus(true, null, g.Coser, runBytes, runImages, g.EstImages > 0 ? g.EstImages : imgs.Count, curDone, gi, groups.Count, g.Albums.Count - gi, gi);

                            foreach (var u in imgs)
                            {
                                if (DateTime.Now > deadline || runBytes >= quotaBytes) break;
                                if (StopRequested()) { Log("stop requested"); return; }
                                try
                                {
                                    string fn = Path.GetFileName(new Uri(u).AbsolutePath);
                                    fn = Regex.Replace(fn, "[^a-zA-Z0-9._-]", "_");
                                    string dst = Path.Combine(dstDir, fn);
                                    if (File.Exists(dst)) continue;

                                    string derr = null;
                                    for (int attempt = 0; attempt < 3; attempt++)
                                    {
                                        derr = CurlGet(u, dst);
                                        if (derr == null && File.Exists(dst) && new FileInfo(dst).Length > 500) break;
                                        System.Threading.Thread.Sleep(1200 * (attempt + 1));
                                    }
                                    if (derr != null) throw new Exception("curl: " + derr);
                                    long dl = new FileInfo(dst).Length;
                                    runBytes += dl;
                                    curDone++;
                                    runImages++;
                                    WriteStatus(true, null, g.Coser, runBytes, runImages, g.EstImages > 0 ? g.EstImages : imgs.Count, curDone, gi, groups.Count, g.Albums.Count - gi, gi);
                                }
                                catch (Exception ex) { Log("    dl fail: " + ex.Message); }
                            }
                        }
                        catch (Exception ex) { Log("  album fail: " + al.Title + " - " + ex.GetType().Name + ": " + ex.Message + (ex.InnerException != null ? " | inner: " + ex.InnerException.Message : "")); }
                    }
                }
            }

            Alive = false;
            Log("worker done: images=" + runImages + " bytes=" + runBytes);
            WriteStatus(false, null, null, runBytes, runImages, 0, 0, -1, 0, 0, 0);
        }

        static bool StopRequested()
        {
            try
            {
                string p = Path.Combine(ROOT, "data", "gui_status.json");
                if (!File.Exists(p)) return false;
                string t = File.ReadAllText(p, Encoding.UTF8);
                var m = Regex.Match(t, "\"running\"\\s*:\\s*(true|false)");
                return m.Success && m.Groups[1].Value == "false";
            }
            catch { return false; }
        }

        // 本地列表没有时，去站点搜索页抓专辑
        public static List<string[]> SearchCoser(string name)
        {
            var list = new List<string[]>();
            if (string.IsNullOrEmpty(ROOT) && !string.IsNullOrEmpty(LogRoot)) ROOT = LogRoot;
            Log("search start: " + name);
            try
            {
                string q = Uri.EscapeDataString(name);
                string url = "https://www.hentaiclub.net/search/" + q + "/";
                string html = null;
                string tmp = Path.Combine(Path.GetTempPath(), "ggsearch_" + Guid.NewGuid().ToString("N") + ".html");
                string err = CurlGet(url, tmp);
                if (err == null && File.Exists(tmp)) html = File.ReadAllText(tmp, Encoding.UTF8);
                try { if (File.Exists(tmp)) File.Delete(tmp); } catch { }
                if (string.IsNullOrEmpty(html)) { Log("search fail: " + (err ?? "empty")); return list; }

                // 专辑链接：/xxx/123456.html
                var seen = new HashSet<string>();
                foreach (Match m in Regex.Matches(html, "href=\"(https?://www[.]hentaiclub[.]net/[^\"]+?/(\\d+)[.]html)\""))
                {
                    string u = m.Groups[1].Value;
                    string id = m.Groups[2].Value;
                    if (!seen.Add(id)) continue;

                    // 找这个链接附近的标题（<h2> 或 title= ）
                    string title = name;
                    int pos = m.Index;
                    int windowEnd = Math.Min(html.Length, pos + 800);
                    string seg = html.Substring(pos, windowEnd - pos);
                    var tm = Regex.Match(seg, "title=\"([^\"]{2,80})\"");
                    if (!tm.Success) tm = Regex.Match(seg, "alt=\"([^\"]{2,80})\"");
                    if (tm.Success)
                    {
                        title = tm.Groups[1].Value;
                    }
                    else
                    {
                        var hm = Regex.Match(seg, ">([^<]{2,60})<");
                        if (hm.Success) title = hm.Groups[1].Value.Trim();
                    }
                    // 过滤站点的导航/分类伪链接
                    if (title.IndexOf("随机", StringComparison.Ordinal) >= 0
                        || title.IndexOf("R18内容", StringComparison.Ordinal) >= 0
                        || title.IndexOf("首页", StringComparison.Ordinal) >= 0
                        || title.IndexOf("更多", StringComparison.Ordinal) >= 0
                        || title.IndexOf("登录", StringComparison.Ordinal) >= 0)
                        continue;
                    if (string.IsNullOrEmpty(title)) continue;
                    list.Add(new string[] { title, u, id });
                }
                Log("search [" + name + "] -> " + list.Count + " albums");
            }
            catch (Exception ex) { Log("search err: " + ex.Message); }
            return list;
        }

        // 直接下载搜索到的专辑（不走 groups）
        public static void DownloadSearchResults(string coserName, List<string[]> albums, string destRoot)
        {
            if (!TryLock()) { Log("search dl rejected: another task running"); return; }
            try
            {
                int n = 0;
                long totalBytes = 0;
                // 立刻刷新状态：把 coser 换成当前这位
                try { WriteStatus(true, null, coserName, 0, 0, albums.Count * 50, 0, 0, 1, albums.Count, 0); } catch { }
                foreach (var al in albums)
                {
                    if (!Alive) { Log("search dl aborted (stopped)"); return; }
                    string title = al[0], url = al[1], id = al[2];
                    try
                    {
                        string tmp = Path.Combine(Path.GetTempPath(), "ggpage_" + id + ".html");
                        string err = CurlGet(url, tmp);
                        if (err != null || !File.Exists(tmp)) { Log("  page fail: " + title); continue; }
                        string html = File.ReadAllText(tmp, Encoding.UTF8);
                        try { File.Delete(tmp); } catch { }

                        var imgs = new List<string>();
                        var seen2 = new HashSet<string>();
                        foreach (Match m in Regex.Matches(html, "https://cdn[.]sshs[.]rip/[a-zA-Z0-9/_\\-.]+[.](webp|jpg|png)"))
                        {
                            if (seen2.Add(m.Value)) imgs.Add(m.Value);
                        }
                        if (imgs.Count == 0) { Log("  no imgs: " + title); continue; }

                        string[] sp = SplitTitle(title, coserName);
                        string dstDir = Path.Combine(destRoot, coserName, sp[0], sp[1]);
                        // 已有完整专辑 -> 直接跳过（不重复刷日志）
                        try
                        {
                            if (Directory.Exists(dstDir))
                            {
                                int have = Directory.GetFiles(dstDir).Length;
                                if (have >= imgs.Count && have > 0)
                                {
                                    n += have;
                                    Log("  skip " + title + " (already " + have + ")");
                                    continue;
                                }
                            }
                        }
                        catch { }
                        Directory.CreateDirectory(dstDir);

                        int got = 0;
                        int inAlbum = 0;
                        long albumBytes = 0;
                        foreach (var u in imgs)
                        {
                            if (!Alive) { Log("  album aborted"); return; }
                            try
                            {
                                string fn = Path.GetFileName(new Uri(u).AbsolutePath);
                                fn = Regex.Replace(fn, "[^a-zA-Z0-9._-]", "_");
                                string dst = Path.Combine(dstDir, fn);
                                inAlbum++;
                                if (File.Exists(dst) && new FileInfo(dst).Length > 500)
                                {
                                    got++;
                                }
                                else
                                {
                                    string derr = CurlGet(u, dst);
                                    if (derr == null && File.Exists(dst) && new FileInfo(dst).Length > 500)
                                    {
                                        got++;
                                        try { long _sz = new FileInfo(dst).Length; albumBytes += _sz; totalBytes += _sz; } catch { }
                                    }
                                }
                                // 实时刷新状态：每张都写
                                try
                                {
                                    WriteStatus(true, null, coserName, totalBytes, n + got,
                                        (albums.Count * 50), n + got, 0, 1, albums.Count, 0);
                                }
                                catch { }
                            }
                            catch { }
                        }
                        n += got;
                        Log("  album " + title + " imgs=" + imgs.Count + " got=" + got);
                        WriteStatus(true, null, coserName, 0, n, (albums.Count * 50), n, 0, 1, albums.Count, 0);
                    }
                    catch (Exception ex) { Log("  album err: " + ex.Message); }
                }
                Log("search download done: " + n + " images");
            }
            catch (Exception ex) { Log("download search err: " + ex.Message); }
            finally { Alive = false; Unlock(); }
        }

        public static bool HasCoser(string root, string coser)
        {
            try
            {
                if (string.IsNullOrEmpty(coser)) return true;
                var groups = LoadGroupsPublic(Path.Combine(root, "data", "coser_groups.json"));
                foreach (var g in groups)
                {
                    string a = (g.Coser ?? "").Trim();
                    string b = (coser ?? "").Trim();
                    if (a.Length > 0 && b.Length > 0 && (a == b || a.Contains(b) || b.Contains(a))) return true;
                }
            }
            catch { }
            return false;
        }

        static string ExtractId(string url)
        {
            var m = Regex.Match(url ?? "", @"/(\d+)\.html");
            return m.Success ? m.Groups[1].Value : null;
        }

        static readonly string[] WORKS = new string[] {
            "碧蓝档案","蔚蓝档案","碧蓝航线","NIKKE胜利女神妮姬","NIKKE胜利女神","Nikke胜利女神","胜利女神妮姬",
            "鸣潮","明日方舟","原神","崩坏学园2","崩坏3rd","崩坏三","崩坏","FateGrandorder","FateGrand Order","FateGrandOrder",
            "Fate","从零开始的异世界生活","孤独摇滚","守望先锋","永劫无间","交错战线","洛天依","巧克力与香子兰",
            "东方Project","葬送的芙莉莲","少女前线","Overlord","KAGUYANO","NIKKE","绝区零","崩坏星穹铁道","星穹铁道","王者荣耀","英雄联盟","碧蓝幻想"
        };

        static string CleanName(string s)
        {
            if (s == null) return "";
            string t = Regex.Replace(s, "[\\\\/:*?\"<>|]", "_");
            t = Regex.Replace(t, "\\s+", " ");
            t = t.Trim();
            return t.Length > 50 ? t.Substring(0, 50) : t;
        }

        static string[] SplitTitle(string title, string coser)
        {
            string t = (title ?? "").Replace("&amp;", "&").Trim();
            if (!string.IsNullOrEmpty(coser) && t.StartsWith(coser)) t = t.Substring(coser.Length).Trim();

            string work = "其他";
            foreach (var w in WORKS)
            {
                if (t.Contains(w))
                {
                    work = w;
                    t = Regex.Replace(t.Replace(w, " "), "\\s+", " ").Trim();
                    break;
                }
            }

            string role = Regex.Replace(t, "^[\\s\\-_·:：]+", "");
            role = Regex.Replace(role, "[\\s\\-_·:：]+$", "").Trim();
            if (string.IsNullOrEmpty(role)) role = "未分类";

            return new string[] { CleanName(work), CleanName(role) };
        }

        public class Album { public string Title; public string Url; }
        public class Group { public string Coser; public int EstImages = 0; public List<Album> Albums = new List<Album>(); }

        public static List<Group> LoadGroupsPublic(string path) { return LoadGroups(path); }

        static List<Group> LoadGroups(string path)
        {
            var list = new List<Group>();
            try
            {
                if (!File.Exists(path)) return list;
                string txt = File.ReadAllText(path, Encoding.UTF8);
                // 极简解析：[{coser, albums:[{title,url}...]}...]
                var gm = Regex.Matches(txt, "\"coser\"\\s*:\\s*\"([^\"]+)\"\\s*,\\s*\"count\"");
                // 用整体正则抓 coser + albums 区块更稳：直接遍历 "coser" 出现位置
                int idx = 0;
                while (true)
                {
                    var cm = Regex.Match(txt.Substring(idx), "\"coser\"\\s*:\\s*\"([^\"]+)\"");
                    if (!cm.Success) break;
                    var g = new Group { Coser = cm.Groups[1].Value };
                    // 取这个 coser 的 estImages
                    int eiIdx = txt.IndexOf("\"estImages\"", idx + cm.Index);
                    if (eiIdx > 0 && eiIdx < idx + cm.Index + 600)
                    {
                        var em = Regex.Match(txt.Substring(eiIdx), "\"estImages\"\\s*:\\s*(\\d+)");
                        if (em.Success) int.TryParse(em.Groups[1].Value, out g.EstImages);
                    }
                    int absPos = idx + cm.Index;
                    var am = Regex.Match(txt.Substring(absPos), "\"albums\"\\s*:\\s*\\[");
                    if (am.Success)
                    {
                        int albStart = absPos + am.Index + am.Length;
                        int depth = 1, p = albStart;
                        while (p < txt.Length && depth > 0)
                        {
                            if (txt[p] == '[') depth++;
                            else if (txt[p] == ']') depth--;
                            p++;
                        }
                        string albJson = txt.Substring(albStart, Math.Max(0, p - albStart - 1));
                        foreach (Match it in Regex.Matches(albJson,
                            "\"title\"\\s*:\\s*\"([^\"]+)\"\\s*,\\s*\"url\"\\s*:\\s*\"([^\"]+)\"|\"url\"\\s*:\\s*\"([^\"]+)\"\\s*,\\s*\"title\"\\s*:\\s*\"([^\"]+)\""))
                        {
                            var a = new Album();
                            if (it.Groups[1].Success) { a.Title = it.Groups[1].Value; a.Url = it.Groups[2].Value; }
                            else { a.Url = it.Groups[3].Value; a.Title = it.Groups[4].Value; }
                            g.Albums.Add(a);
                        }
                        idx = p;
                    }
                    else idx = absPos + cm.Length;
                    list.Add(g);
                }
            }
            catch (Exception ex) { Log("LoadGroups fail: " + ex.Message); }
            return list;
        }

        static int CachedMinutes = 0;
        static void WriteStatus(bool running, string error, string coser = null, long runBytes = 0, int runImages = 0, int curTotal = 0, int curDone = 0, int coserIdx = -1, int totalCoser = 0, int albumsLeft = 0, int doneCount = 0)
        {
            // 已经被停掉的旧任务，不允许覆盖新任务的状态
            if (running && !Alive) return;
            try
            {
                string p = Path.Combine(ROOT, "data", "gui_status.json");
                var sb = new StringBuilder();
                sb.Append("{\"running\":").Append(running ? "true" : "false");
                if (!string.IsNullOrEmpty(error)) sb.Append(",\"error\":\"").Append(error.Replace("\"", "\\\"")).Append("\"");
                if (coser != null) sb.Append(",\"coser\":\"").Append(coser.Replace("\"", "\\\"")).Append("\"");
                sb.Append(",\"pid\":").Append(System.Diagnostics.Process.GetCurrentProcess().Id);
                if (coserIdx >= 0) sb.Append(",\"coserIdx\":").Append(coserIdx);
                if (totalCoser > 0) sb.Append(",\"totalCoser\":").Append(totalCoser);
                if (albumsLeft > 0) sb.Append(",\"albumsLeft\":").Append(albumsLeft);
                if (doneCount > 0) sb.Append(",\"doneCount\":").Append(doneCount);
                sb.Append(",\"runBytes\":").Append(runBytes);
                sb.Append(",\"runImages\":").Append(runImages);
                sb.Append(",\"curTotal\":").Append(curTotal);
                sb.Append(",\"curDone\":").Append(curDone);
                sb.Append(",\"minutes\":").Append(CachedMinutes);
                sb.Append(",\"startedAt\":\"").Append(DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")).Append("\"");
                sb.Append("}");
                File.WriteAllText(p, sb.ToString());
            }
            catch { }
        }
    }
}
