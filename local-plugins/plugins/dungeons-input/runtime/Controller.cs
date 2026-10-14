using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;

[StructLayout(LayoutKind.Sequential)]
public struct PadReport {
    public ushort Buttons; public byte LeftTrigger, RightTrigger;
    public short LX, LY, RX, RY;
    public bool Neutral { get { return Buttons == 0 && LeftTrigger == 0 && RightTrigger == 0 && LX == 0 && LY == 0 && RX == 0 && RY == 0; } }
}
public interface IPads : IDisposable { void Send(int pad, PadReport report); uint[] TargetIds { get; } }

public sealed class VigemPads : IPads {
    const uint Success = 0x20000000;
    IntPtr bus; readonly IntPtr[] targets = new IntPtr[2]; readonly uint[] ids = new uint[2];
    public uint[] TargetIds { get { return ids; } }
    public uint[] XInputSlots { get; private set; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr LoadLibraryEx(string file, IntPtr reserved, uint flags);
    [DllImport("ViGEmClient.dll", CallingConvention = CallingConvention.Cdecl)] static extern IntPtr vigem_alloc();
    [DllImport("ViGEmClient.dll", CallingConvention = CallingConvention.Cdecl)] static extern void vigem_free(IntPtr client);
    [DllImport("ViGEmClient.dll", CallingConvention = CallingConvention.Cdecl)] static extern uint vigem_connect(IntPtr client);
    [DllImport("ViGEmClient.dll", CallingConvention = CallingConvention.Cdecl)] static extern void vigem_disconnect(IntPtr client);
    [DllImport("ViGEmClient.dll", CallingConvention = CallingConvention.Cdecl)] static extern IntPtr vigem_target_x360_alloc();
    [DllImport("ViGEmClient.dll", CallingConvention = CallingConvention.Cdecl)] static extern void vigem_target_free(IntPtr target);
    [DllImport("ViGEmClient.dll", CallingConvention = CallingConvention.Cdecl)] static extern uint vigem_target_add(IntPtr client, IntPtr target);
    [DllImport("ViGEmClient.dll", CallingConvention = CallingConvention.Cdecl)] static extern uint vigem_target_remove(IntPtr client, IntPtr target);
    [DllImport("ViGEmClient.dll", CallingConvention = CallingConvention.Cdecl)] static extern uint vigem_target_x360_update(IntPtr client, IntPtr target, PadReport report);
    [DllImport("ViGEmClient.dll", CallingConvention = CallingConvention.Cdecl)] static extern uint vigem_target_get_index(IntPtr target);
    static void Check(uint result) { if (result != Success) throw new InvalidOperationException(result == 0xE0000001 ? "未找到 ViGEmBus 驱动；先安装已校验的官方驱动，再创建手柄。" : "ViGEm 调用失败 0x" + result.ToString("X8")); }
    public VigemPads(bool probeOnly) {
        if (IntPtr.Size != 8) throw new InvalidOperationException("需要 x64 进程");
        if (LoadLibraryEx(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "ViGEmClient.dll"), IntPtr.Zero, 0x1100) == IntPtr.Zero) throw new InvalidOperationException("无法加载测试目录中的 ViGEmClient.dll：" + Marshal.GetLastWin32Error());
        try {
            bus = vigem_alloc(); if (bus == IntPtr.Zero) throw new InvalidOperationException("ViGEm 分配失败"); Check(vigem_connect(bus));
            if (probeOnly) return;
            if (GameWindow.Foreground()) throw new InvalidOperationException("创建手柄前请切回测试面板；初始化只在初代游戏不处于前台时进行");
            uint[] baseline = NativeDeviceTests.ConnectedIndices();
            for (int i = 0; i < 2; i++) {
                targets[i] = vigem_target_x360_alloc(); if (targets[i] == IntPtr.Zero) throw new InvalidOperationException("手柄分配失败");
                Check(vigem_target_add(bus, targets[i]));
                ids[i] = vigem_target_get_index(targets[i]);
                Send(i + 1, new PadReport());
            }
            // ViGEmClient's user-index query can return zero for every target
            // (upstream issue #31). Route by our two distinct target handles;
            // expose the Windows slots separately without claiming a mapping.
            if (ids[0] == ids[1]) throw new InvalidOperationException("测试设备 ID 重复");
            bool assigned = false;
            for (int attempt = 0; attempt < 100; attempt++) {
                uint[] current = NativeDeviceTests.ConnectedIndices();
                List<uint> added = new List<uint>();
                foreach (uint index in current) if (Array.IndexOf(baseline, index) < 0) added.Add(index);
                bool preserved = true; foreach (uint index in baseline) if (Array.IndexOf(current, index) < 0) preserved = false;
                assigned = preserved && added.Count == 2;
                if (assigned) XInputSlots = added.ToArray();
                if (assigned) break; Thread.Sleep(50);
            }
            if (!assigned) throw new InvalidOperationException("未确认两只独立 XInput 槽，停止并清理测试设备");
            // ViGEmBus boots with a nonzero analog report but its cached report
            // is zero, so unchanged zero updates are dropped. Prime with one
            // analog unit (no buttons), then zero and verify through XInput.
            Send(1, new PadReport { RX = 1 }); Send(2, new PadReport { RX = 1 });
            Thread.Sleep(30);
            Send(1, new PadReport()); Send(2, new PadReport());
            bool neutral = false;
            for (int attempt = 0; attempt < 40; attempt++) {
                neutral = NativeDeviceTests.IsNeutral(XInputSlots[0]) && NativeDeviceTests.IsNeutral(XInputSlots[1]);
                if (neutral) break; Thread.Sleep(50);
            }
            if (!neutral) throw new InvalidOperationException("Windows 未确认两只测试手柄归零；已停止并移除设备");
        } catch { Dispose(); throw; }
    }
    public void Send(int pad, PadReport report) { if (pad < 1 || pad > 2 || targets[pad - 1] == IntPtr.Zero) throw new InvalidOperationException("测试手柄无效"); Check(vigem_target_x360_update(bus, targets[pad - 1], report)); }
    public void Dispose() {
        for (int i = 1; i >= 0; i--) if (targets[i] != IntPtr.Zero) {
            try { vigem_target_x360_update(bus, targets[i], new PadReport()); } catch { }
            try { vigem_target_remove(bus, targets[i]); } catch { }
            vigem_target_free(targets[i]); targets[i] = IntPtr.Zero;
        }
        if (bus != IntPtr.Zero) { vigem_disconnect(bus); vigem_free(bus); bus = IntPtr.Zero; }
    }
}

public sealed class PulseEngine {
    readonly IPads pads; readonly Action<object> output; readonly HashSet<string> seen = new HashSet<string>();
    readonly Queue<string> order = new Queue<string>();
    string id; int target; PadReport report; long start, end; bool active;
    public bool Busy { get { return id != null; } }
    public PulseEngine(IPads value, Action<object> writer) { pads = value; output = writer; }
    public static PadReport Control(string control) {
        PadReport r = new PadReport();
        switch (control) {
            case "up": r.LY = 18000; break; case "down": r.LY = -18000; break;
            case "left": r.LX = -18000; break; case "right": r.LX = 18000; break;
            case "RT": r.RightTrigger = 160; break;
            case "A": r.Buttons = 0x1000; break; case "B": r.Buttons = 0x2000; break;
            case "X": r.Buttons = 0x4000; break; case "Y": r.Buttons = 0x8000; break;
            case "LB": r.Buttons = 0x100; break; case "RB": r.Buttons = 0x200; break;
            case "Start": r.Buttons = 0x10; break; case "Back": r.Buttons = 0x20; break;
            case "LeftThumb": r.Buttons = 0x40; break; case "RightThumb": r.Buttons = 0x80; break;
            case "DpadUp": r.Buttons = 1; break; case "DpadDown": r.Buttons = 2; break;
            case "DpadLeft": r.Buttons = 4; break; case "DpadRight": r.Buttons = 8; break;
            default: throw new ArgumentException("未知测试按键");
        }
        return r;
    }
    public void Schedule(string requestId, int pad, string control, int duration, int delay, bool confirmP1, long now) {
        if (String.IsNullOrEmpty(requestId) || requestId.Length > 64 || seen.Contains(requestId)) throw new ArgumentException("请求 ID 无效或重复；不重放");
        if (Busy) throw new InvalidOperationException("已有测试脉冲");
        if (pad != 1 && pad != 2) throw new ArgumentException("手柄编号无效");
        if (pad == 1 && !confirmP1) throw new ArgumentException("P1 初始化需要明确确认");
        if (duration < 50 || duration > 1000 || delay < 2000 || delay > 10000) throw new ArgumentException("脉冲或延迟超出范围");
        PadReport next = Control(control);
        seen.Add(requestId); order.Enqueue(requestId); if (order.Count > 128) seen.Remove(order.Dequeue());
        id = requestId; target = pad; report = next; start = now + delay; end = start + duration; active = false;
        output(new { type = "result", id, pad, control, status = "scheduled", delayMs = delay, durationMs = duration });
    }
    void Finish(string status, string reason, ForegroundInfo foreground = null) {
        if (id == null) return;
        pads.Send(1, new PadReport()); pads.Send(2, new PadReport());
        output(new { type = "result", id, pad = target, status, reason, inputWasSent = active, gameOutcomeVerified = false, foreground });
        id = null; active = false;
    }
    public void Cancel(string reason) { Finish("cancelled", reason); }
    public void Tick(long now, bool gameForeground, ForegroundInfo foreground = null) {
        if (id == null || now < start) return;
        if (!gameForeground) { Finish("cancelled", (foreground == null ? "初代游戏未在前台或失焦" : foreground.RejectionReason) + "；已释放输入，不重试", foreground); return; }
        if (now >= end) { Finish(active ? "sent" : "expired", active ? "短脉冲已发送并释放；请在游戏核对结果" : "未及时执行，已过期，不补发"); return; }
        if (!active) { pads.Send(target, report); active = true; output(new { type = "result", id, pad = target, status = "active" }); }
    }
}

public sealed class ForegroundInfo {
    public uint processId; public string executable; public bool matched; public string error;
    public string RejectionReason { get { return matched ? null : error != null ? "无法核验前台窗口：" + error : "前台路径不在初代白名单：" + executable; } }
}
public static class GameWindow {
    public const string FirstGame = @"C:\XboxGames\Minecraft Dungeons\Content\Dungeons\Binaries\Win64\Dungeons.exe";
    // Verified local Appx registration: Microsoft.Lovika / 8wekyb3d8bbwe.
    // Xbox can launch this package alias instead of the XboxGames file path.
    public const string RegisteredGame = @"C:\Program Files\WindowsApps\Microsoft.Lovika_1.17.0.0_x64__8wekyb3d8bbwe\Dungeons\Binaries\Win64\Dungeons.exe";
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
    public static bool Matches(string executable) { return String.Equals(executable, FirstGame, StringComparison.OrdinalIgnoreCase) || String.Equals(executable, RegisteredGame, StringComparison.OrdinalIgnoreCase); }
    public static ForegroundInfo Inspect() {
        ForegroundInfo result = new ForegroundInfo();
        try {
            IntPtr window = GetForegroundWindow(); if (window == IntPtr.Zero) throw new InvalidOperationException("没有可读取的前台窗口");
            GetWindowThreadProcessId(window, out result.processId);
            using (Process process = Process.GetProcessById((int)result.processId)) result.executable = process.MainModule.FileName;
            result.matched = Matches(result.executable);
        } catch (Exception error) { result.error = error.Message; }
        return result;
    }
    public static bool Foreground() { return Inspect().matched; }
}

public static class Program {
    static readonly JavaScriptSerializer json = new JavaScriptSerializer();
    static void Write(object message) { Console.WriteLine(json.Serialize(message)); Console.Out.Flush(); }
    static int Number(Dictionary<string, object> data, string name) {
        object value; if (!data.TryGetValue(name, out value) || !(value is int)) throw new ArgumentException(name + " 必须为整数"); return (int)value;
    }
    public static int Main(string[] args) {
        Console.InputEncoding = new System.Text.UTF8Encoding(false); Console.OutputEncoding = new System.Text.UTF8Encoding(false);
        if (args.Length == 1 && args[0] == "--self-test") return SelfTests.Run();
        if (args.Length == 1 && args[0] == "--follow-self-test") return FollowTests.Run();
        try {
            if (args.Length == 2 && args[0] == "--vision-file") {
                using (System.Drawing.Bitmap source = new System.Drawing.Bitmap(args[1]))
                using (System.Drawing.Bitmap image = new System.Drawing.Bitmap(source.Width, source.Height, System.Drawing.Imaging.PixelFormat.Format32bppArgb)) {
                    using (System.Drawing.Graphics graphics = System.Drawing.Graphics.FromImage(image)) graphics.DrawImage(source, 0, 0, source.Width, source.Height);
                    Write(MarkerVision.Detect(image, 0, false)); return 0;
                }
            }
            if (args.Length == 1 && args[0] == "--xinput-status") { Write(new { type = "xinput", slots = NativeDeviceTests.Status() }); return 0; }
            if (args.Length == 1 && args[0] == "--foreground-status") { Write(new { type = "foreground", current = GameWindow.Inspect(), allowedPaths = new string[] { GameWindow.FirstGame, GameWindow.RegisteredGame }, targetsCreated = 0 }); return 0; }
            if (args.Length == 1 && args[0] == "--capture-status") { Write(new { type = "capture", frame = GameCapture.Read(0, false), targetsCreated = 0, gameInputSent = false }); return 0; }
            if (args.Length == 1 && args[0] == "--device-test") return NativeDeviceTests.Run();
            bool probe = args.Length == 1 && args[0] == "--probe";
            if (args.Length != 0 && !probe) throw new ArgumentException("未知启动参数");
            using (VigemPads pads = new VigemPads(probe)) {
                if (probe) { Write(new { type = "probe", available = true, targetsCreated = 0 }); return 0; }
                PulseEngine engine = new PulseEngine(pads, Write);
                FollowEngine follow = new FollowEngine(pads, Write, GameCapture.Read);
                Write(new { type = "state", ready = true, pads = pads.TargetIds, xinputSlots = pads.XInputSlots, targetToSlotMappingKnown = false, gamePath = GameWindow.FirstGame, allowedGamePaths = new string[] { GameWindow.FirstGame, GameWindow.RegisteredGame }, nativeKeyboardMouse = true });
                ConcurrentQueue<string> input = new ConcurrentQueue<string>(); int eof = 0;
                Thread reader = new Thread(() => { string line; while ((line = Console.ReadLine()) != null) { if (line.Length > 4096 || input.Count > 32) { Interlocked.Exchange(ref eof, 1); return; } input.Enqueue(line); } Interlocked.Exchange(ref eof, 1); });
                reader.IsBackground = true; reader.Start();
                Stopwatch clock = Stopwatch.StartNew(); long heartbeat = 0;
                try {
                    while (Volatile.Read(ref eof) == 0) {
                        string line;
                        while (input.TryDequeue(out line)) {
                            Dictionary<string, object> data = null;
                            try {
                                data = json.Deserialize<Dictionary<string, object>>(line); string type = (string)data["type"];
                                if (type == "stop") { engine.Cancel("手动断开"); follow.Cancel("手动断开"); return 0; }
                                if (type == "heartbeat") heartbeat = clock.ElapsedMilliseconds;
                                else if (type == "cancel") { engine.Cancel("手动停止"); follow.Cancel("手动停止；需重新启动"); }
                                else if (type == "follow-start" || type == "follow-observe") {
                                    if (engine.Busy) throw new InvalidOperationException("先结束手动脉冲");
                                    object confirmed; bool allow = data.TryGetValue("confirmCamp", out confirmed) && confirmed is bool && (bool)confirmed;
                                    follow.Start(Number(data, "delayMs"), allow, type == "follow-observe", clock.ElapsedMilliseconds);
                                }
                                else if (type == "pulse") {
                                    if (follow.Busy) throw new InvalidOperationException("先停止观察/跟随，再手动输入");
                                    object confirm; bool allowP1 = data.TryGetValue("confirmP1", out confirm) && confirm is bool && (bool)confirm;
                                    engine.Schedule((string)data["id"], Number(data, "pad"), (string)data["control"], Number(data, "durationMs"), Number(data, "delayMs"), allowP1, clock.ElapsedMilliseconds);
                                } else throw new ArgumentException("未知消息");
                            } catch (Exception error) {
                                object requestType;
                                if (data != null && data.TryGetValue("type", out requestType) && (String.Equals(requestType, "follow-start") || String.Equals(requestType, "follow-observe"))) Write(new { type = "follow", phase = "rejected", reason = error.Message });
                                else { object requestId; Write(new { type = "result", id = data != null && data.TryGetValue("id", out requestId) ? requestId : null, status = "rejected", reason = error.Message }); }
                            }
                        }
                        if (clock.ElapsedMilliseconds - heartbeat > 3000) { engine.Cancel("宿主心跳中断"); follow.Cancel("宿主心跳中断"); Write(new { type = "ended", reason = "宿主心跳超时，移除两只测试手柄" }); return 0; }
                        bool emergency = (GameWindow.GetAsyncKeyState(0x7B) & 0x8000) != 0;
                        if (emergency) engine.Cancel("F12 紧急停止");
                        if (engine.Busy) { ForegroundInfo foreground = GameWindow.Inspect(); engine.Tick(clock.ElapsedMilliseconds, foreground.matched, foreground); }
                        if (follow.Busy) follow.Tick(clock.ElapsedMilliseconds, GameWindow.Foreground(), emergency);
                        Thread.Sleep(15);
                    }
                } finally { engine.Cancel("输入通道关闭"); follow.Cancel("输入通道关闭"); }
            }
            return 0;
        } catch (Exception error) { Write(new { type = args.Length == 1 && args[0] == "--probe" ? "probe" : "error", available = false, error = error.Message }); return 1; }
    }
}

[StructLayout(LayoutKind.Sequential)]
public struct XInputState { public uint Packet; public PadReport Report; }
public static class NativeDeviceTests {
    [DllImport("xinput1_4.dll")] static extern uint XInputGetState(uint index, out XInputState state);
    public static object[] Status() {
        object[] slots = new object[4];
        for (uint i = 0; i < 4; i++) { XInputState state; uint result = XInputGetState(i, out state); slots[i] = new { index = i, connected = result == 0, neutral = result == 0 && state.Report.Neutral }; }
        return slots;
    }
    public static uint[] ConnectedIndices() {
        List<uint> indices = new List<uint>();
        for (uint i = 0; i < 4; i++) { XInputState state; if (XInputGetState(i, out state) == 0) indices.Add(i); }
        return indices.ToArray();
    }
    static void Check(bool condition, string reason) { if (!condition) throw new Exception(reason); }
    public static bool IsNeutral(uint index) { XInputState state; return XInputGetState(index, out state) == 0 && state.Report.Neutral; }
    static void Neutral(uint index) { XInputState state; uint result = XInputGetState(index, out state); Check(result == 0 && state.Report.Neutral, "XInput slot must expose a neutral owned device: " + index + "; status=" + result + "; " + new JavaScriptSerializer().Serialize(state.Report)); }
    static uint Independent(VigemPads pads, uint[] owned, int pad) {
        Check(!GameWindow.Foreground(), "Diagnostic must run outside the first-game foreground");
        pads.Send(pad, new PadReport { RX = 1 }); Thread.Sleep(50);
        int changed = 0; uint affected = 0;
        foreach (uint index in owned) {
            XInputState state; Check(XInputGetState(index, out state) == 0, "Diagnostic device disconnected");
            if (state.Report.Neutral) continue;
            Check(state.Report.RX == 1, "Diagnostic analog value");
            state.Report.RX = 0; Check(state.Report.Neutral, "Other diagnostic controls must stay neutral");
            changed++; affected = index;
        }
        Check(changed == 1, "Exactly one owned slot must change per target");
        pads.Send(pad, new PadReport()); Thread.Sleep(50); Neutral(owned[0]); Neutral(owned[1]);
        return affected;
    }
    public static int Run() {
        uint[] owned;
        List<string> checks = new List<string>();
        using (VigemPads pads = new VigemPads(false)) {
            owned = (uint[])pads.XInputSlots.Clone();
            Check(pads.TargetIds[0] != pads.TargetIds[1] && owned.Length == 2 && owned[0] != owned[1], "Distinct targets and Xbox slots"); checks.Add("Two distinct owned handles/IDs; Windows exposes two added XInput slots without guessing their mapping");
            Thread.Sleep(200); Neutral(owned[0]); Neutral(owned[1]); checks.Add("Windows XInput sees both neutral reports");
            uint first = Independent(pads, owned, 1), second = Independent(pads, owned, 2);
            Check(first != second, "Owned target handles must affect distinct XInput slots");
            checks.Add("One-unit analog diagnostic on each handle affects only its own distinct XInput slot");
            checks.Add("Both independent diagnostics release to verified zero; no button or gameplay pulse sent");
            List<object> events = new List<object>(); PulseEngine engine = new PulseEngine(pads, events.Add);
            engine.Schedule("focus", 2, "right", 200, 2000, false, 0); engine.Tick(2000, false);
            Check(!engine.Busy, "Focus rejection"); Neutral(owned[0]); Neutral(owned[1]); checks.Add("Rejected foreground releases both actual targets without non-neutral input");
            engine.Schedule("expired", 2, "A", 200, 2000, false, 0); engine.Tick(3000, true);
            Check(!engine.Busy, "Expired rejection"); Neutral(owned[0]); Neutral(owned[1]); checks.Add("Expired pulse never appears on either actual device");
            engine.Schedule("cancel", 2, "A", 200, 2000, false, 0); engine.Cancel("test");
            Check(!engine.Busy, "Cancel pending"); Neutral(owned[0]); Neutral(owned[1]); checks.Add("Cancel scheduled pulse keeps both actual devices neutral");
        }
        bool removed = false;
        for (int attempt = 0; attempt < 40; attempt++) {
            XInputState first, second;
            removed = XInputGetState(owned[0], out first) == 1167 && XInputGetState(owned[1], out second) == 1167;
            if (removed) break; Thread.Sleep(50);
        }
        Check(removed, "Owned devices must disappear after disposal"); checks.Add("Disposal removes both owned XInput targets");
        Console.WriteLine(new JavaScriptSerializer().Serialize(new { ok = true, nativeDriverUsed = true, initializationAnalogUnits = 1, diagnosticAnalogUnits = 1, gameplayPulseSent = false, ownedSlots = owned, checks, realGameCoopVerified = false })); return 0;
    }
}

public sealed class FakePads : IPads {
    public readonly List<Tuple<int, PadReport>> Reports = new List<Tuple<int, PadReport>>();
    public uint[] TargetIds { get { return new uint[] { 1, 2 }; } }
    public void Send(int pad, PadReport report) { Reports.Add(Tuple.Create(pad, report)); }
    public void Dispose() { }
}
public static class SelfTests {
    static void Check(bool condition, string label) { if (!condition) throw new Exception(label); }
    static void Reject(Action action, string label) { bool failed = false; try { action(); } catch { failed = true; } Check(failed, label); }
    public static int Run() {
        FakePads pads = new FakePads(); List<object> events = new List<object>(); PulseEngine engine = new PulseEngine(pads, events.Add);
        Check(Marshal.SizeOf(typeof(PadReport)) == 12, "XUSB ABI");
        Reject(() => engine.Schedule("p1", 1, "A", 100, 2000, false, 0), "P1 explicit confirmation");
        Reject(() => engine.Schedule("bad", 2, "A", 1001, 2000, false, 0), "bounded duration");
        Reject(() => engine.Schedule("bad", 2, "A", 100, 1999, false, 0), "switch-to-game delay");
        Reject(() => engine.Schedule("bad", 3, "A", 100, 2000, false, 0), "owned pads only");
        Reject(() => engine.Schedule("bad", 2, "unknown", 100, 2000, false, 0), "control whitelist");
        engine.Schedule("a", 2, "right", 100, 2000, false, 0);
        Reject(() => engine.Schedule("b", 2, "A", 100, 2000, false, 0), "single pending pulse");
        engine.Tick(1999, false); Check(pads.Reports.Count == 0, "no early input");
        engine.Tick(2000, true); Check(pads.Reports.Count == 1 && pads.Reports[0].Item1 == 2 && pads.Reports[0].Item2.LX == 18000, "only P2 moves");
        engine.Tick(2010, false); Check(!engine.Busy && pads.Reports[1].Item2.Neutral && pads.Reports[2].Item2.Neutral, "focus loss releases both pads");
        Reject(() => engine.Schedule("a", 2, "A", 100, 2000, false, 3000), "no replay after cancellation");
        engine.Schedule("c", 2, "A", 100, 2000, false, 3000); int before = pads.Reports.Count;
        engine.Tick(5100, true); Check(!engine.Busy && pads.Reports.Count == before + 2 && pads.Reports[before].Item2.Neutral, "expired input never sent");
        engine.Schedule("d", 2, "RB", 100, 2000, false, 6000); engine.Tick(8000, true); engine.Tick(8100, true);
        Check(!engine.Busy && pads.Reports[pads.Reports.Count - 1].Item2.Neutral, "duration releases buttons");
        engine.Schedule("e", 2, "A", 100, 2000, false, 9000); engine.Cancel("test"); Check(!engine.Busy, "cancel pending pulse");
        Check(GameWindow.Matches(GameWindow.FirstGame), "exact first-game executable");
        Check(!GameWindow.Matches(@"D:\Minecraft\Minecraft Dungeons II\Content\Dungeons\Binaries\WinGDK\Dungeons-WinGDK-Shipping.exe"), "reject sequel");
        Check(!GameWindow.Matches(@"C:\elsewhere\Dungeons.exe"), "reject same-name processes");
        Check(GameWindow.Matches(GameWindow.RegisteredGame), "verified WindowsApps alias");
        Check(!GameWindow.Matches(GameWindow.RegisteredGame.Replace("Microsoft.Lovika_", "Microsoft.Impostor_")), "reject unrelated package alias");
        Check(!GameWindow.Matches(GameWindow.RegisteredGame.Replace("1.17.0.0", "9.99.0.0")), "do not trust unverified package versions");
        Check(!GameWindow.Matches(GameWindow.RegisteredGame.Replace(@"Dungeons\Binaries\Win64\Dungeons.exe", "Dungeons.exe")), "reject package launcher path");
        Check(!GameWindow.Matches(null), "reject unreadable process path");
        FakePads rejected = new FakePads(); List<object> rejectionEvents = new List<object>(); PulseEngine rejectionEngine = new PulseEngine(rejected, rejectionEvents.Add);
        rejectionEngine.Schedule("diagnostic", 2, "LeftThumb", 200, 2000, false, 0);
        rejectionEngine.Tick(2000, false, new ForegroundInfo { processId = 123, executable = @"C:\elsewhere\Dungeons.exe", matched = false });
        string rejection = new JavaScriptSerializer().Serialize(rejectionEvents[rejectionEvents.Count - 1]);
        Check(!rejectionEngine.Busy && rejected.Reports.TrueForAll(r => r.Item2.Neutral) && rejection.Contains("foreground") && rejection.Contains("123") && rejection.Contains("elsewhere"), "rejection records actual window identity without input");
        FakePads accepted = new FakePads(); PulseEngine acceptedEngine = new PulseEngine(accepted, ignored => { });
        acceptedEngine.Schedule("alias", 2, "LeftThumb", 200, 2000, false, 0);
        acceptedEngine.Tick(2000, GameWindow.Matches(GameWindow.RegisteredGame));
        Check(accepted.Reports.Count == 1 && accepted.Reports[0].Item1 == 2 && accepted.Reports[0].Item2.Buttons == 0x40, "verified package alias permits only the requested LS on P2");
        acceptedEngine.Tick(2010, false, new ForegroundInfo { error = "read failed" });
        Check(!acceptedEngine.Busy && accepted.Reports[1].Item2.Neutral && accepted.Reports[2].Item2.Neutral, "identity read failure releases an active pulse");
        Console.WriteLine("{\"ok\":true,\"checks\":25,\"nativeDriverUsed\":false}"); return 0;
    }
}
