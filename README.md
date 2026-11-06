# Gentleman Gallery

绅士会所（hentaiclub.net）图集批量下载器 + 反向搜图 + 视频解析下载。

Windows 桌面应用，本体是 WinForms + WebView2 壳，业务逻辑是手写 HTTP 服务（监听 `127.0.0.1:7799`）。

---

## 三个引擎版本

这个仓库保留了同一套业务逻辑的三代实现，从 Node 一路瘦到 C#：

| 版本 | 目录 | 体积 | 依赖 | 说明 |
|---|---|---|---|---|
| **Node SEA** | `legacy-node/` | 87 MB | node 内置 | 最早版本，`sea-main.cjs` 单文件打包成 exe |
| **C++ / cpp-httplib** | `engine-cpp/` | 4 MB | MinGW 运行库 | 中间尝试，`page_html.h` + `gallery-engine-new.exe` |
| **C# / 手写 TcpListener** | `engine-cs/` | 273 KB | .NET 4.0 | **当前版本**，零外部依赖 |

引擎缩小 **99.7%**，Node 依赖归零。

---

## C# 引擎（当前版本）

无框架无依赖，只用 `System.Net.Sockets.TcpListener` 手写 HTTP/1.1 解析。

### 编译

```bat
csc -target:exe -platform:x64 -optimize+ ^
    -out:gallery-engine.exe -win32icon:app.ico ^
    -r:System.Net.Http.dll ^
    -r:Microsoft.Web.WebView2.Core.dll ^
    -r:Microsoft.Web.WebView2.WinForms.dll ^
    -r:System.Windows.Forms.dll ^
    -r:System.Drawing.dll ^
    Engine.cs Worker.cs LensEngine.cs XBrowser.cs Pages.cs
```

用 `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`（C# 5 语法，不支持表达式体属性 / 元组 / 字符串插值）。

### 文件

| 文件 | 作用 |
|---|---|
| `Engine.cs` | HTTP 服务 + 路由 + `/api/*` 接口 |
| `Worker.cs` | 图集爬虫（curl 下载、断点续传、智能分类） |
| `LensEngine.cs` | Google Lens 反向搜图（WebView2 驱动） |
| `XBrowser.cs` | X/Twitter 推文抓取（WebView2 登录态） |
| `Pages.cs` | 内嵌前端页面（C# verbatim string） |

---

## 功能

### 1. 图集下载

- 抓 `hentaiclub.net` 的 coser 图集，自动按 `<coser>/<分类>/<专辑>/` 分目录
- **实时搜索**：输入任意 coser 名 → 直接搜站点（不依赖本地缓存）
- 搜不到 → 明确报错，**不会偷偷换人**
- 断点续传（文件已存在跳过）、3 次重试、每日配额 / 单轮时长限制
- 关软件自动停止下载

### 2. 鱼鱼找鸡（Google Lens 反查）

- 喂一张图 → 走 Google Lens → 提取 coser 的 X / Instagram 账号
- WebView2 驱动，自动处理上传 + 结果页解析
- 从卡片标题提取 `@handle` / `Name on X` 模式，按出现频次排序

### 3. 视频解析下载

走 [yt-dlp](https://github.com/yt-dlp/yt-dlp)，支持 1000+ 站点：

- 视频：YouTube、哔哩哔哩、Vimeo、优酷、爱奇艺、AcFun、Dailymotion
- 社交：X、TikTok、Instagram、小红书、微博、抖音、Facebook
- 音乐：SoundCloud、Bandcamp、QQ音乐、网易云、喜马拉雅
- 直播：Twitch、斗鱼、虎牙

下完可预览（图片 `<img>` / 视频 `<video controls>`）+ 「打开位置」定位文件。

---

## 前端

`pages/sea-main.cjs` 里的 HTML 就是完整界面（单文件，无构建）。

主题系统：14 套配色（原神角色 / 动漫），全透明玻璃卡片，左侧栏切换。

壁纸 + 开场视频在 `app/bg/`。

---

## 已知限制

- **NSFW 推文**：fxtwitter 等第三方 API 一律 404，需要 WebView2 带登录态抓（`XBrowser.cs` 已实现抓取，图片下载走 curl 受 Referer 限制）
- **.NET 4.0 TLS**：`HttpClient` 不支持 TLS 1.2，所有下载走 `curl.exe` 子进程
- **ffmpeg 精简**：自编译需要完整 MinGW 工具链（MSYS2 pacman 在本机装不全），暂用 170 MB 官方版

---

## 目录约定

```
Gentleman Gallery/
├── Gentleman Gallery.exe      # 启动器（设 GALLERY_SERVE=1 + 起引擎 + 开 WebView2）
├── app/
│   ├── gallery-engine.exe     # 引擎
│   ├── ffmpeg.exe
│   ├── yt-dlp.exe
│   ├── bg/                    # 壁纸 + 开场视频
│   └── WebView2Profile/       # 登录态（X / Google）
├── data/
│   ├── gui_status.json        # 运行状态
│   ├── worker.log             # 下载日志
│   ├── coser_groups.json      # coser 列表缓存
│   └── manual_config.json     # 配额 / 时长 / 图库路径
└── cosplay/                   # 图库（不是代码，别提交）
```

---

## License

MIT
