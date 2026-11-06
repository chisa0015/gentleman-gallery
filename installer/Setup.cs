using System;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Windows.Forms;

static class Installer
{
    const string APP_NAME = "Gentleman Gallery";
    const string PAYLOAD = "payload.zip";

    [STAThread]
    static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        string baseDir = AppDomain.CurrentDomain.BaseDirectory;
        string zipPath = Path.Combine(baseDir, PAYLOAD);

        // 如果内嵌了 payload，先释放出来
        if (!File.Exists(zipPath))
        {
            string embedded = TryExtractEmbedded(baseDir);
            if (embedded != null) zipPath = embedded;
        }

        if (!File.Exists(zipPath))
        {
            MessageBox.Show("找不到安装数据（payload.zip）。\n请把安装包和 payload.zip 放在一起再运行。",
                APP_NAME + " 安装", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        string defaultDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "GentlemanGallery");

        using (var dlg = new InstallForm(defaultDir))
        {
            if (dlg.ShowDialog() != DialogResult.OK) return;
            string target = dlg.InstallDir;

            try
            {
                if (Directory.Exists(target))
                {
                    if (MessageBox.Show("目录已存在，覆盖安装？\n" + target, APP_NAME,
                        MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
                }
                Directory.CreateDirectory(target);

                using (var fs = File.OpenRead(zipPath))
                using (var za = new ZipArchive(fs, ZipArchiveMode.Read))
                {
                    foreach (var e in za.Entries)
                    {
                        if (string.IsNullOrEmpty(e.Name)) continue;
                        string dest = Path.Combine(target, e.FullName.Replace('/', '\\'));
                        Directory.CreateDirectory(Path.GetDirectoryName(dest));
                        e.ExtractToFile(dest, true);
                    }
                }

                // 处理子目录：zip 里可能是 GentlemanGallery/ 前缀
                string inner = Path.Combine(target, "GentlemanGallery");
                string exe = Path.Combine(target, "Gentleman Gallery.exe");
                if (!File.Exists(exe) && File.Exists(Path.Combine(inner, "Gentleman Gallery.exe")))
                {
                    foreach (var f in Directory.GetFiles(inner))
                        File.Copy(f, Path.Combine(target, Path.GetFileName(f)), true);
                    foreach (var d in Directory.GetDirectories(inner))
                    {
                        string nd = Path.Combine(target, Path.GetFileName(d));
                        if (!Directory.Exists(nd)) Directory.Move(d, nd);
                    }
                    try { Directory.Delete(inner, true); } catch (Exception) { }
                    exe = Path.Combine(target, "Gentleman Gallery.exe");
                }

                CreateShortcut(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), exe, target);
                CreateShortcut(Environment.GetFolderPath(Environment.SpecialFolder.Programs), exe, target);

                if (MessageBox.Show("安装完成！\n\n" + target + "\n\n现在启动？", APP_NAME,
                    MessageBoxButtons.YesNo, MessageBoxIcon.Information) == DialogResult.Yes)
                {
                    try { System.Diagnostics.Process.Start(exe); } catch (Exception ex) { MessageBox.Show(ex.Message); }
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show("安装失败：" + ex.Message, APP_NAME, MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }
    }

    static string TryExtractEmbedded(string baseDir)
    {
        try
        {
            var asm = Assembly.GetExecutingAssembly();
            using (var st = asm.GetManifestResourceStream("payload.zip"))
            {
                if (st == null) return null;
                string p = Path.Combine(Path.GetTempPath(), "gg_payload_" + DateTime.Now.Ticks + ".zip");
                using (var fs = File.Create(p)) st.CopyTo(fs);
                return p;
            }
        }
        catch (Exception) { return null; }
    }

    static void CreateShortcut(string folder, string exe, string workdir)
    {
        try
        {
            if (!Directory.Exists(folder)) return;
            string lnk = Path.Combine(folder, APP_NAME + ".lnk");
            Type t = Type.GetTypeFromProgID("WScript.Shell");
            dynamic sh = Activator.CreateInstance(t);
            dynamic sc = sh.CreateShortcut(lnk);
            sc.TargetPath = exe;
            sc.WorkingDirectory = workdir;
            sc.IconLocation = Path.Combine(workdir, "app\\app.ico") + ",0";
            sc.Description = APP_NAME;
            sc.Save();
        }
        catch (Exception) { }
    }
}

class InstallForm : Form
{
    public string InstallDir { get; private set; }
    TextBox txt;

    public InstallForm(string defaultDir)
    {
        Text = "Gentleman Gallery 安装";
        Width = 560;
        Height = 260;
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        BackColor = Color.FromArgb(23, 20, 31);
        ForeColor = Color.FromArgb(242, 238, 248);

        var lbl = new Label();
        lbl.Text = "选择安装位置";
        lbl.ForeColor = Color.FromArgb(184, 168, 216);
        lbl.Font = new Font("Microsoft YaHei UI", 11f, FontStyle.Bold);
        lbl.SetBounds(24, 22, 400, 26);
        Controls.Add(lbl);

        var sub = new Label();
        sub.Text = "程序会解压到这里，并创建桌面快捷方式";
        sub.ForeColor = Color.FromArgb(150, 143, 170);
        sub.Font = new Font("Microsoft YaHei UI", 9f);
        sub.SetBounds(24, 50, 460, 22);
        Controls.Add(sub);

        txt = new TextBox();
        txt.Text = defaultDir;
        txt.SetBounds(24, 86, 400, 28);
        txt.BackColor = Color.FromArgb(34, 29, 46);
        txt.ForeColor = Color.FromArgb(242, 238, 248);
        txt.BorderStyle = BorderStyle.FixedSingle;
        Controls.Add(txt);

        var btn = new Button();
        btn.Text = "浏览...";
        btn.SetBounds(432, 86, 90, 28);
        btn.FlatStyle = FlatStyle.Flat;
        btn.BackColor = Color.FromArgb(34, 29, 46);
        btn.ForeColor = Color.FromArgb(242, 238, 248);
        btn.Click += (s, e) =>
        {
            using (var d = new FolderBrowserDialog())
            {
                d.SelectedPath = txt.Text;
                if (d.ShowDialog() == DialogResult.OK) txt.Text = d.SelectedPath;
            }
        };
        Controls.Add(btn);

        var ok = new Button();
        ok.Text = "开始安装";
        ok.SetBounds(280, 150, 130, 36);
        ok.FlatStyle = FlatStyle.Flat;
        ok.BackColor = Color.FromArgb(184, 168, 216);
        ok.ForeColor = Color.FromArgb(23, 20, 31);
        ok.Font = new Font("Microsoft YaHei UI", 10f, FontStyle.Bold);
        ok.Click += (s, e) =>
        {
            if (string.IsNullOrWhiteSpace(txt.Text)) { MessageBox.Show("请输入安装目录"); return; }
            InstallDir = txt.Text.Trim();
            DialogResult = DialogResult.OK;
        };
        Controls.Add(ok);

        var cancel = new Button();
        cancel.Text = "取消";
        cancel.SetBounds(420, 150, 90, 36);
        cancel.FlatStyle = FlatStyle.Flat;
        cancel.BackColor = Color.FromArgb(34, 29, 46);
        cancel.ForeColor = Color.FromArgb(242, 238, 248);
        cancel.Click += (s, e) => DialogResult = DialogResult.Cancel;
        Controls.Add(cancel);
    }
}
