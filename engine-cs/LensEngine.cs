using System;
using System.Drawing;
using System.Text;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace GalleryEngine
{
    static class LensEngine
    {
        public static volatile bool Busy = false;
        public static volatile string LastResult = null;
        public static volatile string LastError = null;

        const string LENS_EXTRACT = @"(function(){
  var isGoogle=function(h){return /(^|\.)google\.[a-z.]+$/i.test(h);};
  var isAsset=function(h){return /(^|\.)(gstatic|googleusercontent)\.com$/i.test(h);};
  var cleanTitle=function(n){
    var h=n.querySelector('h1,h2,h3,[role=heading]');
    var t=String((h&&h.textContent)||n.getAttribute('aria-label')||n.textContent||'').replace(/\s+/g,' ').trim();
    return t.slice(0,200);
  };
  var rows=[],seen={};
  var links=document.querySelectorAll('a[href]');
  for(var i=0;i<links.length;i++){
    var a=links[i];
    try{var u=new URL(a.getAttribute('href'),location.href);}catch(e){continue;}
    if(u.protocol!=='https:')continue;
    var title=cleanTitle(a);
    if(!title)continue;
    if(isGoogle(u.hostname)&&u.pathname==='/goto'){
      var tok=u.searchParams.get('url')||'';
      if(tok&&!seen['g:'+tok]){seen['g:'+tok]=1;rows.push({url:'',token:tok,title:title});}
      continue;
    }
    if(isGoogle(u.hostname)||isAsset(u.hostname)){
      var w=u.searchParams.get('url')||u.searchParams.get('q')||'';
      if(!/^https?:\/\//.test(w)||seen[w])continue;
      seen[w]=1;rows.push({url:w,token:'',title:title});
      continue;
    }
    if(seen[u.href])continue;
    seen[u.href]=1;rows.push({url:u.href,token:'',title:title});
  }
  var body=document.body?document.body.innerText.slice(0,4000):'';
  return JSON.stringify({url:location.href,count:rows.length,results:rows,
    captcha:/unusual traffic|our systems have detected/i.test(body),
    empty:/No matches|No results|找不到相符|没有找到|未找到/i.test(body)});
})()";

        public static void Run(string imagePath, int timeoutMs)
        {
            if (Busy) { LastError = "上一张还在查"; return; }
            Busy = true; LastResult = null; LastError = null;
            string b64, mime, ext;
            try
            {
                b64 = Convert.ToBase64String(File.ReadAllBytes(imagePath));
                ext = Path.GetExtension(imagePath).TrimStart('.').ToLowerInvariant();
                if (ext == "jpeg") ext = "jpg";
                if (string.IsNullOrEmpty(ext)) ext = "jpg";
                mime = ext == "png" ? "image/png" : (ext == "webp" ? "image/webp" : "image/jpeg");
            }
            catch (Exception ex) { LastError = "read fail: " + ex.Message; Busy = false; return; }

            Thread t = new Thread(delegate () { RunOnUi(b64, mime, ext, timeoutMs); });
            t.SetApartmentState(ApartmentState.STA);
            t.IsBackground = true;
            t.Start();
        }

        static void RunOnUi(string b64, string mime, string ext, int timeoutMs)
        {
            Form host = null; WebView2 wv = null;
            try
            {
                host = new Form();
                host.FormBorderStyle = FormBorderStyle.None;
                host.ShowInTaskbar = false;
                host.Opacity = 0;
                host.Size = new Size(1280, 900);
                host.StartPosition = FormStartPosition.Manual;
                host.Location = new Point(-6000, -6000);

                wv = new WebView2(); wv.Dock = DockStyle.Fill;
                host.Controls.Add(wv);

                host.Load += delegate (object s, EventArgs e)
                {
                    var runner = System.Threading.Tasks.Task.Run(delegate () { });
                    RunPipeline(host, wv, b64, mime, ext, timeoutMs);
                };

                Application.Run(host);
            }
            catch (Exception ex) { LastError = ex.GetType().Name + ": " + ex.Message; }
            finally
            {
                try { if (wv != null) wv.Dispose(); } catch { }
                try { if (host != null && !host.IsDisposed) host.Dispose(); } catch { }
                Busy = false;
            }
        }

        static async void RunPipeline(Form host, WebView2 wv, string b64, string mime, string ext, int timeoutMs)
        {
            try
            {
                string profile = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "WebView2Lens");
                var opts = new CoreWebView2EnvironmentOptions("--disable-features=msSmartScreenProtection");
                var env = await CoreWebView2Environment.CreateAsync(null, profile, opts);
                await wv.EnsureCoreWebView2Async(env);

                var core = wv.CoreWebView2;
                var navDone = new ManualResetEventSlim(false);
                core.NavigationCompleted += delegate (object a, CoreWebView2NavigationCompletedEventArgs b) { navDone.Set(); };

                string form = "<html><body><form id='f' method='POST' enctype='multipart/form-data' action='https://lens.google.com/v3/upload?hl=zh-CN'>" +
                    "<input type='file' name='encoded_image' id='i'/></form><script>" +
                    "var b='" + b64 + "',m='" + mime + "',ext='" + ext + "';" +
                    "var bin=atob(b),arr=new Uint8Array(bin.length);" +
                    "for(var i=0;i<bin.length;i++)arr[i]=bin.charCodeAt(i);" +
                    "var f=new File([arr],'u.'+ext,{type:m});" +
                    "var dt=new DataTransfer();dt.items.add(f);" +
                    "document.getElementById('i').files=dt.files;" +
                    "document.getElementById('f').submit();" +
                    "</script></body></html>";

                navDone.Reset();
                core.NavigateToString(form);
                await System.Threading.Tasks.Task.Delay(6000);

                var sw = System.Diagnostics.Stopwatch.StartNew();
                string lastUrl = "", extracted = null;
                while (sw.ElapsedMilliseconds < timeoutMs)
                {
                    await System.Threading.Tasks.Task.Delay(1800);
                    string cur = null;
                    try { cur = core.Source; } catch { }
                    if (!string.IsNullOrEmpty(cur) && (cur.Contains("lens.google.com") || cur.Contains("google.com/search") || cur.Contains("vsrid=")))
                    {
                        try
                        {
                            string raw = await core.ExecuteScriptAsync(LENS_EXTRACT);
                            string un = UnescapeJsResult(raw);
                            if (!string.IsNullOrEmpty(un) && un.Contains("\"results\"")) { extracted = un; break; }
                        }
                        catch { }
                    }
                    lastUrl = cur;
                }
                if (extracted != null)
                {
                    // 解析 goto token -> 真实 URL（拿域名和账号）
                    try
                    {
                        extracted = await ResolveGotoLinks(core, extracted);
                    }
                    catch { }
                    LastResult = extracted;
                }
                else LastError = "no result (url=" + (lastUrl ?? "?") + ")";
            }
            catch (Exception ex)
            {
                LastError = ex.GetType().Name + ": " + ex.Message;
            }
            finally
            {
                try { host.BeginInvoke(new MethodInvoker(delegate { host.Close(); })); } catch { }
            }
        }

        static async System.Threading.Tasks.Task<string> ResolveGotoLinks(Microsoft.Web.WebView2.Core.CoreWebView2 core, string lensJson)
        {
            var tokens = new List<string>();
            int p = 0;
            while (tokens.Count < 12)
            {
                int ti = lensJson.IndexOf("\"token\":\"", p, StringComparison.Ordinal);
                if (ti < 0) break;
                int vs = ti + 9;
                int ve = lensJson.IndexOf('"', vs);
                if (ve < 0) break;
                string tok = lensJson.Substring(vs, ve - vs);
                if (tok.Length > 8 && !tokens.Contains(tok)) tokens.Add(tok);
                p = ve + 1;
            }
            if (tokens.Count == 0) return lensJson;

            var real = new List<string>();
            var nav = new ManualResetEventSlim(false);
            EventHandler<Microsoft.Web.WebView2.Core.CoreWebView2NavigationCompletedEventArgs> h =
                delegate (object a, Microsoft.Web.WebView2.Core.CoreWebView2NavigationCompletedEventArgs b) { nav.Set(); };
            core.NavigationCompleted += h;
            try
            {
                foreach (var tok in tokens)
                {
                    try
                    {
                        nav.Reset();
                        core.Navigate("https://www.google.com/goto?url=" + Uri.EscapeDataString(tok));
                        nav.Wait(9000);
                        await System.Threading.Tasks.Task.Delay(400);
                        string u = null;
                        try { u = core.Source; } catch { }
                        if (!string.IsNullOrEmpty(u) && u.IndexOf("google.com", StringComparison.OrdinalIgnoreCase) < 0)
                            real.Add(u);
                    }
                    catch { }
                }
            }
            finally
            {
                try { core.NavigationCompleted -= h; } catch { }
            }

            var sb = new StringBuilder();
            sb.Append(lensJson.TrimEnd());
            if (sb.Length > 0 && sb[sb.Length - 1] == '}')
            {
                sb.Length -= 1;
                sb.Append(",\"resolved\":[");
                for (int i = 0; i < real.Count; i++)
                {
                    if (i > 0) sb.Append(',');
                    sb.Append("\"").Append(real[i].Replace("\\", "\\\\").Replace("\"", "\\\"")).Append("\"");
                }
                sb.Append("]}");
            }
            return sb.ToString();
        }

        static string UnescapeJsResult(string raw)
        {
            if (string.IsNullOrEmpty(raw)) return null;
            string s = raw.Trim();
            if (s.Length >= 2 && s[0] == '"' && s[s.Length - 1] == '"')
            {
                s = s.Substring(1, s.Length - 2);
                s = s.Replace("\\\"", "\"").Replace("\\\\", "\\").Replace("\\n", "\n").Replace("\\r", "\r").Replace("\\/", "/");
            }
            return s;
        }
    }
}
