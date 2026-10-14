using System;
using System.Numerics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Collections.Concurrent;
using System.Windows.Forms;
using Windows.Graphics.Effects;
using Windows.UI.Composition;
using Windows.UI.Composition.Desktop;

[ComImport, Guid("29E691FA-4567-4DCA-B319-D0F207EB6807"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ICompositorDesktopInterop {
    void CreateDesktopWindowTarget(IntPtr hwnd, [MarshalAs(UnmanagedType.Bool)] bool topmost, [MarshalAs(UnmanagedType.IUnknown)] out object target);
    void EnsureOnThread(uint threadId);
}
[ComImport, Guid("2FC57384-A068-44D7-A331-30982FCF7177"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IGraphicsEffectD2D1Interop {
    Guid GetEffectId();
    void GetNamedPropertyMapping([MarshalAs(UnmanagedType.LPWStr)] string name, out uint index, out uint mapping);
    uint GetPropertyCount();
    IntPtr GetProperty(uint index);
    IGraphicsEffectSource GetSource(uint index);
    uint GetSourceCount();
}
[ComImport, Guid("629BDBC8-D932-4FF4-96B9-8D96C5C1E858"), InterfaceType(ComInterfaceType.InterfaceIsIInspectable)]
interface IPropertyValueStatics {
    IntPtr CreateEmpty();
    IntPtr CreateUInt8(byte value);
    IntPtr CreateInt16(short value);
    IntPtr CreateUInt16(ushort value);
    IntPtr CreateInt32(int value);
    IntPtr CreateUInt32(uint value);
    IntPtr CreateInt64(long value);
    IntPtr CreateUInt64(ulong value);
    IntPtr CreateSingle(float value);
}
// Describe the built-in Direct2D blur without adding a Win2D dependency.
[ComVisible(true)]
public class BackdropBlur : IGraphicsEffect, IGraphicsEffectSource, IGraphicsEffectD2D1Interop {
    public string Name { get; set; }
    readonly IGraphicsEffectSource source = new CompositionEffectSourceParameter("backdrop");
    readonly IPropertyValueStatics values = (IPropertyValueStatics)System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeMarshal.GetActivationFactory(typeof(Windows.Foundation.PropertyValue));
    public Guid GetEffectId() { return new Guid("1FEB6D69-2FE6-4AC9-8C58-1D7F93E7A6A5"); }
    public void GetNamedPropertyMapping(string name, out uint index, out uint mapping) {
        if (name != "BlurAmount") throw new ArgumentException("Unknown blur property");
        index = 0; mapping = 1;
    }
    public uint GetPropertyCount() { return 3; }
    public IntPtr GetProperty(uint index) {
        // Keep IPropertyValue boxed: the .NET projection otherwise unboxes it,
        // returning IInspectable where the native effect expects IPropertyValue.
        if (index == 0) return values.CreateSingle(24);
        if (index == 1 || index == 2) return values.CreateUInt32(1);
        throw new ArgumentOutOfRangeException("index");
    }
    public IGraphicsEffectSource GetSource(uint index) {
        if (index != 0) throw new ArgumentOutOfRangeException("index");
        return source;
    }
    public uint GetSourceCount() { return 1; }
}
// Drawing/sampling HWND: no activation, input controls, image storage or model access.
class GlassHost : NativeWindow {
    [StructLayout(LayoutKind.Sequential)] struct QueueOptions { public int size, threadType, apartmentType; }
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int left, top, right, bottom; }
    [StructLayout(LayoutKind.Sequential)] struct PowerStatus { public byte ac, batteryFlag, batteryPercent, saver; public uint life, fullLife; }
    [DllImport("kernel32.dll")] static extern bool GetSystemPowerStatus(out PowerStatus status);
    [DllImport("CoreMessaging.dll")] static extern int CreateDispatcherQueueController(QueueOptions options, out IntPtr controller);
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool EnableWindow(IntPtr hwnd, bool enabled);
    [DllImport("user32.dll")] static extern bool SetLayeredWindowAttributes(IntPtr hwnd, uint color, byte alpha, uint flags);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, int message, IntPtr w, IntPtr l);
    readonly ConcurrentQueue<string> commands = new ConcurrentQueue<string>();
    readonly IntPtr owner;
    readonly bool drawing;
    IntPtr queue;
    Compositor compositor;
    DesktopWindowTarget target;
    SpriteVisual glass;
    CompositionEffectFactory blurFactory;
    CompositionEffectBrush blurBrush;
    CompositionBackdropBrush backdrop;
    CompositionRoundedRectangleGeometry geometry;
    System.Windows.Forms.Timer timer;
    float radius = 24, logicalWidth = 408, logicalHeight = 118;
    float originX, originY, canvasWidth, sampleWidth = 408, zoom = 1;
    Rect previousRect;
    int boundsUpdates;
    bool padded;
    DateTime nextSample;
    bool visible;
    bool? powerPaused;
    GlassHost(IntPtr overlay, bool draw) {
        owner = overlay; drawing = draw;
        // Create in the topmost group: inserting after a topmost HUD alone does
        // not reliably promote this disabled window above other applications.
        // WS_POPUP | WS_DISABLED; NOREDIRECTIONBITMAP | NOACTIVATE | TOOLWINDOW | LAYERED | TRANSPARENT | TOPMOST.
        CreateHandle(new CreateParams { Caption = "Cyrene HUD Glass", Style = unchecked((int)0x88000000), ExStyle = 0x082800A8, Width = 1, Height = 1 });
        EnableWindow(Handle, false);
        SetLayeredWindowAttributes(Handle, 0, 255, 2);
        if (drawing) {
        Marshal.ThrowExceptionForHR(CreateDispatcherQueueController(new QueueOptions { size = 12, threadType = 2, apartmentType = 2 }, out queue));
        int enabled = 1, noCorners = 1;
        Marshal.ThrowExceptionForHR(DwmSetWindowAttribute(Handle, 17, ref enabled, 4));
        Marshal.ThrowExceptionForHR(DwmSetWindowAttribute(Handle, 33, ref noCorners, 4));
        compositor = new Compositor();
        object nativeTarget;
        ((ICompositorDesktopInterop)(object)compositor).CreateDesktopWindowTarget(Handle, true, out nativeTarget);
        target = (DesktopWindowTarget)nativeTarget;
        blurFactory = compositor.CreateEffectFactory(new BackdropBlur { Name = "BackdropBlur" });
        blurBrush = blurFactory.CreateBrush(); backdrop = compositor.CreateBackdropBrush();
        blurBrush.SetSourceParameter("backdrop", backdrop);
        glass = compositor.CreateSpriteVisual(); glass.Brush = blurBrush;
        geometry = compositor.CreateRoundedRectangleGeometry(); glass.Clip = compositor.CreateGeometricClip(geometry); target.Root = glass;
        }
        timer = new System.Windows.Forms.Timer { Interval = 100 }; timer.Tick += delegate { Sync(); }; timer.Start();
        Console.WriteLine("{\"ready\":true,\"handle\":\"" + Handle.ToInt64() + "\",\"focused\":" + (GetForegroundWindow() == Handle ? "true" : "false") + "}");
        new Thread(delegate() {
            string line;
            while ((line = Console.ReadLine()) != null) { commands.Enqueue(line); PostMessage(Handle, 0x8001, IntPtr.Zero, IntPtr.Zero); }
            commands.Enqueue("quit"); PostMessage(Handle, 0x8001, IntPtr.Zero, IntPtr.Zero);
        }) { IsBackground = true }.Start();
    }
    void Sync() {
        if (!IsWindow(owner)) { Stop(); return; }
        PowerStatus power;
        if (GetSystemPowerStatus(out power) && powerPaused != (power.saver == 1)) {
            powerPaused = power.saver == 1;
            Console.WriteLine("{\"powerPaused\":" + (powerPaused.Value ? "true" : "false") + "}");
        }
        if (!IsWindowVisible(owner) || IsIconic(owner)) { if (visible) ShowWindow(Handle, 0); visible = false; return; }
        Rect rect;
        if (!GetWindowRect(owner, out rect)) return;
        int width = rect.right - rect.left, height = rect.bottom - rect.top;
        if (width <= 0 || height <= 0) return;
        double scale = canvasWidth > 0 ? width / (double)canvasWidth * zoom : width / (logicalWidth + (padded ? 32 : 0));
        float leftOffset = canvasWidth > 0 ? (float)(originX * scale) : 0;
        float topOffset = canvasWidth > 0 ? (float)(originY * scale) : 0;
        float cardWidth = canvasWidth > 0 ? (float)(logicalWidth * scale) : width;
        float cardHeight = canvasWidth > 0 ? (float)(logicalHeight * scale) : height;
        if (drawing && powerPaused != true) {
        var offset = new Vector3(leftOffset, topOffset, 0);
        var size = new Vector2(cardWidth, cardHeight);
        var corners = new Vector2(Math.Min(radius * (float)scale, Math.Min(cardWidth, cardHeight) / 2f));
        if (glass.Offset != offset) glass.Offset = offset;
        if (glass.Size != size) glass.Size = geometry.Size = size;
        if (geometry.CornerRadius != corners) geometry.CornerRadius = corners;
        // Place directly below the HUD in the topmost group without activating either window.
        bool changed = previousRect.left != rect.left || previousRect.top != rect.top || previousRect.right != rect.right || previousRect.bottom != rect.bottom;
        // Avoid repeatedly invalidating the backdrop for an unchanged HWND pair.
        if (changed || !IsWindowVisible(Handle) || GetWindow(Handle, 3) != owner)
            SetWindowPos(Handle, owner, rect.left, rect.top, width, height, changed ? 0x50u : 0x53u);
        if (changed) { previousRect = rect; boundsUpdates++; }
        } else if (drawing && visible) {
            ShowWindow(Handle, 0);
        }
        visible = true;
        if (DateTime.UtcNow < nextSample) return;
        nextSample = DateTime.UtcNow.AddSeconds(1);
        // Ask Electron to recover only when its topmost flag was lost or a
        // visible peer actually covers the card, rather than raising every second.
        bool needsRaise = (GetWindowLongPtr(owner, -20).ToInt64() & 8) == 0;
        for (IntPtr above = GetWindow(owner, 3); !needsRaise && above != IntPtr.Zero; above = GetWindow(above, 3)) {
            Rect peer;
            if (above != Handle && IsWindowVisible(above) && !IsIconic(above) && (GetWindowLongPtr(above, -20).ToInt64() & 8) != 0 && GetWindowRect(above, out peer))
                needsRaise = peer.right > rect.left + leftOffset && peer.left < rect.left + leftOffset + cardWidth && peer.bottom > rect.top + topOffset && peer.top < rect.top + topOffset + cardHeight;
        }
        if (needsRaise) Console.WriteLine("{\"needsRaise\":true}");
        // Sample blank top/bottom strips of the collapsed card. Expansion never
        // moves these points into another part of the background or the content.
        int left = rect.left + (int)(canvasWidth > 0 ? leftOffset : (padded ? 16 : 0) * scale);
        int top = rect.top + (int)(canvasWidth > 0 ? topOffset : (padded ? 21 : 0) * scale);
        double sum = 0; int count = 0;
        try {
          using (var pixels = new System.Drawing.Bitmap(18, 1)) using (var capture = System.Drawing.Graphics.FromImage(pixels)) {
            double edge = Math.Min(4, logicalHeight * .2);
            for (int column = 0; column < 9; column++) foreach (double y in new double[] { edge, logicalHeight - edge }) {
                // Keep clear of rounded corners even in a one-ring layout.
                double margin = Math.Min(sampleWidth / 2 - 2, Math.Max(32, sampleWidth * .2));
                double x = margin + (sampleWidth - margin * 2) * column / 8;
                capture.CopyFromScreen(left + (int)(x * scale), top + (int)(y * scale), count, 0, new System.Drawing.Size(1, 1));
                var color = pixels.GetPixel(count, 0);
                sum += color.R * .2126 + color.G * .7152 + color.B * .0722; count++;
            }
          }
        } catch (System.ComponentModel.Win32Exception) { return; }
        if (count > 0) Console.WriteLine("{\"luminance\":" + Math.Round(sum / count).ToString(System.Globalization.CultureInfo.InvariantCulture) + ",\"sampleLeft\":" + left + ",\"sampleTop\":" + top + ",\"sampleWidth\":" + Math.Round(sampleWidth * scale).ToString(System.Globalization.CultureInfo.InvariantCulture) + "}");
    }
    void Stop() {
        timer.Stop(); timer.Dispose();
        if (drawing) { target.Dispose(); glass.Dispose(); geometry.Dispose(); blurBrush.Dispose(); backdrop.Dispose(); blurFactory.Dispose(); compositor.Dispose(); }
        if (queue != IntPtr.Zero) Marshal.Release(queue);
        DestroyHandle(); Application.ExitThread();
    }
    protected override void WndProc(ref Message message) {
        if (message.Msg == 0x21) { message.Result = new IntPtr(3); return; } // MA_NOACTIVATE
        if (message.Msg == 0x84) { message.Result = new IntPtr(-1); return; } // HTTRANSPARENT
        if (message.Msg == 0x8001) {
            string command;
            bool updated = false;
            while (commands.TryDequeue(out command)) {
                if (command == "quit") { Stop(); return; }
                var parts = command.Split(' ');
                if ((parts.Length == 5 || parts.Length == 9 || parts.Length == 10) && parts[0] == "style") {
                    radius = Math.Max(0, Math.Min(160, float.Parse(parts[1], System.Globalization.CultureInfo.InvariantCulture)));
                    logicalWidth = Math.Max(24, Math.Min(2000, float.Parse(parts[2], System.Globalization.CultureInfo.InvariantCulture)));
                    logicalHeight = Math.Max(6, Math.Min(320, float.Parse(parts[3], System.Globalization.CultureInfo.InvariantCulture)));
                    padded = parts[4] == "clear";
                    canvasWidth = parts.Length >= 9 ? float.Parse(parts[7], System.Globalization.CultureInfo.InvariantCulture) : 0;
                    sampleWidth = parts.Length == 10 ? Math.Max(24, Math.Min(2000, float.Parse(parts[9], System.Globalization.CultureInfo.InvariantCulture))) : logicalWidth;
                    if (canvasWidth > 0) {
                        originX = float.Parse(parts[5], System.Globalization.CultureInfo.InvariantCulture);
                        originY = float.Parse(parts[6], System.Globalization.CultureInfo.InvariantCulture);
                        zoom = float.Parse(parts[8], System.Globalization.CultureInfo.InvariantCulture);
                    }
                    updated = true;
                }
            }
            // Pending style frames share the owner's latest rectangle. Apply
            // only the newest style to avoid replaying stale corner geometry.
            if (updated) {
                Sync();
                Console.WriteLine("{\"synced\":true,\"visible\":" + (visible ? "true" : "false") + ",\"focused\":" + (GetForegroundWindow() == Handle ? "true" : "false") + ",\"boundsUpdates\":" + boundsUpdates + "}");
            }
            return;
        }
        base.WndProc(ref message);
    }
    [STAThread] static void Main(string[] args) {
        try {
            SetProcessDpiAwarenessContext(new IntPtr(-4));
            var host = new GlassHost(new IntPtr(long.Parse(args[0])), args.Length < 2 || args[1] != "--sample-only");
            Application.Run(); GC.KeepAlive(host);
        } catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
    }
}
