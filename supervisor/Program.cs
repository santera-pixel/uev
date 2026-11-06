using System.Diagnostics;

namespace UEVSupervisor;

internal static class Program
{
    /// <summary>How long to wait for a crashed editor process to fully disappear before relaunching.</summary>
    private static readonly TimeSpan EditorExitWait = TimeSpan.FromSeconds(45);

    private static async Task<int> Main(string[] args)
    {
        Options options;
        try
        {
            options = Options.Parse(args);
        }
        catch (ArgumentException exception)
        {
            Console.Error.WriteLine(exception.Message);
            Console.Error.WriteLine();
            Options.PrintUsage();
            return 1;
        }

        if (options.ShowHelp)
        {
            Options.PrintUsage();
            return 0;
        }

        if (options.ControlApiEnabled)
        {
            if (string.IsNullOrWhiteSpace(options.McpEntryPath))
            {
                Console.Error.WriteLine("--control-api requires --mcp-entry <path to mcp-fork\\dist\\bin.js>.");
                return 1;
            }

            if (!File.Exists(options.McpEntryPath))
            {
                Console.Error.WriteLine($"MCP control API entry not found: {options.McpEntryPath}");
                return 1;
            }
        }

        if (options.IsEditorLaunch)
        {
            var existingEditors = Process.GetProcessesByName("UE4Editor");
            if (existingEditors.Length > 0)
            {
                Console.Error.WriteLine("UE4Editor is already running. Close it before launching the supervisor.");
                return 1;
            }
        }

        var logPath = options.LogPath ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "UEV",
            "logs",
            $"supervisor-{DateTime.Now:yyyyMMdd-HHmmss}.log");

        using var log = new SupervisorLog(logPath);
        using var job = new JobObject(
            options.ProcessMemoryMb,
            options.JobMemoryMb,
            options.MaxProcesses,
            options.KillOnClose);

        log.Write("UEV supervisor starting");
        log.Write($"log: {log.Path}");
        log.Write(
            $"limits: process={options.ProcessMemoryMb}MB job={options.JobMemoryMb}MB processes={options.MaxProcesses} killOnClose={options.KillOnClose}");
        log.Write(
            $"watchdog: restartOnCrash={options.RestartOnCrash} maxRestarts={options.MaxRestarts} delayMs={options.RestartDelayMs} windowSeconds={options.RestartWindowSeconds}");
        var crashDir = CrashReportLocator.CrashesDirectory(options.ProjectPath);
        if (crashDir != null)
        {
            log.Write($"crash reports: {crashDir}");
        }

        var server = new SupervisorServer(
            options.PipeName,
            job,
            log,
            options.GraceMs,
            options.HeartbeatTimeoutMs,
            options.RestartOnCrash,
            options.MaxRestarts);

        var pendingExit = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
        job.ProcessExited += code =>
        {
            log.Write($"child exited code={code}");
            Volatile.Read(ref pendingExit).TrySetResult(code);
        };

        server.Start();

        using var controlApi = options.ControlApiEnabled ? new ControlApiHost(options, log) : null;
        controlApi?.Start();

        log.Write($"pipe: \\\\.\\pipe\\{options.PipeName}");
        log.Write("commands: panic, status, quit");

        Console.CancelKeyPress += (_, eventArgs) =>
        {
            eventArgs.Cancel = true;
            log.Write("Ctrl+C received; terminating child job");
            job.Terminate();
        };

        _ = Task.Run(() =>
        {
            while (true)
            {
                string? line;
                try
                {
                    line = Console.ReadLine();
                }
                catch
                {
                    return;
                }

                if (line == null)
                {
                    return;
                }

                switch (line.Trim().ToLowerInvariant())
                {
                    case "panic":
                        server.Panic("console panic");
                        break;
                    case "status":
                        log.Write(server.GetStatusText());
                        break;
                    case "quit":
                        server.Panic("console quit");
                        break;
                    case "help":
                        Options.PrintUsage();
                        break;
                }
            }
        });

        var restartTimes = new Queue<DateTime>();
        var restartCount = 0;
        var exitCode = 0;

        while (true)
        {
            try
            {
                job.Launch(options.EditorPath, options.ProjectPath, options.ChildArgs);
            }
            catch (Exception exception)
            {
                log.Write($"launch failed: {exception.Message}");
                server.Stop();
                controlApi?.Stop();
                return 1;
            }

            log.Write($"child started pid={job.ProcessId} path={options.EditorPath}");
            if (options.IsEditorLaunch)
            {
                log.Write($"project: {options.ProjectPath}");
            }

            exitCode = await pendingExit.Task;

            if (server.IsKilled || exitCode == 0 || !options.RestartOnCrash)
            {
                break;
            }

            var now = DateTime.UtcNow;
            while (restartTimes.Count > 0 && (now - restartTimes.Peek()).TotalSeconds > options.RestartWindowSeconds)
            {
                restartTimes.Dequeue();
            }

            if (restartCount >= options.MaxRestarts || restartTimes.Count >= options.MaxRestarts)
            {
                log.Write(
                    $"watchdog: crash restart budget exhausted ({restartCount} restarts, {restartTimes.Count} inside {options.RestartWindowSeconds}s); giving up");
                break;
            }

            restartCount++;
            restartTimes.Enqueue(now);
            var crashPath = CrashReportLocator.Newest(options.ProjectPath);
            var crashDetail = CrashReportLocator.Describe(crashPath);
            log.Write(
                $"watchdog: crash detected (child exit={exitCode}); restart {restartCount}/{options.MaxRestarts} in {options.RestartDelayMs}ms");
            log.Write(crashDetail == null
                ? "watchdog: no crash report found; the child did not write one"
                : $"watchdog: crash report {crashDetail}");
            server.RecordRestart(exitCode, crashPath, restartCount);

            await Task.Delay(options.RestartDelayMs);

            if (options.IsEditorLaunch && !await WaitForEditorExitAsync(log))
            {
                log.Write("watchdog: a UE4Editor process is still running; not restarting");
                break;
            }

            job.ResetChild();
            server.ResetForRestart();
            pendingExit = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
        }

        server.Stop();
        controlApi?.Stop();
        log.Write(
            $"supervisor stopping; child exit code={exitCode}; killed={server.IsKilled}; reason={server.ShutdownReason ?? "n/a"}; restarts={restartCount}");
        return server.IsKilled ? 2 : 0;
    }

    /// <summary>Wait until no UE4Editor process remains, so the relaunch does not trip the crash guard.</summary>
    private static async Task<bool> WaitForEditorExitAsync(SupervisorLog log)
    {
        var deadline = DateTime.UtcNow + EditorExitWait;
        while (DateTime.UtcNow < deadline)
        {
            var remaining = Process.GetProcessesByName("UE4Editor");
            if (remaining.Length == 0)
            {
                return true;
            }

            log.Write($"watchdog: waiting for {remaining.Length} leftover UE4Editor process(es) to exit");
            foreach (var process in remaining)
            {
                process.Dispose();
            }

            await Task.Delay(2000);
        }

        return Process.GetProcessesByName("UE4Editor").Length == 0;
    }
}
