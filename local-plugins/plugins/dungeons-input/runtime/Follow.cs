using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;

public sealed class Marker {
    public double x, y, score; public int width, height;
}
public sealed class FollowFrame {
    public long capturedAt; public int width, height, clientWidth, clientHeight;
    public Marker p1, p2; public string error, png;
    public bool Valid { get { return error == null && p1 != null && p2 != null; } }
}

// Only the coloured P1/P2 glyphs are recognized, not terrain, health or combat.
public static class MarkerVision {
    sealed class Blob { public int left, top, right, bottom, count; }
    static readonly string[] Letter = { "11111", "11011", "11011", "11111", "11000", "11000", "11000" };
    static readonly string[] One = { "011", "111", "011", "011", "011", "011", "011" };
    static readonly string[] Two = { "11111", "00011", "00011", "11111", "11000", "11000", "11111" };
    static bool Colour(byte r, byte g, byte b, bool cyan) {
        return cyan ? g >= 180 && b >= 145 && r <= 145 && g - r >= 60 : r >= 220 && g >= 145 && g <= 225 && b <= 115 && r - b >= 110;
    }
    static double Score(bool[] mask, int width, Blob b, string[] glyph) {
        int good = 0, total = 0;
        for (int y = 0; y < glyph.Length; y++) for (int x = 0; x < glyph[y].Length; x++) {
            int px = b.left + (int)((x + .5) * (b.right - b.left + 1) / glyph[y].Length);
            int py = b.top + (int)((y + .5) * (b.bottom - b.top + 1) / glyph.Length);
            if (mask[py * width + px] == (glyph[y][x] == '1')) good++; total++;
        }
        return (double)good / total;
    }
    static List<Marker> Find(byte[] pixels, int width, int height, bool cyan) {
        bool[] mask = new bool[width * height], visited = new bool[width * height];
        // Exclude player names at the top and inventory/HUD at the bottom.
        int top = (int)(height * .18), bottom = (int)(height * .84);
        for (int y = top; y < bottom; y++) for (int x = 0; x < width; x++) {
            int i = (y * width + x) * 4; mask[y * width + x] = Colour(pixels[i + 2], pixels[i + 1], pixels[i], cyan);
        }
        List<Blob> blobs = new List<Blob>(); Queue<int> queue = new Queue<int>();
        for (int y = top; y < bottom; y++) for (int x = 0; x < width; x++) {
            int first = y * width + x; if (!mask[first] || visited[first]) continue;
            Blob blob = new Blob { left = x, right = x, top = y, bottom = y }; queue.Enqueue(first); visited[first] = true;
            while (queue.Count != 0) {
                int index = queue.Dequeue(), px = index % width, py = index / width;
                blob.left = Math.Min(blob.left, px); blob.right = Math.Max(blob.right, px); blob.top = Math.Min(blob.top, py); blob.bottom = Math.Max(blob.bottom, py); blob.count++;
                for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) {
                    int nx = px + dx, ny = py + dy; if (nx < 0 || nx >= width || ny < top || ny >= bottom) continue;
                    int next = ny * width + nx; if (!mask[next] || visited[next]) continue;
                    visited[next] = true; queue.Enqueue(next);
                }
            }
            int h = blob.bottom - blob.top + 1, w = blob.right - blob.left + 1;
            if (h >= 7 && h <= height * .05 && w >= 3 && w <= h && blob.count >= 12) blobs.Add(blob);
        }
        List<Marker> found = new List<Marker>();
        foreach (Blob p in blobs) {
            int h = p.bottom - p.top + 1, w = p.right - p.left + 1;
            if ((double)w / h < .5 || Score(mask, width, p, Letter) < .91) continue;
            foreach (Blob n in blobs) {
                int nh = n.bottom - n.top + 1;
                if (n.left <= p.right || n.left - p.right > h * .5 || Math.Abs(n.top - p.top) > h * .15 || Math.Abs(nh - h) > h * .2) continue;
                double score = Math.Min(Score(mask, width, p, Letter), Score(mask, width, n, cyan ? Two : One));
                if (score < .9) continue;
                found.Add(new Marker { x = (p.left + n.right) / 2.0, y = (p.top + p.bottom) / 2.0, width = n.right - p.left + 1, height = h, score = score });
            }
        }
        return found;
    }
    public static FollowFrame Detect(Bitmap image, long now, bool preview) {
        FollowFrame frame = new FollowFrame { capturedAt = now, width = image.Width, height = image.Height };
        Rectangle rect = new Rectangle(0, 0, image.Width, image.Height);
        BitmapData data = image.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        byte[] pixels = new byte[image.Width * image.Height * 4];
        try { for (int y = 0; y < image.Height; y++) Marshal.Copy(IntPtr.Add(data.Scan0, y * data.Stride), pixels, y * image.Width * 4, image.Width * 4); }
        finally { image.UnlockBits(data); }
        List<Marker> first = Find(pixels, image.Width, image.Height, false), second = Find(pixels, image.Width, image.Height, true);
        if (first.Count == 1) frame.p1 = first[0]; if (second.Count == 1) frame.p2 = second[0];
        if (first.Count != 1 || second.Count != 1) frame.error = "需要唯一的橙色 P1 和青色 P2 标记；当前候选：" + first.Count + " / " + second.Count;
        if (preview) using (MemoryStream stream = new MemoryStream()) { image.Save(stream, ImageFormat.Png); frame.png = Convert.ToBase64String(stream.ToArray()); }
        return frame;
    }
}

public static class GameCapture {
    static bool dpiConfigured;
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int left, top, right, bottom; }
    [StructLayout(LayoutKind.Sequential)] struct Point { public int x, y; }
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window, ref Point point);
    public static FollowFrame Read(long now, bool preview) {
        try {
            if (!dpiConfigured) {
                // Per-monitor V2 keeps client coordinates and captured pixels in the same units.
                if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) throw new InvalidOperationException("无法设置截图进程 DPI 感知：" + Marshal.GetLastWin32Error());
                dpiConfigured = true;
            }
            IntPtr window = GetForegroundWindow(); ForegroundInfo before = GameWindow.Inspect();
            if (!before.matched) throw new InvalidOperationException(before.RejectionReason);
            Rect rect; Point origin = new Point();
            if (!GetClientRect(window, out rect) || !ClientToScreen(window, ref origin)) throw new InvalidOperationException("无法读取游戏客户区");
            int width = rect.right - rect.left, height = rect.bottom - rect.top;
            if (width < 640 || height < 360 || width > 7680 || height > 4320 || (double)width / height < 1.2 || (double)width / height > 2.5) throw new InvalidOperationException("游戏窗口尺寸不在测试范围");
            using (Bitmap original = new Bitmap(width, height, PixelFormat.Format32bppArgb)) {
                using (Graphics graphics = Graphics.FromImage(original)) graphics.CopyFromScreen(origin.x, origin.y, 0, 0, new Size(width, height));
                ForegroundInfo after = GameWindow.Inspect();
                if (GetForegroundWindow() != window || !after.matched || after.processId != before.processId) throw new InvalidOperationException("截图时前台窗口改变");
                int scaledWidth = Math.Min(1280, width), scaledHeight = height * scaledWidth / width;
                using (Bitmap scaled = new Bitmap(scaledWidth, scaledHeight, PixelFormat.Format32bppArgb)) {
                    using (Graphics graphics = Graphics.FromImage(scaled)) { graphics.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.NearestNeighbor; graphics.DrawImage(original, 0, 0, scaledWidth, scaledHeight); }
                    FollowFrame frame = MarkerVision.Detect(scaled, now, preview);
                    frame.clientWidth = width; frame.clientHeight = height;
                    if (GetForegroundWindow() != window || !GameWindow.Foreground()) frame.error = "识别时游戏失焦";
                    return frame;
                }
            }
        } catch (Exception error) { return new FollowFrame { capturedAt = now, error = error.Message }; }
    }
}

// Screen motion is measured from two actual P2 pulses before following.
// P2-P1 relative displacement removes shared camera translation.
public sealed class FollowEngine {
    readonly IPads pads; readonly Action<object> output; readonly Func<long, bool, FollowFrame> capture;
    string phase = "idle", reason = "尚未启动"; long next, deadline, started, sequence; bool active, observeOnly;
    FollowFrame last, origin; double rx, ry, ux, uy, distanceBefore; int steps, misses;
    public bool Busy { get { return phase == "countdown" || phase == "baseline" || phase == "right" || phase == "up" || phase == "following"; } }
    public FollowEngine(IPads pads, Action<object> output, Func<long, bool, FollowFrame> capture) { this.pads = pads; this.output = output; this.capture = capture; }
    public void Start(int delay, bool confirmed, bool preview, long now) {
        if (Busy) throw new InvalidOperationException("观察/跟随已经运行");
        if (delay < 2000 || delay > 10000) throw new ArgumentException("延迟应为 2..10 秒");
        if (!preview && !confirmed) throw new ArgumentException("先确认营地空地、P2 对应第二只手柄，并在校准时保持 P1 静止");
        sequence++; steps = misses = 0; rx = ry = ux = uy = 0; last = origin = null; active = false; observeOnly = preview;
        phase = "countdown"; next = now + delay; deadline = next + 12000; started = now;
        Publish("倒计时后读取初代前台画面；请切回游戏");
    }
    void Publish(string message) { reason = message; output(new { type = "follow", session = sequence, phase, reason, steps, active, frame = last, elapsedMs = last == null ? 0 : last.capturedAt - started, gameOutcomeVerified = false }); }
    public void Cancel(string message) {
        if (!Busy) return;
        pads.Send(2, new PadReport()); active = false; phase = "stopped"; Publish(message);
    }
    void Complete(string message) { pads.Send(2, new PadReport()); active = false; phase = "complete"; Publish(message); }
    static double X(FollowFrame f) { return (f.p2.x - f.p1.x) / f.width; }
    static double Y(FollowFrame f) { return (f.p2.y - f.p1.y) / f.width; }
    static double Length(double x, double y) { return Math.Sqrt(x * x + y * y); }
    bool Read(ref long now) {
        Stopwatch reading = Stopwatch.StartNew();
        last = capture(now, observeOnly);
        now += reading.ElapsedMilliseconds;
        if (!last.Valid || last.capturedAt > now || now - last.capturedAt > 400) { Cancel(last.error ?? "观察过期，停止"); return false; }
        if (Length(X(last), Y(last)) > .35) { Cancel("角色间距超出营地短移范围，停止"); return false; }
        return true;
    }
    void Pulse(PadReport report, long now, string message) { pads.Send(2, report); active = true; next = now + 150; Publish(message); }
    public static PadReport Solve(double x, double y, double rx, double ry, double ux, double uy) {
        double determinant = rx * uy - ux * ry;
        if (Length(rx, ry) < .001 || Length(ux, uy) < .001 || Math.Abs(determinant) < Length(rx, ry) * Length(ux, uy) * .35) throw new InvalidOperationException("校准位移不足或方向不独立；请换空地，不沿用旧校准");
        double a = (x * uy - ux * y) / determinant, b = (rx * y - x * ry) / determinant, scale = Math.Max(1, Length(a, b));
        return new PadReport { LX = (short)(18000 * a / scale), LY = (short)(18000 * b / scale) };
    }
    public void Tick(long now, bool foreground, bool emergency) {
        if (!Busy) return;
        if (emergency) { Cancel("F12 紧急停止；需手动重新启动"); return; }
        if (now >= deadline) { Cancel("本轮 12 秒期限结束；需手动重新启动"); return; }
        // Countdown allows the user to return to the game. Once begun, loss of focus ends the entire session.
        if (phase != "countdown" && !foreground) { Cancel("初代失焦，结束本轮；不自动恢复"); return; }
        if (now < next) return;
        if (!foreground) { Cancel("倒计时结束时初代不在前台，未发送输入"); return; }
        if (active) { pads.Send(2, new PadReport()); active = false; next = now + 250; return; }
        if (!Read(ref now)) return;
        if (now >= deadline) { Cancel("观察超过本轮期限，停止"); return; }
        if (observeOnly) { Complete("画面已读取；本次只观察，未发送输入"); return; }
        if (phase == "countdown") {
            if (Length(X(last), Y(last)) <= .08) { Complete("画面显示已在 P1 附近，不校准、不移动；请人工核对"); return; }
            origin = last; phase = "right"; Pulse(new PadReport { LX = 18000 }, now, "校准：P2 向右 150ms；请保持 P1 静止"); return;
        }
        if (last.width != origin.width || last.height != origin.height || last.clientWidth != origin.clientWidth || last.clientHeight != origin.clientHeight || Length((last.p1.x - origin.p1.x) / last.width, (last.p1.y - origin.p1.y) / last.width) > .04) { Cancel("窗口尺寸或 P1 位置变化超出校准范围，停止"); return; }
        if (phase == "right") {
            rx = X(last) - X(origin); ry = Y(last) - Y(origin);
            if (Length(rx, ry) < .001 || Length(rx, ry) > .04) { Cancel("右移校准没有稳定的小幅位移，停止"); return; }
            origin = last; phase = "up"; Pulse(new PadReport { LY = 18000 }, now, "校准：P2 向上 150ms；释放后重新观察"); return;
        }
        if (phase == "up") {
            ux = X(last) - X(origin); uy = Y(last) - Y(origin);
            if (Length(ux, uy) > .04) { Cancel("上移校准位移异常，停止"); return; }
            try { Solve(1, 0, rx, ry, ux, uy); } catch (Exception error) { Cancel(error.Message); return; }
            phase = "following";
        } else if (phase == "following") {
            double after = Length(X(last), Y(last));
            misses = after < distanceBefore - .001 ? 0 : misses + 1;
            if (after > distanceBefore + .008 || misses >= 2) { Cancel("未观察到稳定接近；可能受阻或标记跳变，停止"); return; }
        }
        double distance = Length(X(last), Y(last));
        if (distance <= .08) { Complete("画面显示已在 P1 附近，保持空闲；请人工核对"); return; }
        if (steps >= 6) { Complete("六次短移已结束并释放；核对后可手动开始新一轮"); return; }
        PadReport move = Solve(-X(last), -Y(last), rx, ry, ux, uy);
        origin = last; distanceBefore = distance; steps++;
        Pulse(move, now, "跟随短移 " + steps + "/6；每次释放后读取新画面");
    }
}

public static class FollowTests {
    static int checks; static void Check(bool value, string label) { if (!value) throw new Exception(label); checks++; }
    static FollowFrame Frame(long now, double x, double y) { return new FollowFrame { capturedAt = now, width = 1000, height = 625, p1 = new Marker { x = 500, y = 300 }, p2 = new Marker { x = x, y = y } }; }
    static Bitmap Glyphs(bool duplicate) {
        Bitmap image = new Bitmap(1000, 625, PixelFormat.Format32bppArgb);
        using (Graphics g = Graphics.FromImage(image)) {
            Draw(g, 420, 300, Color.FromArgb(255, 190, 70), new string[] { "11111", "11011", "11011", "11111", "11000", "11000", "11000" });
            Draw(g, 444, 300, Color.FromArgb(255, 190, 70), new string[] { "011", "111", "011", "011", "011", "011", "011" });
            Draw(g, 600, 300, Color.FromArgb(70, 235, 200), new string[] { "11111", "11011", "11011", "11111", "11000", "11000", "11000" });
            Draw(g, 624, 300, Color.FromArgb(70, 235, 200), new string[] { "11111", "00011", "00011", "11111", "11000", "11000", "11111" });
            if (duplicate) { Draw(g, 700, 300, Color.FromArgb(70, 235, 200), new string[] { "11111", "11011", "11011", "11111", "11000", "11000", "11000" }); Draw(g, 724, 300, Color.FromArgb(70, 235, 200), new string[] { "11111", "00011", "00011", "11111", "11000", "11000", "11111" }); }
        } return image;
    }
    static void Draw(Graphics graphics, int x, int y, Color colour, string[] glyph) { using (Brush brush = new SolidBrush(colour)) for (int row = 0; row < 7; row++) for (int col = 0; col < glyph[row].Length; col++) if (glyph[row][col] == '1') graphics.FillRectangle(brush, x + col * 4, y + row * 4, 4, 4); }
    public static int Run() {
        using (Bitmap image = Glyphs(false)) Check(MarkerVision.Detect(image, 0, false).Valid, "distinct glyphs");
        using (Bitmap image = Glyphs(true)) Check(!MarkerVision.Detect(image, 0, false).Valid, "ambiguous glyphs stop");
        using (Bitmap image = new Bitmap(1000, 625)) Check(!MarkerVision.Detect(image, 0, false).Valid, "blank image stops");
        PadReport movement = FollowEngine.Solve(-.1, 0, .01, 0, 0, -.01); Check(movement.LX < 0 && movement.LY == 0 && movement.Buttons == 0, "measured screen axes");
        movement = FollowEngine.Solve(0, -.1, .007, .007, .007, -.007); Check(movement.LX < 0 && movement.LY > 0, "isometric axes");
        bool failed = false; try { FollowEngine.Solve(1, 0, 0, 0, 0, -.01); } catch { failed = true; } Check(failed, "blocked calibration");
        FakePads pads = new FakePads(); List<object> events = new List<object>();
        FollowEngine engine = new FollowEngine(pads, events.Add, (now, preview) => Frame(now, 700, 300));
        failed = false; try { engine.Start(5000, false, false, 0); } catch { failed = true; } Check(failed && pads.Reports.Count == 0, "explicit camp confirmation");
        engine.Start(5000, false, true, 0); engine.Tick(4999, false, false); Check(pads.Reports.Count == 0, "no early reports"); engine.Tick(5000, true, false); Check(!engine.Busy && pads.Reports.TrueForAll(r => r.Item2.Neutral), "observe only");
        pads.Reports.Clear(); engine.Start(5000, true, false, 0); engine.Tick(5000, false, false); Check(!engine.Busy && pads.Reports.TrueForAll(r => r.Item2.Neutral), "foreground rejection");
        pads.Reports.Clear(); engine.Start(5000, true, false, 0); engine.Tick(5000, true, false); Check(pads.Reports.Count == 1 && pads.Reports[0].Item1 == 2, "P2 only calibration"); engine.Tick(5010, true, true); Check(!engine.Busy && pads.Reports[1].Item2.Neutral, "F12 ends session"); engine.Tick(6000, true, false); Check(pads.Reports.Count == 2, "no emergency replay");
        engine.Start(2000, true, false, 0); engine.Tick(2000, true, false); engine.Tick(2150, true, false); Check(pads.Reports[pads.Reports.Count - 1].Item2.Neutral, "150ms release before capture"); engine.Tick(2400, true, false); Check(!engine.Busy, "no motion calibration stops");
        engine.Start(2000, true, false, 0); engine.Tick(14000, true, false); Check(!engine.Busy, "hard session deadline");
        engine.Start(2000, true, false, 0); engine.Tick(2000, true, false); engine.Tick(2010, false, false); Check(!engine.Busy && pads.Reports[pads.Reports.Count - 1].Item2.Neutral, "focus loss ends session");
        FollowEngine stale = new FollowEngine(pads, events.Add, (now, preview) => Frame(now - 401, 700, 300)); stale.Start(2000, true, false, 0); stale.Tick(2000, true, false); Check(!stale.Busy, "stale observation rejected");
        Check(pads.Reports.TrueForAll(r => r.Item1 == 2), "no P1 or button reports");
        pads = new FakePads(); int captures = 0;
        FollowEngine tracking = new FollowEngine(pads, events.Add, (now, preview) => {
            int index = captures++; return Frame(now, index == 0 ? 700 : index == 1 ? 710 : 710 - Math.Max(0, index - 2) * 10, index < 2 ? 300 : 290);
        });
        tracking.Start(2000, true, false, 0);
        for (int now = 2000; now <= 8000; now += 50) tracking.Tick(now, true, false);
        int pulses = pads.Reports.FindAll(r => !r.Item2.Neutral).Count;
        Check(!tracking.Busy && pulses == 8, "two calibrations and at most six follow pulses");
        Check(captures == 9, "new observation between every pulse and after final release");
        Check(pads.Reports.TrueForAll(r => r.Item1 == 2 && r.Item2.Buttons == 0 && r.Item2.RightTrigger == 0), "follow never sends P1 or combat buttons");
        Check(pads.Reports[pads.Reports.Count - 1].Item2.Neutral, "completed follow stays neutral");
        pads = new FakePads(); captures = 0;
        FollowEngine blocked = new FollowEngine(pads, events.Add, (now, preview) => { int index = captures++; return Frame(now, index == 0 ? 700 : 710, index < 2 ? 300 : 290); });
        blocked.Start(2000, true, false, 0); for (int now = 2000; now <= 5000; now += 50) blocked.Tick(now, true, false);
        Check(!blocked.Busy && pads.Reports.FindAll(r => !r.Item2.Neutral).Count == 4, "two no-progress observations end session without replay");
        pads = new FakePads(); FollowEngine lost = new FollowEngine(pads, events.Add, (now, preview) => new FollowFrame { capturedAt = now, error = "missing marker" });
        lost.Start(2000, true, false, 0); lost.Tick(2000, true, false); Check(!lost.Busy && pads.Reports.TrueForAll(r => r.Item2.Neutral), "missing marker never moves");
        pads = new FakePads(); FollowEngine close = new FollowEngine(pads, events.Add, (now, preview) => Frame(now, 510, 300));
        close.Start(2000, true, false, 0); close.Tick(2000, true, false); Check(!close.Busy && pads.Reports.TrueForAll(r => r.Item2.Neutral), "already close does not calibrate");
        pads = new FakePads(); FollowEngine manual = new FollowEngine(pads, events.Add, (now, preview) => Frame(now, 700, 300));
        manual.Start(2000, true, false, 0); manual.Tick(2000, true, false); manual.Cancel("manual stop"); Check(!manual.Busy && pads.Reports[pads.Reports.Count - 1].Item2.Neutral, "manual cancel releases calibration");
        Console.WriteLine(new JavaScriptSerializer().Serialize(new { ok = true, checks, nativeDriverUsed = false, gameInputSent = false })); return 0;
    }
}
