using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class AgentChatWindowsJob
{
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInformation
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
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInformation
    {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfo
    {
        public uint cb;
        public IntPtr lpReserved;
        public IntPtr lpDesktop;
        public IntPtr lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public ushort wShowWindow;
        public ushort cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(
        IntPtr job, int informationClass, ref ExtendedLimitInformation information, uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int standardHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DuplicateHandle(
        IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target,
        uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint options);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcessW(
        string application, StringBuilder commandLine, IntPtr processAttributes,
        IntPtr threadAttributes, [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
        uint creationFlags, IntPtr environment, string directory,
        ref StartupInfo startupInfo, out ProcessInformation processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    private static Win32Exception LastError(string operation)
    {
        int error = Marshal.GetLastWin32Error();
        return new Win32Exception(error, operation + " failed (Win32 error " + error + ")");
    }

    private static string QuoteArgument(string argument)
    {
        // Windows argv quoting: backslashes double only before a quote or
        // the closing delimiter. Quoting every argument also preserves "".
        StringBuilder result = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char character in argument)
        {
            if (character == '\\') backslashes++;
            else
            {
                result.Append('\\', character == '"' ? backslashes * 2 + 1 : backslashes);
                result.Append(character);
                backslashes = 0;
            }
        }
        result.Append('\\', backslashes * 2);
        return result.Append('"').ToString();
    }

    private static IntPtr InheritStandardHandle(int standardHandle)
    {
        IntPtr source = GetStdHandle(standardHandle);
        if (source == IntPtr.Zero || source == new IntPtr(-1))
            throw new InvalidOperationException("Missing standard handle " + standardHandle);
        IntPtr result;
        IntPtr current = GetCurrentProcess();
        if (!DuplicateHandle(current, source, current, out result, 0, true, 2))
            throw LastError("DuplicateHandle"); // DUPLICATE_SAME_ACCESS
        return result;
    }

    public static void Run(string command, string[] arguments)
    {
        StringBuilder commandLine = new StringBuilder(QuoteArgument(command));
        foreach (string argument in arguments ?? new string[0])
            commandLine.Append(' ').Append(QuoteArgument(argument));

        // No name and no security-attributes pointer: only this supervisor
        // owns the handle, and children cannot inherit it.
        IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw LastError("CreateJobObjectW");
        try
        {
            ExtendedLimitInformation limits = new ExtendedLimitInformation();
            // No breakaway flags. An ancestor that permits breakaway can let
            // nested libuv silent-breakaway jobs escape ordinary grandchildren.
            limits.BasicLimitInformation.LimitFlags = 0x00002000; // KILL_ON_JOB_CLOSE
            if (!SetInformationJobObject(job, 9, ref limits,
                (uint)Marshal.SizeOf(typeof(ExtendedLimitInformation))))
                throw LastError("SetInformationJobObject");
            // Establish ownership before starting any worker. Assigning an
            // already-running worker instead would leave a child-spawn race.
            if (!AssignProcessToJobObject(job, GetCurrentProcess()))
                throw LastError("AssignProcessToJobObject");
        }
        catch
        {
            CloseHandle(job); // Still empty if setup or assignment failed.
            throw;
        }

        // After self-assignment, keep the raw Job handle until process teardown.
        // Closing it in finally would kill this supervisor and mask its exit code.
        StartupInfo startup = new StartupInfo();
        startup.cb = (uint)Marshal.SizeOf(typeof(StartupInfo));
        startup.dwFlags = 0x00000100; // STARTF_USESTDHANDLES
        ProcessInformation child = new ProcessInformation();
        try
        {
            startup.hStdInput = InheritStandardHandle(-10);
            startup.hStdOutput = InheritStandardHandle(-11);
            startup.hStdError = InheritStandardHandle(-12);
            // A null application name preserves Windows executable PATH lookup.
            // Raw inherited pipes bypass PowerShell text decoding and pipelines.
            if (!CreateProcessW(null, commandLine, IntPtr.Zero, IntPtr.Zero, true,
                0x08000000, IntPtr.Zero, null, ref startup, out child)) // CREATE_NO_WINDOW
                throw LastError("CreateProcessW");
        }
        finally
        {
            if (startup.hStdInput != IntPtr.Zero) CloseHandle(startup.hStdInput);
            if (startup.hStdOutput != IntPtr.Zero) CloseHandle(startup.hStdOutput);
            if (startup.hStdError != IntPtr.Zero) CloseHandle(startup.hStdError);
        }

        uint exitCode;
        try
        {
            if (WaitForSingleObject(child.hProcess, 0xffffffff) != 0)
                throw LastError("WaitForSingleObject");
            if (!GetExitCodeProcess(child.hProcess, out exitCode))
                throw LastError("GetExitCodeProcess");
        }
        finally
        {
            CloseHandle(child.hThread);
            CloseHandle(child.hProcess);
        }
        Environment.Exit(unchecked((int)exitCode));
    }
}
