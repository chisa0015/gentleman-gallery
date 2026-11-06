using System;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace GalleryEngine
{
    // X 登录窗 + 推文页抓取（共享 WebView2Profile，登录一次永久生效）
    static class XBrowser
    {
        public static string ProfileDir()
        {
            string p = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "WebView2Profile");
            try { Directory.CreateDirectory(p); } catch { }
            return p;
        }

        static CoreWebView2EnvironmentOptions MakeOpts()
        {
            return new CoreWebView2EnvironmentOptions("--disable-features=msSmartScreenProtection");
        }

        // ---------- 登录窗（可见，用户手动登录） ----------
        public static void OpenLogin()
        {
            Thread t = new Thread(delegate ()
            {
                try
                {
                    var f = new Form();
                    f.Text = "登录 X（登录后关掉这个窗口即可）";
                    f.Width = 1000;
                    f.Height = 760;
                    f.StartPosition = FormStartPosition.CenterScreen;
                    f.BackColor = Color.FromArgb(23, 20, 31);
                    f.ForeColor = Color.FromArgb(242, 238, 248);

                    var wv = new WebView2();
                    wv.Dock = DockStyle.Fill;
                    f.Controls.Add(wv);

                    f.Load += async delegate (object s, EventArgs e)
                    {
                        try
                        {
                            var env = await CoreWebView2Environment.CreateAsync(null, ProfileDir(), MakeOpts());
                            await wv.EnsureCoreWebView2Async(env);
                            wv.CoreWebView2.Navigate("https://x.com/i/flow/login");
                        }
                        catch (Exception ex)
                        {
                            MessageBox.Show("WebView2 启动失败：" + ex.Message);
                            try { f.Close(); } catch { }
                        }
                    };

                    Application.Run(f);
                }
                catch (Exception) { }
            });
            t.SetApartmentState(ApartmentState.STA);
            t.IsBackground = true;
            t.Start();
        }

        // ---------- 检查登录态 ----------
        public static string CheckLogin()
        {
            string result = "{\"loggedIn\":false}";
            var done = new ManualResetEventSlim(false);
            try
            {
                Thread t = new Thread(delegate ()
                {
                    Form f = null;
                    WebView2 wv = null;
                    try
                    {
                        f = new Form();
                        f.Opacity = 0;
                        f.ShowInTaskbar = false;
                        f.Size = new Size(800, 600);
                        f.StartPosition = FormStartPosition.Manual;
                        f.Location = new Point(-5000, -5000);
                        wv = new WebView2();
                        wv.Dock = DockStyle.Fill;
                        f.Controls.Add(wv);

                        f.Load += async delegate (object s, EventArgs e)
                        {
                            try
                            {
                                var env = await CoreWebView2Environment.CreateAsync(null, ProfileDir(), MakeOpts());
                                await wv.EnsureCoreWebView2Async(env);
                                var cm = wv.CoreWebView2.CookieManager;
                                var cookies = await cm.GetCookiesAsync("https://x.com");
                                bool hasAt = false, hasCt0 = false;
                                foreach (var c in cookies)
                                {
                                    if (c.Name == "auth_token" && !string.IsNullOrEmpty(c.Value)) hasAt = true;
                                    if (c.Name == "ct0" && !string.IsNullOrEmpty(c.Value)) hasCt0 = true;
                                }
                                result = "{\"loggedIn\":" + ((hasAt && hasCt0) ? "true" : "false") + ",\"hasAuthToken\":" + (hasAt ? "true" : "false") + ",\"hasCt0\":" + (hasCt0 ? "true" : "false") + "}";
                            }
                            catch (Exception ex)
                            {
                                result = "{\"loggedIn\":false,\"error\":\"" + ex.Message.Replace("\"", "\\\"") + "\"}";
                            }
                            finally { try { f.Close(); } catch { } }
                        };
                        Application.Run(f);
                    }
                    catch (Exception ex)
                    {
                        result = "{\"loggedIn\":false,\"error\":\"" + ex.Message.Replace("\"", "\\\"") + "\"}";
                    }
                    finally
                    {
                        try { if (wv != null) wv.Dispose(); } catch { }
                        try { if (f != null && !f.IsDisposed) f.Dispose(); } catch { }
                        done.Set();
                    }
                });
                t.SetApartmentState(ApartmentState.STA);
                t.IsBackground = true;
                t.Start();
                done.Wait(40000);
            }
            catch { }
            return result;
        }

        // ---------- 抓推文页（隐藏窗口 + 读 meta） ----------
        public static string FetchTweet(string tweetUrl, int timeoutMs)
        {
            string result = null;
            var done = new ManualResetEventSlim(false);
            try
            {
                Thread t = new Thread(delegate ()
                {
                    Form f = null;
                    WebView2 wv = null;
                    try
                    {
                        f = new Form();
                        f.Opacity = 0;
                        f.ShowInTaskbar = false;
                        f.Size = new Size(1280, 900);
                        f.StartPosition = FormStartPosition.Manual;
                        f.Location = new Point(-6000, -6000);
                        wv = new WebView2();
                        wv.Dock = DockStyle.Fill;
                        f.Controls.Add(wv);

                        f.Load += async delegate (object s, EventArgs e)
                        {
                            try
                            {
                                var env = await CoreWebView2Environment.CreateAsync(null, ProfileDir(), MakeOpts());
                                await wv.EnsureCoreWebView2Async(env);
                                var core = wv.CoreWebView2;

                                var nav = new ManualResetEventSlim(false);
                                EventHandler<CoreWebView2NavigationCompletedEventArgs> h =
                                    delegate (object a, CoreWebView2NavigationCompletedEventArgs b) { nav.Set(); };
                                core.NavigationCompleted += h;

                                nav.Reset();
                                core.Navigate(tweetUrl);
                                nav.Wait(35000);
                                await System.Threading.Tasks.Task.Delay(2500);

                                string js = @"(function(){
  var out={url:location.href,images:[],videos:[],text:''};
  var metas=document.querySelectorAll('meta');
  for(var i=0;i<metas.length;i++){
    var p=metas[i].getAttribute('property')||metas[i].getAttribute('name')||'';
    var c=metas[i].getAttribute('content')||'';
    if(!c)continue;
    if(p==='og:image'||p==='twitter:image'){ if(c.indexOf('pbs.twimg.com')>=0){ c=c.replace(/name=[a-z0-9]+/,'name=orig'); out.images.push(c); } }
    if(p==='og:video'||p==='og:video:url'||p==='twitter:player:stream'){ if(c) out.videos.push(c); }
    if(p==='og:description'){ out.text=c.slice(0,300); }
  }
  var imgs=document.querySelectorAll('img[src*=""pbs.twimg.com/media""]');
  for(var j=0;j<imgs.length;j++){
    var u=imgs[j].src.replace(/[?&]name=[a-z0-9]+/,'').replace(/\/[a-z0-9]+(\.(jpg|png|webp))?$/,''); u=u+(u.indexOf('?')>=0?'&name=orig':'?name=orig');
    if(out.images.indexOf(u)<0) out.images.push(u);
  }
  var vids=document.querySelectorAll('video');
  for(var k=0;k<vids.length;k++){
    if(vids[k].src) out.videos.push(vids[k].src);
    var srcs=vids[k].querySelectorAll('source');
    for(var m=0;m<srcs.length;m++){ if(srcs[m].src) out.videos.push(srcs[m].src); }
  }
  out.loggedIn = !!(document.querySelector('[data-testid=""SideNav_AccountSwitcher_Button""]'));
  out.sensitive = /sensitive|age-restricted|敏感/i.test(document.body.innerText.slice(0,3000));
  return JSON.stringify(out);
})()";

                                string raw = await core.ExecuteScriptAsync(js);
                                string un = raw;
                                if (!string.IsNullOrEmpty(un) && un.Length >= 2 && un[0] == '"' && un[un.Length - 1] == '"')
                                {
                                    un = un.Substring(1, un.Length - 2);
                                    un = un.Replace("\\\"", "\"").Replace("\\\\", "\\").Replace("\\n", "\n").Replace("\\/", "/");
                                }
                                result = un;
                                try { core.NavigationCompleted -= h; } catch { }
                            }
                            catch (Exception ex)
                            {
                                result = "{\"error\":\"" + ex.Message.Replace("\"", "\\\"") + "\"}";
                            }
                            finally { try { f.Close(); } catch { } }
                        };
                        Application.Run(f);
                    }
                    catch (Exception ex)
                    {
                        result = "{\"error\":\"" + ex.Message.Replace("\"", "\\\"") + "\"}";
                    }
                    finally
                    {
                        try { if (wv != null) wv.Dispose(); } catch { }
                        try { if (f != null && !f.IsDisposed) f.Dispose(); } catch { }
                        done.Set();
                    }
                });
                t.SetApartmentState(ApartmentState.STA);
                t.IsBackground = true;
                t.Start();
                done.Wait(timeoutMs);
            }
            catch { }
            return result;
        }
    }
}
