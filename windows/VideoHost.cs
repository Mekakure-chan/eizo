using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

internal sealed class VideoHost
{
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    private static readonly CultureInfo Invariant = CultureInfo.InvariantCulture;
    private readonly Stream input = Console.OpenStandardInput(), output = Console.OpenStandardOutput();
    private readonly object outputLock = new object();
    private readonly CancellationTokenSource cancellation = new CancellationTokenSource();
    private readonly AutoResetEvent ack = new AutoResetEvent(false);
    private readonly string bin = AppDomain.CurrentDomain.BaseDirectory;
    private readonly string tempRoot = Path.Combine(Path.GetTempPath(), "EmbeddedVideoSaver-Jobs-v1");

    private sealed class UserError : Exception { public UserError(string text) : base(text) {} }

    private static int Main()
    {
        var host = new VideoHost();
        try { host.Serve(); return 0; }
        catch (OperationCanceledException) { return 0; }
        catch (Exception e)
        {
            try { host.Send(new { type = "error", text = e is UserError ? e.Message : "PC側で保存を完了できませんでした。空き容量とセットアップを確認してください。" }); }
            catch (IOException) {}
            return 1;
        }
    }

    private static string Field(Dictionary<string, object> map, string key)
    {
        object value;
        return map != null && map.TryGetValue(key, out value) ? Convert.ToString(value, Invariant) : "";
    }

    private Dictionary<string, object> Read()
    {
        var header = new byte[4];
        if (input.Read(header, 0, 1) == 0) return null;
        Fill(header, 1);
        int length = BitConverter.ToInt32(header, 0);
        if (length <= 0 || length > 4096) throw new InvalidDataException();
        var data = new byte[length];
        Fill(data, 0);
        return new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(Utf8.GetString(data));
    }

    private void Fill(byte[] bytes, int offset)
    {
        while (offset < bytes.Length)
        {
            int size = input.Read(bytes, offset, bytes.Length - offset);
            if (size == 0) throw new EndOfStreamException();
            offset += size;
        }
    }

    private void Send(object message)
    {
        lock (outputLock)
        {
            var data = Utf8.GetBytes(new JavaScriptSerializer().Serialize(message));
            var prefix = BitConverter.GetBytes(data.Length);
            output.Write(prefix, 0, prefix.Length);
            output.Write(data, 0, data.Length);
            output.Flush();
        }
    }

    private void ReadControls()
    {
        try
        {
            for (;;)
            {
                var message = Read();
                if (Field(message, "op") != "ack") break; // cancel or closed port
                ack.Set();
            }
        }
        catch (Exception) { /* A broken native pipe also cancels the job. */ }
        cancellation.Cancel();
    }

    private void Serve()
    {
        var request = Read();
        if (request == null) return;
        if (!new[] { "yt-dlp.exe", "ffmpeg.exe", "ffprobe.exe" }.All(name => File.Exists(Path.Combine(bin, name))))
            throw new UserError("保存ツールのファイルが不足しています。Windows-Setup.cmd を再実行してください。");
        if (Field(request, "op") == "info") { Send(new { type = "ready", protocol = 1 }); return; }
        if (Field(request, "op") != "download") throw new UserError("受け付けられない操作です。");
        string url = PublicVideoUrl(Field(request, "provider"), Field(request, "id"));
        new Thread(ReadControls) { IsBackground = true }.Start();
        Directory.CreateDirectory(tempRoot);
        if ((File.GetAttributes(tempRoot) & FileAttributes.ReparsePoint) != 0)
            throw new UserError("一時保存先を安全に開けませんでした。Windowsの一時フォルダーを確認してください。");
        CleanAbandonedJobs();
        string folder = Path.Combine(tempRoot, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(folder);
        double duration;
        try
        {
            using (File.Open(Path.Combine(folder, ".job"), FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None))
            {
                duration = Acquire(folder, url);
                StreamFile(Path.Combine(folder, "media.mp4"));
            }
        }
        finally { Clean(folder); }
        Send(new { type = "end", duration = duration });
    }

    private static string PublicVideoUrl(string provider, string id)
    {
        switch (provider)
        {
            case "youtube":
                if (Regex.IsMatch(id, @"\A[A-Za-z0-9_-]{11}\z")) return "https://www.youtube.com/watch?v=" + id;
                break;
            case "niconico":
                if (Regex.IsMatch(id, @"\A(?:(?:sm|so|nm)[1-9][0-9]{0,12}|[1-9][0-9]{5,12})\z")) return "https://www.nicovideo.jp/watch/" + id;
                break;
            case "dailymotion":
                if (Regex.IsMatch(id, @"\Ax[a-z0-9]{3,14}\z")) return "https://www.dailymotion.com/video/" + id;
                break;
            case "vimeo":
                if (Regex.IsMatch(id, @"\A[1-9][0-9]{0,11}\z")) return "https://vimeo.com/" + id;
                break;
        }
        throw new UserError("対応する動画ページを開いて、保存する動画を選び直してください。");
    }

    private static string QuoteArg(string value)
    {
        // CommandLineToArgvW quoting. ProcessStartInfo on .NET Framework takes one command line.
        return "\"" + Regex.Replace(value, "(\\\\*)(\"|$)", m =>
            new string('\\', m.Groups[1].Length * 2) + (m.Groups[2].Value == "\"" ? "\\\"" : "")) + "\"";
    }

    private int RunTool(string exe, string folder, string[] args, Action<string> readOut, Action<string> readError)
    {
        cancellation.Token.ThrowIfCancellationRequested();
        var start = new ProcessStartInfo {
            FileName = Path.Combine(bin, exe), WorkingDirectory = folder,
            Arguments = string.Join(" ", args.Select(QuoteArg)), UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
        };
        using (var job = new ChildProcessJob())
        using (var process = new Process { StartInfo = start })
        {
            process.OutputDataReceived += (s, ev) => { if (ev.Data != null) readOut(ev.Data); };
            process.ErrorDataReceived += (s, ev) => { if (ev.Data != null) readError(ev.Data); };
            process.Start();
            job.Attach(process);
            process.StandardInput.Close();
            using (cancellation.Token.Register(job.Stop))
            {
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                process.WaitForExit();
                cancellation.Token.ThrowIfCancellationRequested();
                return process.ExitCode;
            }
        }
    }

    private double Acquire(string folder, string url)
    {
        double expected = 0;
        bool expectsAudio = false;
        string failure = "配信元から全編を取得できませんでした。公開状態と通信状況を確認してください。";
        var args = new[] {
            "--ignore-config", "--no-plugin-dirs", "--no-cache-dir", "--no-js-runtimes", "--no-remote-components",
            "--compat-options", "no-certifi", "--xff", "never", "--no-playlist", "--playlist-items", "1",
            "--abort-on-error", "--abort-on-unavailable-fragments", "--socket-timeout", "25", "--retries", "3", "--fragment-retries", "3",
            "--match-filters", "!is_live & live_status!=?is_upcoming & live_status!=?post_live",
            "--format", "bv[ext=mp4][vcodec^=avc1]+ba[ext=m4a]/b[ext=mp4][vcodec^=avc1]/bv[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv+ba/b/bv",
            "--ffmpeg-location", Path.Combine(bin,"ffmpeg.exe"), "--merge-output-format", "mp4", "--remux-video", "mp4",
            "--no-simulate", "--newline", "--progress", "--progress-delta", "0.8", "--color", "never", "--encoding", "utf-8",
            "--progress-template", "download:progress|%(progress._percent_str)s",
            "--print", "before_dl:meta|%(duration)s|%(acodec)s", "--output", "media.%(ext)s", "--", url
        };
        Send(new { type = "progress", stage = "download" });
        int exit = RunTool("yt-dlp.exe", folder, args, line => {
            if (line.StartsWith("meta|", StringComparison.Ordinal)) {
                string[] fields = line.Split('|');
                if (fields.Length == 3) {
                    double.TryParse(fields[1], NumberStyles.Float, Invariant, out expected);
                    expectsAudio = fields[2] != "none" && fields[2] != "NA";
                }
            } else if (line.StartsWith("progress|", StringComparison.Ordinal)) {
                double percent;
                if (double.TryParse(line.Substring(9).Trim().TrimEnd('%'), NumberStyles.Float, Invariant, out percent)) {
                    try { Send(new { type = "progress", stage = "download", percent = percent }); }
                    catch (IOException) { cancellation.Cancel(); }
                }
            }
        }, line => {
            if (Regex.IsMatch(line, "private|login|log in|sign in|403|401|not available|unavailable|protected|DRM", RegexOptions.IgnoreCase))
                failure = "配信元がこの動画の取得を許可していません。ログイン・地域・DRMなどの制限がある動画は保存できません。";
            else if (line.IndexOf("certificate", StringComparison.OrdinalIgnoreCase) >= 0)
                failure = "配信元の証明書を確認できません。Windowsの時刻とネットワークを確認してください。";
        });
        if (exit != 0) throw new UserError(failure);
        if (!File.Exists(Path.Combine(folder, "media.mp4"))) throw new UserError("保存できる終了済みの動画がありません。ライブ配信中の動画は終了後に選んでください。");
        Send(new { type = "progress", stage = "verify" });
        return CheckMedia(folder, expected, expectsAudio);
    }

    private double CheckMedia(string folder, double expected, bool expectsAudio)
    {
        var json = new StringBuilder();
        int code = RunTool("ffprobe.exe", folder, new[] { "-v","error","-show_entries","format=duration:stream=codec_type",
            "-of","json","media.mp4" }, s => json.AppendLine(s), s => {});
        if (code != 0) throw new UserError("保存したMP4を読み取れませんでした。");
        var result = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(json.ToString());
        object streams, format;
        if (!result.TryGetValue("streams", out streams) || !result.TryGetValue("format", out format))
            throw new UserError("保存したMP4の映像情報を読み取れませんでした。");
        var types = ((System.Collections.IEnumerable)streams).Cast<Dictionary<string, object>>().Select(s => Field(s, "codec_type")).ToArray();
        if (!types.Contains("video") || (expectsAudio && !types.Contains("audio"))) throw new UserError("必要な映像または音声トラックを取得できませんでした。");
        double actual;
        if (!double.TryParse(Field((Dictionary<string, object>)format, "duration"), NumberStyles.Float, Invariant, out actual) ||
            double.IsNaN(actual) || double.IsInfinity(actual) || actual <= 0 || actual < expected - Math.Max(2, Math.Min(10, expected * 0.01)))
            throw new UserError("MP4の長さが全編の長さに足りないため、保存を中止しました。");
        return actual;
    }

    private void StreamFile(string path)
    {
        var buffer = new byte[384 * 1024];
        var wait = new WaitHandle[] { cancellation.Token.WaitHandle, ack };
        using (var file = File.OpenRead(path))
        {
            Send(new { type = "file", bytes = file.Length });
            int size;
            while ((size = file.Read(buffer, 0, buffer.Length)) > 0)
            {
                cancellation.Token.ThrowIfCancellationRequested();
                Send(new { type = "data", b64 = Convert.ToBase64String(buffer, 0, size) });
                if (WaitHandle.WaitAny(wait) == 0) cancellation.Token.ThrowIfCancellationRequested();
            }
        }
    }

    private void CleanAbandonedJobs()
    {
        foreach (string dir in Directory.GetDirectories(tempRoot))
        {
            try {
                if (!Regex.IsMatch(Path.GetFileName(dir), @"\A[a-f0-9]{32}\z") || (File.GetAttributes(dir) & FileAttributes.ReparsePoint) != 0) continue;
                using (File.Open(Path.Combine(dir, ".job"), FileMode.Open, FileAccess.ReadWrite, FileShare.None)) {}
                Clean(dir);
            } catch (IOException) {} catch (UnauthorizedAccessException) {}
        }
    }

    private static void Clean(string dir)
    {
        // Each job owns a flat directory. Never follow subdirectories or junctions.
        try {
            if ((File.GetAttributes(dir) & FileAttributes.ReparsePoint) != 0) return;
            var files = Directory.GetFiles(dir);
            if (files.Any(file => Path.GetFileName(file) != ".job" && !Path.GetFileName(file).StartsWith("media.", StringComparison.Ordinal))) return;
            foreach (string file in files) File.Delete(file);
            Directory.Delete(dir, false);
        } catch (IOException) {} catch (UnauthorizedAccessException) {}
    }
}
