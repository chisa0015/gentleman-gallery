using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace GalleryEngine
{
    class Program
    {
        static string EXEDIR;
        static string ROOT;

        static string DataDir { get { return Path.Combine(ROOT, "data"); } }
        static string BgDir { get { return Path.Combine(EXEDIR, "bg"); } }
        static string CosplayDir
        {
            get
            {
                try
                {
                    string cfg = Path.Combine(DataDir, "config.json");
                    if (File.Exists(cfg))
                    {
                        string txt = File.ReadAllText(cfg, Encoding.UTF8);
                        var m = System.Text.RegularExpressions.Regex.Match(txt, "\"saveDir\"\\s*:\\s*\"([^\"]+)\"");
                if (m.Success) return m.Groups[1].Value.Replace("\\\\", "\\");
                    }
                }
                catch { }
                return Path.Combine(ROOT, "cosplay");
            }
        }

        static void Main(string[] args)
        {
            EXEDIR = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
            ROOT = Path.GetFileName(EXEDIR).Equals("app", StringComparison.OrdinalIgnoreCase)
                ? Path.GetDirectoryName(EXEDIR) : EXEDIR;

            // 进程退出时自动停止下载
            AppDomain.CurrentDomain.ProcessExit += delegate
            {
                try { Worker.Alive = false; Worker.Log("engine exit -> stop worker"); } catch { }
            };
            AppDomain.CurrentDomain.UnhandledException += delegate
            {
                try { Worker.Alive = false; } catch { }
            };
            // Ctrl+C / 关闭信号
            Console.CancelKeyPress += delegate
            {
                try { Worker.Alive = false; Worker.Log("ctrl+c -> stop worker"); } catch { }
            };

            var listener = new TcpListener(IPAddress.Loopback, 7799);
            listener.Start();
            Console.WriteLine("[csharp-engine] listening on 127.0.0.1:7799");
            Console.WriteLine("[csharp-engine] EXEDIR=" + EXEDIR);
            Console.Out.Flush();

            while (true)
            {
                try
                {
                    var client = listener.AcceptTcpClient();
                    ThreadPool.QueueUserWorkItem(_ => HandleClient(client));
                }
                catch (Exception ex) { Console.WriteLine("accept err: " + ex.Message); }
            }
        }

        static void HandleClient(TcpClient client)
        {
            try
            {
                try { client.ReceiveTimeout = 20000; client.SendTimeout = 20000; } catch { }
                using (client)
                using (var ns = client.GetStream())
                {
                    var reader = new StreamReader(ns, Encoding.GetEncoding(28591), false, 16384, true);
                    string requestLine = reader.ReadLine();
                    if (string.IsNullOrEmpty(requestLine)) return;

                    var parts = requestLine.Split(' ');
                    if (parts.Length < 3) return;
                    string method = parts[0];
                    string pathFull = parts[1];

                    int contentLength = 0;
                    string rangeHeader = null;
                    string line;
                    while (!string.IsNullOrEmpty(line = reader.ReadLine()))
                    {
                        if (line.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase))
                            int.TryParse(line.Substring(15).Trim(), out contentLength);
                        else if (line.StartsWith("Range:", StringComparison.OrdinalIgnoreCase))
                            rangeHeader = line.Substring(6).Trim();
                    }

                    byte[] body = null;
                    if (contentLength > 0)
                    {
                        // body 这里都是 ASCII（JSON / base64），用字符读安全
                        var chars = new char[contentLength];
                        int read = 0;
                        while (read < contentLength)
                        {
                            int n = reader.Read(chars, read, contentLength - read);
                            if (n <= 0) break;
                            read += n;
                        }
                        body = Encoding.GetEncoding(28591).GetBytes(new string(chars, 0, read));
                    }

                    var qs = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                    string path = pathFull;
                    int qi = pathFull.IndexOf('?');
                    if (qi >= 0)
                    {
                        path = pathFull.Substring(0, qi);
                        foreach (var kv in pathFull.Substring(qi + 1).Split('&'))
                        {
                            int eq = kv.IndexOf('=');
                            if (eq > 0) qs[Uri.UnescapeDataString(kv.Substring(0, eq))] = Uri.UnescapeDataString(kv.Substring(eq + 1));
                        }
                    }

                    Route(ns, method, path, qs, rangeHeader, body);
                }
            }
            catch (Exception ex) { Console.WriteLine("handle err: " + ex.Message); }
        }

        static void WriteResponse(NetworkStream ns, int status, string statusText, string contentType, byte[] body, Dictionary<string, string> extraHeaders = null)
        {
            var sb = new StringBuilder();
            sb.Append("HTTP/1.1 ").Append(status).Append(' ').Append(statusText).Append("\r\n");
            sb.Append("Content-Type: ").Append(contentType).Append("\r\n");
            sb.Append("Content-Length: ").Append(body.Length).Append("\r\n");
            sb.Append("Connection: close\r\n");
            sb.Append("Cache-Control: no-store\r\n");
            if (extraHeaders != null)
                foreach (var kv in extraHeaders) sb.Append(kv.Key).Append(": ").Append(kv.Value).Append("\r\n");
            sb.Append("\r\n");
            var head = Encoding.ASCII.GetBytes(sb.ToString());
            ns.Write(head, 0, head.Length);
            if (body.Length > 0) ns.Write(body, 0, body.Length);
            ns.Flush();
        }

        static void WriteText(NetworkStream ns, int status, string text, string ct = "text/plain; charset=utf-8")
        {
            WriteResponse(ns, status, status == 200 ? "OK" : "ERR", ct, Encoding.UTF8.GetBytes(text));
        }

        static string MimeOf(string p)
        {
            string e = Path.GetExtension(p).ToLowerInvariant();
            switch (e)
            {
                case ".html": case ".htm": return "text/html; charset=utf-8";
                case ".css": return "text/css; charset=utf-8";
                case ".js": return "application/javascript; charset=utf-8";
                case ".json": return "application/json; charset=utf-8";
                case ".png": return "image/png";
                case ".jpg": case ".jpeg": return "image/jpeg";
                case ".webp": return "image/webp";
                case ".gif": return "image/gif";
                case ".mp4": return "video/mp4";
                case ".webm": return "video/webm";
                case ".ico": return "image/x-icon";
                case ".svg": return "image/svg+xml";
                default: return "application/octet-stream";
            }
        }

        static string JsonEscape(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            var sb = new StringBuilder();
            foreach (char c in s)
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

        static void Route(NetworkStream ns, string method, string path, Dictionary<string, string> qs, string rangeHeader, byte[] body)
        {
            switch (path)
            {
                case "/":
                    WriteResponse(ns, 200, "OK", "text/html; charset=utf-8", Encoding.UTF8.GetBytes(Pages.Html));
                    return;
                case "/icon.png":
                    {
                        string p = Path.Combine(EXEDIR, "icon.png");
                        if (File.Exists(p)) WriteResponse(ns, 200, "OK", "image/png", File.ReadAllBytes(p));
                        else WriteText(ns, 404, "no icon");
                        return;
                    }
                case "/wallpaper":
                    ServeWallpaper(ns, qs, rangeHeader);
                    return;
                case "/img":
                    ServeImg(ns, qs);
                    return;
                case "/api/status":
                    ServeStatus(ns);
                    return;
                case "/api/photos":
                    ServePhotos(ns, qs);
                    return;
                case "/api/tree":
                    ServeTree(ns);
                    return;
                case "/api/running":
                    ServeRunning(ns);
                    return;
                case "/api/start":
                    ServeStart(ns, qs, body);
                    return;
                case "/api/stop":
                    ServeStop(ns);
                    return;
                case "/api/config":
                    if (method == "POST") ServeConfigSave(ns, body);
                    else ServeConfigGet(ns);
                    return;
                case "/api/fish":
                    ServeFish(ns, body);
                    return;
                case "/file":
                    ServeLocalFile(ns, qs, rangeHeader);
                    return;
                case "/api/reveal":
                    ServeReveal(ns, qs);
                    return;
                case "/api/search":
                    ServeSearch(ns, qs);
                    return;
                case "/api/dl":
                    ServeDl(ns, body);
                    return;
                case "/api/x-set-cookie":
                    ServeXSetCookie(ns, body);
                    return;
                case "/api/x-get-cookie":
                    ServeXGetCookie(ns);
                    return;
                case "/api/x-login":
                    XBrowser.OpenLogin();
                    WriteText(ns, 200, "{\"ok\":true}", "application/json; charset=utf-8");
                    return;
                case "/api/x-login-check":
                    WriteText(ns, 200, XBrowser.CheckLogin(), "application/json; charset=utf-8");
                    return;
                case "/api/x-browser":
                    ServeXBrowser(ns, body);
                    return;
                case "/api/x-download":
                    ServeXDownload(ns, body);
                    return;
                case "/api/fish-status":
                    ServeFishStatus(ns);
                    return;
                default:
                    WriteText(ns, 404, "not found");
                    return;
            }
        }

        static void ServeWallpaper(NetworkStream ns, Dictionary<string, string> qs, string rangeHeader)
        {
            string theme = qs.ContainsKey("theme") ? qs["theme"] : "elaina";
            string type = qs.ContainsKey("type") ? qs["type"] : "";
            theme = new string(theme.Where(c => char.IsLetterOrDigit(c) || c == '_' || c == '-').ToArray());
            if (string.IsNullOrEmpty(theme)) theme = "elaina";

            string[] exts;
            if (type == "video") exts = new[] { ".mp4" };
            else if (type == "intro") exts = new[] { "-intro.png" };
            else if (type == "intro-open") exts = new[] { "-intro-open.png" };
            else if (type == "intro-video") exts = new[] { "-intro.mp4" };
            else if (type == "line") exts = new[] { "-line.png" };
            else exts = new[] { ".jpg", ".jpeg", ".png", ".webp" };

            foreach (var e in exts)
            {
                string p = Path.Combine(BgDir, theme + e);
                if (File.Exists(p)) { ServeFile(ns, p, rangeHeader); return; }
            }
            foreach (var e in new[] { ".jpg", ".png", ".webp" })
            {
                string p = Path.Combine(BgDir, "default" + e);
                if (File.Exists(p)) { ServeFile(ns, p, rangeHeader); return; }
            }
            WriteText(ns, 404, "no wallpaper");
        }

        static void ServeFile(NetworkStream ns, string p, string range)
        {
            var fi = new FileInfo(p);
            long start = 0, end = fi.Length - 1;
            int status = 200;
            string statusText = "OK";
            var extra = new Dictionary<string, string>();

            if (!string.IsNullOrEmpty(range) && range.StartsWith("bytes="))
            {
                var r = range.Substring(6).Split('-');
                if (r.Length == 2)
                {
                    long.TryParse(r[0], out start);
                    if (!string.IsNullOrEmpty(r[1])) long.TryParse(r[1], out end);
                    else end = fi.Length - 1;
                    if (end >= fi.Length) end = fi.Length - 1;
                    status = 206; statusText = "Partial Content";
                    extra["Content-Range"] = string.Format("bytes {0}-{1}/{2}", start, end, fi.Length);
                    extra["Accept-Ranges"] = "bytes";
                }
            }

            long len = end - start + 1;
            var header = new StringBuilder();
            header.Append("HTTP/1.1 ").Append(status).Append(' ').Append(statusText).Append("\r\n");
            header.Append("Content-Type: ").Append(MimeOf(p)).Append("\r\n");
            header.Append("Content-Length: ").Append(len).Append("\r\n");
            header.Append("Connection: close\r\n");
            header.Append("Cache-Control: no-store\r\n");
            foreach (var kv in extra) header.Append(kv.Key).Append(": ").Append(kv.Value).Append("\r\n");
            header.Append("\r\n");
            var hb = Encoding.ASCII.GetBytes(header.ToString());
            ns.Write(hb, 0, hb.Length);

            using (var fs = new FileStream(p, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            {
                fs.Seek(start, SeekOrigin.Begin);
                var buf = new byte[64 * 1024];
                long left = len;
                while (left > 0)
                {
                    int n = fs.Read(buf, 0, (int)Math.Min(buf.Length, left));
                    if (n <= 0) break;
                    ns.Write(buf, 0, n);
                    left -= n;
                }
            }
            ns.Flush();
        }

        static void ServeImg(NetworkStream ns, Dictionary<string, string> qs)
        {
            if (!qs.ContainsKey("p")) { WriteText(ns, 404, "no path"); return; }
            string rel = qs["p"];
            if (rel.Contains("..")) { WriteText(ns, 403, "forbidden"); return; }
            string baseDir = CosplayDir;
            string full = Path.GetFullPath(Path.Combine(baseDir, rel));
            if (!full.StartsWith(Path.GetFullPath(baseDir), StringComparison.OrdinalIgnoreCase))
            { WriteText(ns, 403, "forbidden"); return; }
            if (!File.Exists(full)) { WriteText(ns, 404, "not found"); return; }
            ServeFile(ns, full, null);
        }

        static void ServeStatus(NetworkStream ns)
        {
            long bytes = 0; long imgs = 0;
            try
            {
                string q = Path.Combine(DataDir, "daily_quota.json");
                if (File.Exists(q))
                {
                    string t = File.ReadAllText(q, Encoding.UTF8);
                    bytes = JsonLong(t, "bytes");
                    imgs = JsonLong(t, "images");
                }
            }
            catch { }

            long libImages = 0, libBytes = 0;
            try
            {
                string st = Path.Combine(DataDir, "lib_stats.json");
                if (File.Exists(st))
                {
                    string t = File.ReadAllText(st, Encoding.UTF8);
                    libImages = JsonLong(t, "images");
                    libBytes = JsonLong(t, "bytes");
                }
            }
            catch { }

            long freeBytes = 0;
            try
            {
                var d = DriveInfo.GetDrives().FirstOrDefault(x => x.Name.StartsWith("D", StringComparison.OrdinalIgnoreCase));
                if (d != null && d.IsReady) freeBytes = d.AvailableFreeSpace;
            }
            catch { }

            string sd_pre = CosplayDir;
            // gui_status（运行状态）
            string gs = "";
            try { gs = ReadDataFile("gui_status.json"); } catch { }
            bool running = Worker.Alive;
            string curCoser = JsonStr(gs, "coser");
            long coserIdx = JsonLong(gs, "coserIdx");
            long albumsLeft = JsonLong(gs, "albumsLeft");
            long runBytes = JsonLong(gs, "runBytes");
            long runImages = JsonLong(gs, "runImages");
            long totalCoser = JsonLong(gs, "totalCoser");
            long doneCount = 0;
            try
            {
                if (Directory.Exists(sd_pre)) doneCount = Directory.GetDirectories(sd_pre).Length;
            }
            catch { }
            long curDone = JsonLong(gs, "curDone");
            long curTotal = JsonLong(gs, "curTotal");

            // 如果 status 里没有，用 totalCoser 从 coser_groups 估
            if (totalCoser <= 0)
            {
                try
                {
                    string g = Path.Combine(DataDir, "coser_groups.json");
                    if (File.Exists(g))
                    {
                        string t = File.ReadAllText(g, Encoding.UTF8);
                        int c = 0, idx = 0;
                        while ((idx = t.IndexOf("\"coser\"", idx, StringComparison.Ordinal)) >= 0) { c++; idx += 7; }
                        totalCoser = c;
                    }
                }
                catch { }
            }

            string sd = CosplayDir;
            var sb = new StringBuilder();
            sb.Append("{\"ok\":true");
            sb.Append(",\"running\":").Append(running ? "true" : "false");
            sb.Append(",\"bytesToday\":").Append(bytes);
            sb.Append(",\"imagesToday\":").Append(imgs);
            sb.Append(",\"quotaGB\":20");
            sb.Append(",\"libFiles\":").Append(libImages);
            sb.Append(",\"libImages\":").Append(libImages);
            sb.Append(",\"libBytes\":").Append(libBytes);
            sb.Append(",\"libGB\":").Append(((double)libBytes / 1073741824.0).ToString("0.00"));
            sb.Append(",\"freeBytes\":").Append(freeBytes);
            sb.Append(",\"diskFreeGB\":").Append(((double)freeBytes / 1073741824.0).ToString("0.0"));
            sb.Append(",\"saveDir\":\"").Append(JsonEscape(sd)).Append("\"");
            sb.Append(",\"libraryRoot\":\"").Append(JsonEscape(sd)).Append("\"");
            string coserVal = "";
            try
            {
                string wlp = Path.Combine(ROOT, "data", "worker.log");
                if (!File.Exists(wlp)) wlp = Path.Combine(ROOT, "worker.log");
                if (File.Exists(wlp))
                {
                    var allLines = File.ReadAllLines(wlp, Encoding.UTF8);
                    int from = Math.Max(0, allLines.Length - 100);
                    for (int li = allLines.Length - 1; li >= from; li--)
                    {
                        string ln = allLines[li];
                        string cand = null;
                        int pa = ln.IndexOf("    album ", StringComparison.Ordinal);
                        if (pa >= 0)
                        {
                            int p1 = pa + 10;
                            int p2 = ln.IndexOf(' ', p1);
                            if (p2 > p1) cand = ln.Substring(p1, p2 - p1);
                        }
                        else
                        {
                            int ps = ln.IndexOf("search [", StringComparison.Ordinal);
                            if (ps >= 0)
                            {
                                int p1 = ps + 8;
                                int p2 = ln.IndexOf(']', p1);
                                if (p2 > p1) cand = ln.Substring(p1, p2 - p1);
                            }
                        }
                        if (!string.IsNullOrEmpty(cand) && cand.Length > 0)
                        {
                            coserVal = cand.Trim();
                            break;
                        }
                        if (ln.IndexOf("aborted", StringComparison.OrdinalIgnoreCase) >= 0) break;
                    }
                }
            }
            catch { }
            sb.Append(",\"coser\":\"").Append(JsonEscape(coserVal)).Append("\"");
            sb.Append(",\"coserIdx\":").Append(coserIdx);
            sb.Append(",\"albumsLeft\":").Append(albumsLeft);
            sb.Append(",\"runBytes\":").Append(runBytes);
            sb.Append(",\"runImages\":").Append(runImages);
            sb.Append(",\"totalCoser\":").Append(totalCoser);
            sb.Append(",\"doneCount\":").Append(doneCount);
            sb.Append(",\"curDone\":").Append(curDone);
            if (coserVal.Length > 0) { string _oc = JsonStr(gs, "coser") ?? ""; if (_oc != coserVal && _oc.Length > 0) curTotal = 0; }
            sb.Append(",\"curTotal\":").Append(curTotal);
            sb.Append(",\"minutes\":").Append(JsonLong(gs, "minutes"));
            // 从 worker.log 读最近 60 行
            sb.Append(",\"log\":[");
            try
            {
                string wl = Path.Combine(ROOT, "data", "worker.log");
                if (!File.Exists(wl)) wl = Path.Combine(ROOT, "worker.log");
                if (File.Exists(wl))
                {
                    var all = File.ReadAllLines(wl);
                    int from = Math.Max(0, all.Length - 60);
                    bool firstLine = true;
                    for (int i = from; i < all.Length; i++)
                    {
                        if (string.IsNullOrEmpty(all[i])) continue;
                        if (!firstLine) sb.Append(',');
                        firstLine = false;
                        sb.Append("\"").Append(JsonEscape(all[i].Replace("\\", "/"))).Append("\"");
                    }
                }
            }
            catch { }
            sb.Append("]");
            sb.Append("}");
            WriteText(ns, 200, sb.ToString(), "application/json; charset=utf-8");
        }

        static void ServePhotos(NetworkStream ns, Dictionary<string, string> qs)
        {
            string dir = qs.ContainsKey("dir") ? qs["dir"] : "";
            int page = 1, size = 60;
            int.TryParse(qs.ContainsKey("page") ? qs["page"] : "1", out page);
            int.TryParse(qs.ContainsKey("size") ? qs["size"] : "60", out size);
            if (page < 1) page = 1;
            if (size < 1) size = 60;

            string baseDir = CosplayDir;
            string full = Path.GetFullPath(Path.Combine(baseDir, dir));
            var files = new List<string>();
            if (Directory.Exists(full))
            {
                try
                {
                    foreach (var f in Directory.EnumerateFiles(full))
                    {
                        string e = Path.GetExtension(f).ToLowerInvariant();
                        if (e == ".jpg" || e == ".jpeg" || e == ".png" || e == ".webp" || e == ".gif" || e == ".mp4")
                            files.Add(Path.GetFileName(f));
                    }
                }
                catch { }
            }
            files.Sort(StringComparer.OrdinalIgnoreCase);
            int total = files.Count;
            int from = (page - 1) * size;
            var sb = new StringBuilder();
            sb.Append("{\"ok\":true,\"total\":").Append(total).Append(",\"files\":[");
            for (int i = from; i < Math.Min(total, from + size); i++)
            {
                if (i > from) sb.Append(',');
                string rel = Path.Combine(dir, files[i]).Replace('\\', '/');
                sb.Append("{\"name\":\"").Append(JsonEscape(files[i])).Append("\",\"u\":\"/img?p=").Append(JsonEscape(rel)).Append("\"}");
            }
            sb.Append("]}");
            WriteText(ns, 200, sb.ToString(), "application/json; charset=utf-8");
        }

        static void ServeTree(NetworkStream ns)
        {
            string baseDir = CosplayDir;
            var sb = new StringBuilder();
            sb.Append("[");
            try
            {
                var cosers = Directory.Exists(baseDir)
                    ? Directory.GetDirectories(baseDir).Select(Path.GetFileName).OrderBy(x => x, StringComparer.OrdinalIgnoreCase).ToList()
                    : new List<string>();
                for (int i = 0; i < cosers.Count; i++)
                {
                    if (i > 0) sb.Append(',');
                    sb.Append("{\"name\":\"").Append(JsonEscape(cosers[i])).Append("\",\"works\":[");
                    string cdir = Path.Combine(baseDir, cosers[i]);
                    var works = Directory.Exists(cdir)
                        ? Directory.GetDirectories(cdir).Select(Path.GetFileName).OrderBy(x => x, StringComparer.OrdinalIgnoreCase).ToList()
                        : new List<string>();
                    for (int w = 0; w < works.Count; w++)
                    {
                        if (w > 0) sb.Append(',');
                        sb.Append("{\"name\":\"").Append(JsonEscape(works[w])).Append("\",\"roles\":[");
                        string wdir = Path.Combine(cdir, works[w]);
                        var roles = Directory.Exists(wdir)
                            ? Directory.GetDirectories(wdir).Select(Path.GetFileName).OrderBy(x => x, StringComparer.OrdinalIgnoreCase).ToList()
                            : new List<string>();
                        for (int r = 0; r < roles.Count; r++)
                        {
                            if (r > 0) sb.Append(',');
                            string rdir = Path.Combine(wdir, roles[r]);
                            int cnt = 0;
                            try { cnt = Directory.GetFiles(rdir).Length; } catch { }
                            sb.Append("{\"name\":\"").Append(JsonEscape(roles[r])).Append("\",\"count\":").Append(cnt).Append('}');
                        }
                        sb.Append("]}");
                    }
                    sb.Append("]}");
                }
            }
            catch { }
            sb.Append("]");
            WriteText(ns, 200, sb.ToString(), "application/json; charset=utf-8");
        }

        // ---------- 业务：运行状态 ----------
        static string ReadDataFile(string name)
        {
            try
            {
                string p = Path.Combine(DataDir, name);
                return File.Exists(p) ? File.ReadAllText(p, Encoding.UTF8) : "";
            }
            catch { return ""; }
        }

        static long JsonLong(string json, string key)
        {
            try
            {
                var m = System.Text.RegularExpressions.Regex.Match(json,
                    "\"" + key + "\"\\s*:\\s*(-?\\d+)");
                if (m.Success) { long v; long.TryParse(m.Groups[1].Value, out v); return v; }
            }
            catch { }
            return 0;
        }

        static string JsonStr(string json, string key)
        {
            try
            {
                var m = System.Text.RegularExpressions.Regex.Match(json,
                    "\"" + key + "\"\\s*:\\s*\"([^\"]*)\"");
                if (m.Success) return m.Groups[1].Value.Replace("\\\\", "\\");
            }
            catch { }
            return "";
        }

        static bool JsonBool(string json, string key)
        {
            try
            {
                var m = System.Text.RegularExpressions.Regex.Match(json,
                    "\"" + key + "\"\\s*:\\s*(true|false)");
                if (m.Success) return m.Groups[1].Value == "true";
            }
            catch { }
            return false;
        }

        static void ServeRunning(NetworkStream ns)
        {
            string st = ReadDataFile("gui_status.json");
            bool running = JsonBool(st, "running");
            long pid = JsonLong(st, "pid");
            if (running && pid > 0)
            {
                try { var p = System.Diagnostics.Process.GetProcessById((int)pid); if (p.HasExited) running = false; }
                catch { running = false; }
            }
            string j = "{\"running\":" + (running ? "true" : "false")
                + ",\"pid\":" + pid
                + ",\"coser\":\"" + JsonEscape(JsonStr(st, "coser")) + "\""
                + ",\"minutes\":" + JsonLong(st, "minutes")
                + ",\"doneCount\":" + JsonLong(st, "doneCount")
                + ",\"albumsLeft\":" + JsonLong(st, "albumsLeft")
                + ",\"totalCoser\":" + JsonLong(st, "totalCoser")
                + ",\"coserIdx\":" + JsonLong(st, "coserIdx")
                + ",\"runBytes\":" + JsonLong(st, "runBytes")
                + ",\"runImages\":" + JsonLong(st, "runImages")
                + "}";
            WriteText(ns, 200, j, "application/json; charset=utf-8");
        }

        // ---------- 业务：启动下载 ----------
        static void ServeStart(NetworkStream ns, Dictionary<string, string> qs, byte[] body)
        {
            string coser = qs.ContainsKey("coser") ? qs["coser"] : null;
            double minutes = 60;
            double quota = 20;
            try
            {
                string raw = body != null ? Encoding.UTF8.GetString(body) : "{}";
                // 关键：前端把 coser 放在 POST body 里，必须也读 body
                string bodyCoser = JsonStr(raw, "coser");
                if (!string.IsNullOrEmpty(bodyCoser)) coser = bodyCoser;
                double m0 = JsonLong(raw, "minutes");
                if (m0 > 0) minutes = m0;
                double q0 = JsonLong(raw, "quota");
                if (q0 > 0) quota = q0;
            }
            catch { }

            Worker.LogRoot = ROOT;

            // 0) 停掉上一个任务，并等它真正释放下载锁（最多 8 秒）
            if (Worker.Alive || Worker.IsBusy)
            {
                Worker.Alive = false;
                Worker.Log("start: stopping previous worker");
                int waited = 0;
                for (int w = 0; w < 80; w++)
                {
                    if (!Worker.IsBusy) break;
                    Thread.Sleep(100);
                    waited += 100;
                }
                Thread.Sleep(300);
                Worker.Log("start: previous worker released (waited " + waited + "ms)");
            }

            // 1) 同步搜索（在 HTTP 线程里做，保证执行）
            if (!string.IsNullOrEmpty(coser))
            {
                try
                {
                    var albums = Worker.SearchCoser(coser);
                    if (albums != null && albums.Count > 0)
                    {
                        string coserArg = coser;
                        string rootArg = ROOT;
                        var albumList = albums;
                        Worker.Alive = true;
                        new System.Threading.Thread(delegate ()
                        {
                            try
                            {
                                Worker.DownloadSearchResults(coserArg, albumList, Path.Combine(rootArg, "cosplay"));
                            }
                            catch (Exception ex)
                            {
                                Worker.Log("search dl err: " + ex.Message);
                            }
                            finally { Worker.Alive = false; }
                        }).Start();

                        WriteText(ns, 200,
                            "{\"ok\":true,\"engine\":\"search\",\"coser\":\"" + JsonEscape(coser) + "\",\"albums\":" + albums.Count + "}",
                            "application/json; charset=utf-8");
                        return;
                    }
                    Worker.Log("search [" + coser + "] 0 albums -> abort (no list fallback)");
                    WriteText(ns, 200,
                        "{\"ok\":false,\"engine\":\"search\",\"coser\":\"" + JsonEscape(coser) + "\",\"msg\":\"站点没搜到这个 coser（换名字或检查拼写）\"}",
                        "application/json; charset=utf-8");
                    return;
                }
                catch (Exception ex)
                {
                    Worker.Log("search err: " + ex.Message);
                    WriteText(ns, 200,
                        "{\"ok\":false,\"engine\":\"search\",\"msg\":\"搜索出错: " + JsonEscape(ex.Message) + "\"}",
                        "application/json; charset=utf-8");
                    return;
                }
            }

            // 2) 列表模式
            string rootA = ROOT, exeA = EXEDIR, coserA = coser;
            int minA = (int)minutes;
            double qA = quota;
            Worker.Alive = true;
            new System.Threading.Thread(delegate ()
            {
                if (!Worker.TryLock()) { Worker.Log("list mode rejected: busy"); Worker.Alive = false; return; }
                try
                {
                    Worker.LogRoot = rootA;
                    Worker.Run(rootA, exeA, minA, qA, coserA);
                }
                catch (Exception wex)
                {
                    try
                    {
                        Worker.Log("run err: " + wex.Message);
                        File.WriteAllText(Path.Combine(DataDir, "gui_status.json"),
                            "{\"running\": false, \"error\": \"" + JsonEscape(wex.Message) + "\"}");
                    }
                    catch { }
                }
                finally { Worker.Alive = false; Worker.Unlock(); }
            }).Start();

            WriteText(ns, 200, "{\"ok\":true,\"engine\":\"builtin\"}", "application/json; charset=utf-8");
        }

        static void ServeStop(NetworkStream ns)
        {
            Worker.Alive = false;
            string st = ReadDataFile("gui_status.json");
            long pid = JsonLong(st, "pid");
            bool killed = false;
            // 内置 worker：不杀引擎进程，只置状态（worker 自己检查后退出）
            bool hasWorker = pid > 1;
            try
            {
                // 标记停止
                string cur = File.Exists(Path.Combine(DataDir, "gui_status.json"))
                    ? File.ReadAllText(Path.Combine(DataDir, "gui_status.json")) : "{}";
                cur = System.Text.RegularExpressions.Regex.Replace(cur, "\"running\"\\s*:\\s*(true|false)", "\"running\": false");
                File.WriteAllText(Path.Combine(DataDir, "gui_status.json"), cur);
            }
            catch { }
            WriteText(ns, 200, "{\"ok\":true,\"killed\":" + (killed ? "true" : "false") + "}", "application/json; charset=utf-8");
        }

        // ---------- 业务：配置 ----------
        static void ServeConfigGet(NetworkStream ns)
        {
            string cfg = ReadDataFile("manual_config.json");
            if (string.IsNullOrEmpty(cfg)) cfg = "{\"quotaGB\":20,\"minutes\":10,\"libraryRoot\":\"\"}";
            WriteText(ns, 200, cfg, "application/json; charset=utf-8");
        }

        static void ServeConfigSave(NetworkStream ns, byte[] body)
        {
            string raw = body != null ? Encoding.UTF8.GetString(body) : "{}";
            try
            {
                long quota = JsonLong(raw, "quotaGB"); if (quota <= 0) quota = 20;
                long minutes = JsonLong(raw, "minutes"); if (minutes <= 0) minutes = 10;
                string lib = JsonStr(raw, "libraryRoot");

                string j = "{\"quotaGB\": " + quota + ", \"minutes\": " + minutes + ", \"libraryRoot\": \"" + JsonEscape(lib) + "\"}";
                File.WriteAllText(Path.Combine(DataDir, "manual_config.json"), j);

                // libraryRoot 同时写进 config.json 的 saveDir
                if (!string.IsNullOrEmpty(lib))
                {
                    string cp = Path.Combine(DataDir, "config.json");
                    string cur = File.Exists(cp) ? File.ReadAllText(cp, Encoding.UTF8) : "{}";
                    if (cur.Contains("\"saveDir\""))
                        cur = System.Text.RegularExpressions.Regex.Replace(cur,
                            "\"saveDir\"\\s*:\\s*\"[^\"]*\"", "\"saveDir\": \"" + JsonEscape(lib) + "\"");
                    else
                        cur = cur.TrimEnd('}') + (cur.Trim().EndsWith("{") ? "" : ",") + "\"saveDir\": \"" + JsonEscape(lib) + "\"}";
                    File.WriteAllText(cp, cur);
                }
                WriteText(ns, 200, "{\"ok\":true}", "application/json; charset=utf-8");
            }
            catch (Exception ex)
            {
                WriteText(ns, 200, "{\"ok\":false,\"msg\":\"" + JsonEscape(ex.Message) + "\"}", "application/json; charset=utf-8");
            }
        }

        // ---------- 业务：鱼鱼找鸡 ----------
        static readonly object FishLock = new object();
        static string FishState = "{\"running\":false}";

        static string FindNodeExe()
        {
            string p = Path.Combine(EXEDIR, "node.exe");
            if (File.Exists(p)) return p;
            string sys = @"C:\\Program Files\\nodejs\\node.exe";
            if (File.Exists(sys)) return sys;
            return null;
        }

        static void ServeFish(NetworkStream ns, byte[] body)
        {
            string raw = body != null ? Encoding.UTF8.GetString(body) : "{}";
            string b64 = JsonStr(raw, "data");
            string name = JsonStr(raw, "name");
            if (string.IsNullOrEmpty(name)) name = "upload.jpg";

            if (string.IsNullOrEmpty(b64))
            {
                WriteText(ns, 200, "{\"ok\":false,\"msg\":\"no image\"}", "application/json; charset=utf-8");
                return;
            }

            string tmpDir = Path.Combine(EXEDIR, "fish_tmp");
            try { Directory.CreateDirectory(tmpDir); } catch { }
            string tmp = Path.Combine(tmpDir, "gg_fish_" + DateTime.Now.Ticks + "_" + name);
            try { File.WriteAllBytes(tmp, Convert.FromBase64String(b64)); }
            catch
            {
                WriteText(ns, 200, "{\"ok\":false,\"msg\":\"tmp write fail\"}", "application/json; charset=utf-8");
                return;
            }

            LensEngine.Run(tmp, 70000);
            WriteText(ns, 200, "{\"ok\":true,\"started\":true}", "application/json; charset=utf-8");
        }

        // 从 Lens 结果的标题里抽账号（不依赖 goto token 解密）
        static string ExtractAccountsJson(string lensJson)
        {
            var accounts = new List<string>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            try
            {
                int p = 0;
                while (true)
                {
                    int ti = lensJson.IndexOf("\"title\":\"", p, StringComparison.Ordinal);
                    if (ti < 0) break;
                    int vs = ti + 9;
                    int ve = vs;
                    var sb = new StringBuilder();
                    while (ve < lensJson.Length)
                    {
                        char c = lensJson[ve];
                        if (c == '\\' && ve + 1 < lensJson.Length)
                        {
                            sb.Append(lensJson[ve + 1]);
                            ve += 2;
                            continue;
                        }
                        if (c == '"') break;
                        sb.Append(c);
                        ve++;
                    }
                    string title = sb.ToString();
                    p = ve + 1;
                    if (title.Length < 4) continue;

                    // 1) @handle
                    foreach (Match m in Regex.Matches(title, "@([A-Za-z0-9_.]{2,20})"))
                    {
                        string h = m.Groups[1].Value.TrimEnd('.');
                        if (h.Length >= 2 && seen.Add(h)) accounts.Add(h);
                    }
                    // 2) "Name on X:"
                    var mx = Regex.Match(title, @"^(.{2,40}?)\s*on\s*X\s*[：:]");
                    if (mx.Success)
                    {
                        string n = mx.Groups[1].Value.Trim();
                        if (n.Length >= 2 && seen.Add(n)) accounts.Add(n);
                    }
                    // 3) "posted by xxx"
                    var mp = Regex.Match(title, @"posted by\s+([^\s\(]{2,30})", RegexOptions.IgnoreCase);
                    if (mp.Success)
                    {
                        string n = mp.Groups[1].Value.Trim();
                        if (n.Length >= 2 && seen.Add(n)) accounts.Add(n);
                    }
                }
            }
            catch { }

            var sb2 = new StringBuilder();
            sb2.Append("[");
            for (int i = 0; i < accounts.Count; i++)
            {
                if (i > 0) sb2.Append(",");
                sb2.Append("\"").Append(JsonEscape(accounts[i])).Append("\"");
            }
            sb2.Append("]");
            return sb2.ToString();
        }

        static void ServeLocalFile(NetworkStream ns, Dictionary<string, string> qs, string range)
        {
            try
            {
                string p = qs.ContainsKey("p") ? qs["p"] : "";
                if (string.IsNullOrEmpty(p) || !File.Exists(p))
                {
                    WriteText(ns, 404, "not found");
                    return;
                }
                ServeFile(ns, p, range);
            }
            catch { WriteText(ns, 500, "err"); }
        }

        static void ServeReveal(NetworkStream ns, Dictionary<string, string> qs)
        {
            try
            {
                string p = qs.ContainsKey("p") ? qs["p"] : "";
                if (string.IsNullOrEmpty(p) || !File.Exists(p))
                {
                    WriteText(ns, 200, "{\"ok\":false,\"msg\":\"file not found\"}", "application/json; charset=utf-8");
                    return;
                }
                var psi = new System.Diagnostics.ProcessStartInfo();
                psi.FileName = "explorer.exe";
                psi.Arguments = "/select,\"" + p + "\"";
                psi.UseShellExecute = true;
                System.Diagnostics.Process.Start(psi);
                WriteText(ns, 200, "{\"ok\":true}", "application/json; charset=utf-8");
            }
            catch (Exception ex)
            {
                WriteText(ns, 200, "{\"ok\":false,\"msg\":\"" + JsonEscape(ex.Message) + "\"}", "application/json; charset=utf-8");
            }
        }

        static void ServeSearch(NetworkStream ns, Dictionary<string, string> qs)
        {
            string name = qs.ContainsKey("name") ? qs["name"] : "";
            if (string.IsNullOrEmpty(name))
            {
                WriteText(ns, 200, "{\"ok\":false,\"msg\":\"missing name\"}", "application/json; charset=utf-8");
                return;
            }
            try
            {
                Worker.LogRoot = ROOT;
                var albums = Worker.SearchCoser(name);
                var sb = new StringBuilder();
                sb.Append("{\"ok\":true,\"name\":\"").Append(JsonEscape(name)).Append("\",\"count\":").Append(albums.Count).Append(",\"albums\":[");
                for (int i = 0; i < albums.Count && i < 50; i++)
                {
                    if (i > 0) sb.Append(",");
                    sb.Append("{\"title\":\"").Append(JsonEscape(albums[i][0])).Append("\",\"url\":\"").Append(JsonEscape(albums[i][1])).Append("\"}");
                }
                sb.Append("]}");
                WriteText(ns, 200, sb.ToString(), "application/json; charset=utf-8");
            }
            catch (Exception ex)
            {
                WriteText(ns, 200, "{\"ok\":false,\"msg\":\"" + JsonEscape(ex.Message) + "\"}", "application/json; charset=utf-8");
            }
        }

        static void ServeDl(NetworkStream ns, byte[] body)
        {
            string raw = body != null ? Encoding.UTF8.GetString(body) : "{}";
            string url = JsonStr(raw, "url");
            if (string.IsNullOrEmpty(url))
            {
                WriteText(ns, 200, "{\"ok\":false,\"msg\":\"missing url\"}", "application/json; charset=utf-8");
                return;
            }

            string dest = Path.Combine(CosplayDir, "Downloads");
            string err = Worker.YtDlpDownload(url, dest, EXEDIR);

            if (err == null)
            {
                // 收集刚下载的文件
                int cnt = 0; long bytes = 0;
                var fileList = new System.Text.StringBuilder();
                fileList.Append("[");
                try
                {
                    foreach (var f in Directory.GetFiles(dest, "*", SearchOption.AllDirectories))
                    {
                        var fi = new FileInfo(f);
                        if ((DateTime.Now - fi.LastWriteTime).TotalMinutes < 10)
                        {
                            if (cnt > 0) fileList.Append(",");
                            string rel = f.Substring(dest.Length).TrimStart('\\', '/').Replace('\\', '/');
                            fileList.Append("{\"name\":\"").Append(JsonEscape(fi.Name)).Append("\"");
                            fileList.Append(",\"path\":\"").Append(JsonEscape(f)).Append("\"");
                            fileList.Append(",\"rel\":\"").Append(JsonEscape(rel)).Append("\"");
                            fileList.Append(",\"size\":").Append(fi.Length);
                            fileList.Append(",\"ext\":\"").Append(JsonEscape(fi.Extension.TrimStart('.'))).Append("\"}");
                            cnt++; bytes += fi.Length;
                        }
                    }
                }
                catch { }
                fileList.Append("]");
                WriteText(ns, 200, "{\"ok\":true,\"dir\":\"" + JsonEscape(dest) + "\",\"count\":" + cnt + ",\"bytes\":" + bytes + ",\"files\":" + fileList.ToString() + "}", "application/json; charset=utf-8");
            }
            else if (err == "no-video")
            {
                WriteText(ns, 200, "{\"ok\":false,\"msg\":\"这条没有可下载的视频（纯图片推文 yt-dlp 不支持）\"}", "application/json; charset=utf-8");
            }
            else
            {
                WriteText(ns, 200, "{\"ok\":false,\"msg\":\"" + JsonEscape(err) + "\"}", "application/json; charset=utf-8");
            }
        }

        static void ServeXSetCookie(NetworkStream ns, byte[] body)
        {
            string raw = body != null ? Encoding.UTF8.GetString(body) : "{}";
            string at = JsonStr(raw, "at");
            if (string.IsNullOrEmpty(at))
            {
                WriteText(ns, 200, "{\"ok\":false,\"msg\":\"empty\"}", "application/json; charset=utf-8");
                return;
            }
            try
            {
                Directory.CreateDirectory(DataDir);
                File.WriteAllText(Path.Combine(DataDir, "x_cookie.json"), "{\"at\":\"" + JsonEscape(at) + "\"}");
                WriteText(ns, 200, "{\"ok\":true}", "application/json; charset=utf-8");
            }
            catch (Exception ex)
            {
                WriteText(ns, 200, "{\"ok\":false,\"msg\":\"" + JsonEscape(ex.Message) + "\"}", "application/json; charset=utf-8");
            }
        }

        static void ServeXGetCookie(NetworkStream ns)
        {
            try
            {
                string p = Path.Combine(DataDir, "x_cookie.json");
                if (File.Exists(p))
                {
                    string t = File.ReadAllText(p, Encoding.UTF8);
                    string at = JsonStr(t, "at");
                    if (!string.IsNullOrEmpty(at))
                    {
                        string prev = at.Length > 8 ? at.Substring(0, 4) + "…" + at.Substring(at.Length - 4) : "****";
                        WriteText(ns, 200, "{\"has\":true,\"preview\":\"" + JsonEscape(prev) + "\"}", "application/json; charset=utf-8");
                        return;
                    }
                }
            }
            catch { }
            WriteText(ns, 200, "{\"has\":false}", "application/json; charset=utf-8");
        }

        static void ServeXBrowser(NetworkStream ns, byte[] body)
        {
            string raw = body != null ? Encoding.UTF8.GetString(body) : "{}";
            string url = JsonStr(raw, "url");
            if (string.IsNullOrEmpty(url))
            {
                WriteText(ns, 200, "{\"ok\":false,\"msg\":\"missing url\"}", "application/json; charset=utf-8");
                return;
            }
            string page = XBrowser.FetchTweet(url, 60000);
            if (string.IsNullOrEmpty(page))
            {
                WriteText(ns, 200, "{\"ok\":false,\"msg\":\"browser fetch timeout\"}", "application/json; charset=utf-8");
                return;
            }
            // 从 page JSON 里取 images/videos 下载
            string result = Worker.DownloadFromPageJson(page, CosplayDir, url);
            WriteText(ns, 200, result, "application/json; charset=utf-8");
        }

        static void ServeXDownload(NetworkStream ns, byte[] body)
        {
            string raw = body != null ? Encoding.UTF8.GetString(body) : "{}";
            string url = JsonStr(raw, "url");
            if (string.IsNullOrEmpty(url))
            {
                WriteText(ns, 200, "{\"ok\":false,\"msg\":\"missing url\"}", "application/json; charset=utf-8");
                return;
            }
            string result;
            try { result = Worker.XDownload(url, CosplayDir); }
            catch (Exception ex) { result = "{\"ok\":false,\"msg\":\"" + JsonEscape(ex.Message) + "\"}"; }
            WriteText(ns, 200, result, "application/json; charset=utf-8");
        }

        static void ServeFishStatus(NetworkStream ns)
        {
            var sb = new StringBuilder();
            sb.Append("{\"running\":");
            sb.Append(LensEngine.Busy ? "true" : "false");

            if (!LensEngine.Busy)
            {
                if (!string.IsNullOrEmpty(LensEngine.LastResult))
                {
                    string accJson = ExtractAccountsJson(LensEngine.LastResult);
                    sb.Append(",\"accounts\":").Append(accJson);

                    // 合成给人看的 text（跟 Node 版格式一致）
                    var names = new List<string>();
                    try
                    {
                        int p2 = 0;
                        while (true)
                        {
                            int q1 = accJson.IndexOf('"', p2);
                            if (q1 < 0) break;
                            int q2 = accJson.IndexOf('"', q1 + 1);
                            if (q2 < 0) break;
                            names.Add(accJson.Substring(q1 + 1, q2 - q1 - 1));
                            p2 = q2 + 1;
                        }
                    }
                    catch { }

                    var txt = new StringBuilder();
                    txt.Append("\uD83C\uDFAF **鱼鱼找鸡结果**\n\n");
                    txt.Append("\uD83C\uDF10 平台：Twitter / Threads / 其他\n");
                    if (names.Count > 0)
                    {
                        txt.Append("\uD83D\uDC64 候选账号（").Append(names.Count).Append(" 个）：\n");
                        for (int i = 0; i < names.Count && i < 10; i++)
                        {
                            txt.Append("   \u00B7 ").Append(names[i]).Append("\n");
                        }
                    }
                    else
                    {
                        txt.Append("没有从结果标题里提取到账号\n");
                    }
                    txt.Append("\n数据来源：Google Lens 图片反查");

                    sb.Append(",\"text\":\"").Append(JsonEscape(txt.ToString())).Append("\"");
                    sb.Append(",\"result\":{\"text\":\"").Append(JsonEscape(txt.ToString())).Append("\",\"count\":").Append(names.Count).Append(",\"raw\":").Append(LensEngine.LastResult).Append("}");
                }
                else if (!string.IsNullOrEmpty(LensEngine.LastError))
                {
                    sb.Append(",\"error\":\"").Append(JsonEscape(LensEngine.LastError)).Append("\"");
                }
            }
            sb.Append("}");
            WriteText(ns, 200, sb.ToString(), "application/json; charset=utf-8");
        }

    }
}
