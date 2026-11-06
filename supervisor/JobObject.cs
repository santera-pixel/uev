using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace UEVSupervisor;

internal static class NativeMethods
{
    internal const uint CreateSuspended = 0x00000004;
    internal const uint CreateNewProcessGroup = 0x00000200;

    internal const uint JobObjectLimitProcessMemory = 0x00000100;
    internal const uint JobObjectLimitJobMemory = 0x00000200;
    internal const uint JobObjectLimitActiveProcess = 0x00000008;
    internal const uint JobObjectLimitKillOnJobClose = 0x00002000;

    internal const int JobObjectExtendedLimitInformation = 9;
    internal const uint Infinite = 0xFFFFFFFF;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal struct StartupInfo
    {
        public int cb;
        public string? lpReserved;
        public string? lpDesktop;
        public string? lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct ProcessInformation
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct JobObjectBasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct JobObjectExtendedLimitInfo
    {
        public JobObjectBasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    internal static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string? lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool SetInformationJobObject(
        IntPtr hJob,
        int jobObjectInformationClass,
        IntPtr lpJobObjectInformation,
        uint cbJobObjectInformationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    internal static extern bool CreateProcess(
        string? lpApplicationName,
        StringBuilder lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string? lpCurrentDirectory,
        ref StartupInfo lpStartupInfo,
        out ProcessInformation lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern uint ResumeThread(IntPtr hThread);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool TerminateJobObject(IntPtr hJob, uint uExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool CloseHandle(IntPtr hObject);
}

internal sealed class JobObject : IDisposable
{
    private readonly object _sync = new();
    private IntPtr _job;
    private IntPtr _process;
    private volatile bool _hasExited;
    private bool _disposed;

    public int ProcessMemoryMb { get; }
    public int JobMemoryMb { get; }
    public int MaxProcesses { get; }
    public bool KillOnClose { get; }
    public int ProcessId { get; private set; }
    public bool HasExited => _hasExited;

    public event Action<int>? ProcessExited;

    public JobObject(int processMemoryMb, int jobMemoryMb, int maxProcesses, bool killOnClose)
    {
        ProcessMemoryMb = processMemoryMb;
        JobMemoryMb = jobMemoryMb;
        MaxProcesses = maxProcesses;
        KillOnClose = killOnClose;

        _job = NativeMethods.CreateJobObject(IntPtr.Zero, null);
        if (_job == IntPtr.Zero)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject failed");
        }

        var info = new NativeMethods.JobObjectExtendedLimitInfo();
        info.BasicLimitInformation.LimitFlags =
            NativeMethods.JobObjectLimitProcessMemory |
            NativeMethods.JobObjectLimitJobMemory |
            NativeMethods.JobObjectLimitActiveProcess |
            (killOnClose ? NativeMethods.JobObjectLimitKillOnJobClose : 0);
        info.ProcessMemoryLimit = (UIntPtr)((ulong)processMemoryMb * 1024 * 1024);
        info.JobMemoryLimit = (UIntPtr)((ulong)jobMemoryMb * 1024 * 1024);
        info.BasicLimitInformation.ActiveProcessLimit = (uint)maxProcesses;

        var size = Marshal.SizeOf<NativeMethods.JobObjectExtendedLimitInfo>();
        var pointer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(info, pointer, false);
            if (!NativeMethods.SetInformationJobObject(
                    _job,
                    NativeMethods.JobObjectExtendedLimitInformation,
                    pointer,
                    (uint)size))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "SetInformationJobObject failed");
            }
        }
        finally
        {
            Marshal.FreeHGlobal(pointer);
        }
    }

    public void Launch(string executablePath, string? projectPath, string extraArgs)
    {
        if (!File.Exists(executablePath))
        {
            throw new FileNotFoundException("Child executable not found", executablePath);
        }

        if (!string.IsNullOrWhiteSpace(projectPath) && !File.Exists(projectPath))
        {
            throw new FileNotFoundException("Project file not found", projectPath);
        }

        // A crash-restart relaunches into the same job object; drop the dead handle first.
        ReleaseChild();

        var commandLine = new StringBuilder();
        commandLine.Append('"').Append(executablePath).Append('"');
        if (!string.IsNullOrWhiteSpace(projectPath))
        {
            commandLine.Append(" \"").Append(projectPath).Append('"');
        }
        if (!string.IsNullOrWhiteSpace(extraArgs))
        {
            commandLine.Append(' ').Append(extraArgs);
        }

        var startupInfo = new NativeMethods.StartupInfo
        {
            cb = Marshal.SizeOf<NativeMethods.StartupInfo>(),
        };
        var workingDirectory = !string.IsNullOrWhiteSpace(projectPath)
            ? Path.GetDirectoryName(projectPath)
            : Path.GetDirectoryName(executablePath);

        if (!NativeMethods.CreateProcess(
                executablePath,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                false,
                NativeMethods.CreateSuspended | NativeMethods.CreateNewProcessGroup,
                IntPtr.Zero,
                workingDirectory,
                ref startupInfo,
                out var processInformation))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcess failed");
        }

        try
        {
            if (!NativeMethods.AssignProcessToJobObject(_job, processInformation.hProcess))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "AssignProcessToJobObject failed");
            }

            if (NativeMethods.ResumeThread(processInformation.hThread) == uint.MaxValue)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "ResumeThread failed");
            }
        }
        catch
        {
            NativeMethods.TerminateProcess(processInformation.hProcess, 1);
            NativeMethods.CloseHandle(processInformation.hThread);
            NativeMethods.CloseHandle(processInformation.hProcess);
            throw;
        }

        NativeMethods.CloseHandle(processInformation.hThread);
        _process = processInformation.hProcess;
        ProcessId = processInformation.dwProcessId;

        var childHandle = processInformation.hProcess;
        _ = Task.Run(() => WaitForExit(childHandle));
    }

    public void AssignProcess(Process process)
    {
        lock (_sync)
        {
            if (_job == IntPtr.Zero)
            {
                throw new ObjectDisposedException(nameof(JobObject));
            }

            if (!NativeMethods.AssignProcessToJobObject(_job, process.Handle))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "AssignProcessToJobObject failed for control API process");
            }
        }
    }

    public void Terminate()
    {
        lock (_sync)
        {
            if (_job == IntPtr.Zero)
            {
                return;
            }

            NativeMethods.TerminateJobObject(_job, 1);
        }
    }

    /// <summary>Forget the previous child so a relaunch starts from a clean state.</summary>
    public void ResetChild()
    {
        ReleaseChild();
    }

    private void ReleaseChild()
    {
        lock (_sync)
        {
            if (_process != IntPtr.Zero)
            {
                NativeMethods.CloseHandle(_process);
                _process = IntPtr.Zero;
            }

            _hasExited = false;
        }
    }

    private void WaitForExit(IntPtr processHandle)
    {
        NativeMethods.WaitForSingleObject(processHandle, NativeMethods.Infinite);
        NativeMethods.GetExitCodeProcess(processHandle, out var exitCode);
        _hasExited = true;
        ProcessExited?.Invoke((int)exitCode);
    }

    public void Dispose()
    {
        lock (_sync)
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;
            if (_process != IntPtr.Zero)
            {
                NativeMethods.CloseHandle(_process);
                _process = IntPtr.Zero;
            }

            if (_job != IntPtr.Zero)
            {
                NativeMethods.CloseHandle(_job);
                _job = IntPtr.Zero;
            }
        }
    }
}
