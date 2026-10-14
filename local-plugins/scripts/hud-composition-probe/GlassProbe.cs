// Isolated experiment; not included in the HUD plugin ZIP.
using System;
using System.Drawing;
using System.Numerics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using Windows.UI.Composition;
using Windows.UI.Composition.Desktop;

[ComImport, Guid("29E691FA-4567-4DCA-B319-D0F207EB6807"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ICompositorDesktopInterop {
    void CreateDesktopWindowTarget(IntPtr hwnd, [MarshalAs(UnmanagedType.Bool)] bool topmost, [MarshalAs(UnmanagedType.IUnknown)] out object target);
    void EnsureOnThread(uint threadId);
}

class GlassProbe : Form {
    class Pattern : Form {
        public Color Stripe = Color.FromArgb(255, 91, 138);
        protected override void OnPaint(PaintEventArgs e) {
            e.Graphics.Clear(Color.White);
            using (var brush = new SolidBrush(Stripe)) for (int x = 0; x < Width; x += 36) e.Graphics.FillRectangle(brush, x, 0, 18, Height);
        }
    }
    [StructLayout(LayoutKind.Sequential)] struct QueueOptions { public int size, threadType, apartmentType; }
    [DllImport("CoreMessaging.dll")] static extern int CreateDispatcherQueueController(QueueOptions options, out IntPtr controller);
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
    IntPtr queue;
    Compositor compositor;
    DesktopWindowTarget target;
    ContainerVisual root;
    SpriteVisual glass;
    CompositionRoundedRectangleGeometry geometry;
    float radius = 48;
    Pattern pattern;
    IntPtr overlayHandle;

    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams {
        get { var p = base.CreateParams; p.ExStyle |= 0x00200000 | 0x08000000 | 0x80 | 0x20; return p; }
    }
    protected override void OnPaintBackground(PaintEventArgs e) { }
    protected override void OnPaint(PaintEventArgs e) { }

    GlassProbe(string[] args) {
        FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; TopMost = true; Enabled = false;
        StartPosition = FormStartPosition.Manual;
        Bounds = new Rectangle(int.Parse(args[0]), int.Parse(args[1]), int.Parse(args[2]), int.Parse(args[3]));
        pattern = new Pattern { FormBorderStyle = FormBorderStyle.None, ShowInTaskbar = false, StartPosition = FormStartPosition.Manual, TopMost = true, Bounds = new Rectangle(Left - 60, Top - 60, Width + 120, Height + 120) };
        SetWindowPos(pattern.Handle, new IntPtr(-1), 0, 0, 0, 0, 0x53);
        var timeout = new System.Windows.Forms.Timer { Interval = 60000 };
        timeout.Tick += delegate { Close(); }; timeout.Start();
    }
    void InitializeGlass() {
        SetWindowPos(Handle, new IntPtr(-1), 0, 0, 0, 0, 0x53);
        Marshal.ThrowExceptionForHR(CreateDispatcherQueueController(new QueueOptions { size = 12, threadType = 2, apartmentType = 2 }, out queue));
        int enabled = 1, noCorners = 1;
        Marshal.ThrowExceptionForHR(DwmSetWindowAttribute(Handle, 17, ref enabled, 4));
        Marshal.ThrowExceptionForHR(DwmSetWindowAttribute(Handle, 33, ref noCorners, 4));
        compositor = new Compositor();
        object nativeTarget;
        ((ICompositorDesktopInterop)(object)compositor).CreateDesktopWindowTarget(Handle, true, out nativeTarget);
        target = (DesktopWindowTarget)nativeTarget;
        root = compositor.CreateContainerVisual(); target.Root = root;
        glass = compositor.CreateSpriteVisual(); glass.Brush = compositor.CreateHostBackdropBrush();
        root.Children.InsertAtTop(glass);
        geometry = compositor.CreateRoundedRectangleGeometry();
        root.Clip = compositor.CreateGeometricClip(geometry);
        LayoutGlass();
        Console.WriteLine("{\"ready\":true,\"handle\":\"" + Handle.ToInt64() + "\",\"focused\":" + (GetForegroundWindow() == Handle ? "true" : "false") + "}");
        new Thread(delegate() {
            string line;
            while ((line = Console.ReadLine()) != null) {
                var command = line;
                try { BeginInvoke(new Action(delegate { Apply(command); })); } catch (InvalidOperationException) { break; }
            }
        }) { IsBackground = true }.Start();
    }
    void LayoutGlass() {
        root.Size = glass.Size = geometry.Size = new Vector2(ClientSize.Width, ClientSize.Height);
        geometry.CornerRadius = new Vector2(Math.Min(radius, Math.Min(ClientSize.Width, ClientSize.Height) / 2));
    }
    void Apply(string command) {
        var parts = command.Split(' ');
        if (parts[0] == "quit") { Close(); return; }
        if (parts[0] == "radius") radius = float.Parse(parts[1], System.Globalization.CultureInfo.InvariantCulture);
        if (parts[0] == "size") Size = new Size(int.Parse(parts[1]), int.Parse(parts[2]));
        if (parts[0] == "move") Location = new Point(int.Parse(parts[1]), int.Parse(parts[2]));
        if (parts[0] == "clear") glass.IsVisible = false;
        if (parts[0] == "glass") glass.IsVisible = true;
        if (parts[0] == "blue") { pattern.Stripe = Color.FromArgb(82, 138, 255); pattern.Invalidate(); }
        if (parts[0] == "behind") overlayHandle = new IntPtr(long.Parse(parts[1]));
        SetWindowPos(pattern.Handle, new IntPtr(-1), 0, 0, 0, 0, 0x53);
        SetWindowPos(Handle, new IntPtr(-1), 0, 0, 0, 0, 0x53);
        if (overlayHandle != IntPtr.Zero) SetWindowPos(overlayHandle, new IntPtr(-1), 0, 0, 0, 0, 0x53);
        if (parts[0] == "capture") {
            using (var bitmap = new Bitmap(Width, Height)) {
                using (var graphics = Graphics.FromImage(bitmap)) graphics.CopyFromScreen(Location, Point.Empty, Size);
                bitmap.Save(System.IO.Path.Combine(AppDomain.CurrentDomain.BaseDirectory, parts[1] + ".png"), System.Drawing.Imaging.ImageFormat.Png);
            }
        }
        LayoutGlass();
        Console.WriteLine("{\"applied\":\"" + parts[0] + "\",\"focused\":" + (GetForegroundWindow() == Handle ? "true" : "false") + "}");
    }
    [STAThread] static void Main(string[] args) {
        try {
            SetProcessDpiAwarenessContext(new IntPtr(-4));
            Application.EnableVisualStyles();
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);
            var probe = new GlassProbe(args);
            probe.FormClosed += delegate { probe.pattern.Close(); Application.ExitThread(); };
            probe.InitializeGlass();
            Application.Run();
        } catch (Exception e) { Console.Error.WriteLine(e); Environment.ExitCode = 1; }
    }
}
