using System.Diagnostics;

namespace UEVSupervisor;

internal sealed class ControlApiHost : IDisposable
{
    private readonly Options _options;
    private readonly SupervisorLog _log;
    private readonly SupervisorLog _apiLog;
    private readonly object _sync = new();
    private Process? _process;
    private JobObject? _job;
    private bool _stopping;
    private bool _restartScheduled;
    private int _restartCount;

    public ControlApiHost(Options options, SupervisorLog log)
    {
        _options = options;
        _log = log;
        var directory = Path.GetDirectoryName(log.Path) ?? Path.GetTempPath();
        _apiLog = new SupervisorLog(Path.Combine(directory, "control-api.log"));
    }

    public void Start()
    {
        lock (_sync)
        {
            if (_stopping)
            {
                return;
            }

            StartProcessLocked();
        }
    }

    private void StartProcessLocked()
    {
        Process? process = null;
        JobObject? job = null;

        try
        {
            if (!File.Exists(_options.McpEntryPath))
            {
                throw new FileNotFoundException("MCP control API entry not found", _options.McpEntryPath);
            }

            var nodePath = ResolveNode();
            var startInfo = new ProcessStartInfo
            {
                FileName = nodePath,
                Arguments = $"\"{_options.McpEntryPath}\" --control",
                WorkingDirectory = Path.GetDirectoryName(_options.McpEntryPath) ?? Environment.CurrentDirectory,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            };
            var pipePath = $@"\\.\pipe\{_options.PipeName}";
            startInfo.Environment["UEV_PROFILE"] = _options.McpProfile;
            startInfo.Environment["UEV_BIND_ADDRESS"] = "127.0.0.1";
            startInfo.Environment["UEV_COMMAND_ADDRESS"] = "127.0.0.1";
            startInfo.Environment["UEV_MULTICAST_TTL"] = "0";
            startInfo.Environment["UEV_SUPERVISOR_PIPE"] = pipePath;
            startInfo.Environment["UEV_CONTROL_PORT"] = _options.ControlPort.ToString();

            process = new Process
            {
                StartInfo = startInfo,
                EnableRaisingEvents = true,
            };
            process.OutputDataReceived += (_, args) =>
            {
                if (!string.IsNullOrWhiteSpace(args.Data))
                {
                    _apiLog.Write($"stdout: {args.Data}");
                }
            };
            process.ErrorDataReceived += (_, args) =>
            {
                if (!string.IsNullOrWhiteSpace(args.Data))
                {
                    _apiLog.Write($"stderr: {args.Data}");
                }
            };
            process.Exited += (_, _) => OnProcessExited(process);

            if (!process.Start())
            {
                throw new InvalidOperationException("Process.Start returned false.");
            }

            process.BeginOutputReadLine();
            process.BeginErrorReadLine();

            job = new JobObject(
                _options.ProcessMemoryMb,
                _options.JobMemoryMb,
                _options.MaxProcesses,
                killOnClose: true);
            job.AssignProcess(process);

            _job?.Dispose();
            _job = job;
            _process = process;
            _log.Write(
                $"control API started pid={process.Id} entry={_options.McpEntryPath} profile={_options.McpProfile} port={_options.ControlPort}");
        }
        catch (Exception exception)
        {
            _log.Write($"control API start failed: {exception.Message}");
            try
            {
                process?.Kill(entireProcessTree: true);
            }
            catch
            {
                // ignored
            }

            process?.Dispose();
            job?.Dispose();
            ScheduleRestartLocked();
        }
    }

    private void OnProcessExited(Process process)
    {
        lock (_sync)
        {
            if (_stopping || !ReferenceEquals(_process, process))
            {
                return;
            }

            _log.Write($"control API exited code={process.ExitCode}; scheduling restart");
            _process = null;
            try
            {
                process.Dispose();
            }
            catch
            {
                // ignored
            }

            _job?.Dispose();
            _job = null;
            ScheduleRestartLocked();
        }
    }

    private void ScheduleRestartLocked()
    {
        if (_stopping || _restartScheduled)
        {
            return;
        }

        _restartScheduled = true;
        var delayMs = Math.Min(5000, 1000 + (_restartCount * 1000));
        _restartCount += 1;

        _ = Task.Run(async () =>
        {
            await Task.Delay(delayMs);
            lock (_sync)
            {
                _restartScheduled = false;
                if (_stopping)
                {
                    return;
                }

                StartProcessLocked();
            }
        });
    }

    private string ResolveNode()
    {
        if (File.Exists(_options.NodePath))
        {
            return _options.NodePath;
        }

        var path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (var directory in path.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            var candidate = Path.Combine(directory.Trim(), "node.exe");
            if (File.Exists(candidate))
            {
                return candidate;
            }
        }

        return _options.NodePath;
    }

    public void Stop()
    {
        lock (_sync)
        {
            if (_stopping)
            {
                return;
            }

            _stopping = true;
            try
            {
                _process?.Kill(entireProcessTree: true);
            }
            catch
            {
                // ignored
            }

            _process?.Dispose();
            _process = null;
            _job?.Dispose();
            _job = null;
            _apiLog.Dispose();
        }
    }

    public void Dispose()
    {
        Stop();
    }
}
