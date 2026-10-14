using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

// Fixed ASUS DSTS temperature/fan queries only; no device settings or CLI endpoints.
class AsusSensors {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool DeviceIoControl(SafeFileHandle device, uint code, byte[] input, uint inputLength, byte[] output, uint outputLength, out uint returned, IntPtr overlapped);

    static int? Query(SafeFileHandle device, uint endpoint) {
        var input = new byte[16];
        BitConverter.GetBytes(0x53545344u).CopyTo(input, 0);
        BitConverter.GetBytes(8u).CopyTo(input, 4);
        BitConverter.GetBytes(endpoint).CopyTo(input, 8);
        var output = new byte[16];
        uint returned;
        if (DeviceIoControl(device, 0x0022240C, input, 16, output, 16, out returned, IntPtr.Zero) && returned >= 4) {
            return BitConverter.ToInt32(output, 0) - 65536;
        }
        return null;
    }
    static int? Fan(SafeFileHandle device, uint endpoint) {
        var value = Query(device, endpoint);
        if (!value.HasValue) return null;
        int speed = value.Value & 0xFFFF;
        return speed <= 120 && (speed != 0 || value.Value >= 0) ? (int?)(speed * 100) : null;
    }
    static string Json(int? value) { return value.HasValue ? value.Value.ToString() : "null"; }
    static void Main() {
        int? temperature = null, cpuFan = null, gpuFan = null, midFan = null;
        using (var device = CreateFile(@"\\.\ATKACPI", 0xC0000000, 3, IntPtr.Zero, 3, 0x80, IntPtr.Zero)) {
            if (!device.IsInvalid) {
                var value = Query(device, 0x00120094);
                if (value.HasValue && value.Value > 0 && value.Value <= 125) temperature = value;
                cpuFan = Fan(device, 0x00110013);
                gpuFan = Fan(device, 0x00110014);
                midFan = Fan(device, 0x00110031);
            }
        }
        Console.WriteLine("{\"temperature\":" + Json(temperature) + ",\"cpuFanRpm\":" + Json(cpuFan) + ",\"gpuFanRpm\":" + Json(gpuFan) + ",\"midFanRpm\":" + Json(midFan) + "}");
    }
}
