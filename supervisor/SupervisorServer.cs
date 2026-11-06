using System.IO.Pipes;
using System.Text;
using System.Text.Json;

namespace UEVSupervisor;

internal sealed class ActiveCall
{
    public required string Id { get; init; }
    public string? Tool { get; init; }
    public string? Action { get; init; }
    public int TimeoutMs { get; init; }
    public required DateTime DeadlineUtc { get; init; }
}

internal sealed class SupervisorServer
{
    private readonly string _pipeName;
    private readonly JobObject _job;
    private readonly SupervisorLog _log;
    private readonly string? _logPath;
    private readonly int _graceMs;
    private readonly int _heartbeatTimeoutMs;
    private readonly DateTime _startedUtc = DateTime.UtcNow;
    private readonly CancellationTokenSource _cts = new();
    private readonly object _sync = new();
    private readonly Dictionary<string, ActiveCall> _activeCalls = new();
    private DateTime _lastHeartbeatUtc = DateTime.UtcNow;
    private bool _killed;
    private string? _shutdownReason;
    private int _restartCount;
    private int _lastExitCode;
    private string? _lastCrashPath;
    private readonly bool _restartOnCrash;
    private readonly int _maxRestarts;

    public bool IsKilled
    {
        get
        {
            lock (_sync)
            {
                return _killed;
            }
        }
    }

    public string? ShutdownReason
    {
        get
        {
            lock (_sync)
            {
                return _shutdownReason;
            }
        }
    }

    public SupervisorServer(
        string pipeName,
        JobObject job,
        SupervisorLog log,
        int graceMs,
        int heartbeatTimeoutMs,
        bool restartOnCrash = false,
        int maxRestarts = 0)
    {
        _pipeName = pipeName;
        _job = job;
        _log = log;
        _logPath = log.Path;
        _graceMs = graceMs;
        _heartbeatTimeoutMs = heartbeatTimeoutMs;
        _restartOnCrash = restartOnCrash;
        _maxRestarts = maxRestarts;
    }

    /// <summary>The single pipe this supervisor serves.</summary>
    public string PipeName => _pipeName;

    public void Start()
    {
        _ = Task.Run(() => AcceptLoopAsync(_pipeName));
        _ = Task.Run(MonitorLoopAsync);
    }

    public void Stop()
    {
        try
        {
            _cts.Cancel();
        }
        catch
        {
            // Ignore cancellation races during shutdown.
        }
    }

    public void Panic(string reason)
    {
        Kill(reason);
    }

    /// <summary>Record a watchdog crash restart so status consumers can see what happened.</summary>
    public void RecordRestart(int exitCode, string? crashPath, int restartCount)
    {
        lock (_sync)
        {
            _lastExitCode = exitCode;
            _lastCrashPath = crashPath;
            _restartCount = restartCount;
        }
    }

    /// <summary>Clear per-child state before the watchdog relaunches the editor.</summary>
    public void ResetForRestart()
    {
        lock (_sync)
        {
            _activeCalls.Clear();
            _killed = false;
            _shutdownReason = null;
            _lastHeartbeatUtc = DateTime.UtcNow;
        }
    }

    public string GetStatusText(string? requestId = null)
    {
        lock (_sync)
        {
            var now = DateTime.UtcNow;
            var status = new
            {
                ok = true,
                requestId,
                editorPid = _job.ProcessId,
                editorRunning = !_job.HasExited,
                killed = _killed,
                shutdownReason = _shutdownReason,
                restarts = _restartCount,
                lastExitCode = _lastExitCode,
                lastCrashPath = _lastCrashPath,
                restartOnCrash = _restartOnCrash,
                maxRestarts = _maxRestarts,
                processMemoryLimitMb = _job.ProcessMemoryMb,
                jobMemoryLimitMb = _job.JobMemoryMb,
                maxProcesses = _job.MaxProcesses,
                killOnClose = _job.KillOnClose,
                logPath = _logPath,
                pipes = new[] { $@"\\.\pipe\{_pipeName}" },
                uptimeSeconds = Math.Max(0, (int)(now - _startedUtc).TotalSeconds),
                activeCalls = _activeCalls.Values
                    .Select(call => new
                    {
                        id = call.Id,
                        tool = call.Tool,
                        action = call.Action,
                        timeoutMs = call.TimeoutMs,
                        remainingMs = Math.Max(0, (int)(call.DeadlineUtc - now).TotalMilliseconds),
                    })
                    .ToArray(),
            };

            return JsonSerializer.Serialize(status);
        }
    }

    private async Task AcceptLoopAsync(string pipeName)
    {
        while (!_cts.IsCancellationRequested)
        {
            NamedPipeServerStream? pipe = null;
            try
            {
                pipe = new NamedPipeServerStream(
                    pipeName,
                    PipeDirection.InOut,
                    1,
                    PipeTransmissionMode.Byte,
                    PipeOptions.Asynchronous);

                _log.Write($"pipe listening: \\\\.\\pipe\\{pipeName}");
                await pipe.WaitForConnectionAsync(_cts.Token);
                _log.Write("MCP client connected");
                await HandleClientAsync(pipe);
            }
            catch (OperationCanceledException)
            {
                // Normal shutdown.
            }
            catch (Exception exception)
            {
                _log.Write($"pipe error: {exception.Message}");
            }
            finally
            {
                pipe?.Dispose();
            }
        }
    }

    private async Task HandleClientAsync(NamedPipeServerStream pipe)
    {
        using var reader = new StreamReader(
            pipe,
            new UTF8Encoding(false),
            detectEncodingFromByteOrderMarks: false,
            bufferSize: 4096,
            leaveOpen: true);
        using var writer = new StreamWriter(
            pipe,
            new UTF8Encoding(false),
            bufferSize: 4096,
            leaveOpen: true)
        {
            AutoFlush = true,
        };

        while (!_cts.IsCancellationRequested)
        {
            string? line;
            try
            {
                line = await reader.ReadLineAsync(_cts.Token);
            }
            catch (OperationCanceledException)
            {
                break;
            }

            if (line == null)
            {
                break;
            }

            if (string.IsNullOrWhiteSpace(line))
            {
                continue;
            }

            var response = ProcessMessage(line);
            if (response != null)
            {
                await writer.WriteLineAsync(response);
            }
        }
    }

    private string? ProcessMessage(string line)
    {
        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(line);
        }
        catch (JsonException)
        {
            return Error("invalid json");
        }

        using (document)
        {
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                return Error("message must be a json object");
            }

            var type = GetString(root, "type");
            switch (type)
            {
                case "call_start":
                {
                    var id = GetString(root, "id");
                    if (string.IsNullOrWhiteSpace(id))
                    {
                        return Error("call_start requires id");
                    }

                    var timeoutMs = Math.Clamp(GetInt(root, "timeoutMs", 30000), 1000, 600000);
                    var call = new ActiveCall
                    {
                        Id = id,
                        Tool = GetString(root, "tool"),
                        Action = GetString(root, "action"),
                        TimeoutMs = timeoutMs,
                        DeadlineUtc = DateTime.UtcNow.AddMilliseconds(timeoutMs + _graceMs),
                    };

                    lock (_sync)
                    {
                        _activeCalls[id] = call;
                        _lastHeartbeatUtc = DateTime.UtcNow;
                    }

                    _log.Write($"call_start {id} {call.Tool ?? "?"}.{call.Action ?? "?"} timeout={timeoutMs}ms");
                    return Serialize(new { ok = true, id, timeoutMs, graceMs = _graceMs });
                }

                case "call_end":
                {
                    var id = GetString(root, "id");
                    if (string.IsNullOrWhiteSpace(id))
                    {
                        return Error("call_end requires id");
                    }

                    lock (_sync)
                    {
                        _activeCalls.Remove(id);
                    }

                    _log.Write($"call_end {id}");
                    return Serialize(new { ok = true, id });
                }

                case "heartbeat":
                    lock (_sync)
                    {
                        _lastHeartbeatUtc = DateTime.UtcNow;
                    }

                    return Serialize(new { ok = true });

                case "panic":
                {
                    var reason = GetString(root, "reason") ?? "panic";
                    var requestId = GetString(root, "requestId");
                    var response = Serialize(new { ok = true, requestId, message = "panic accepted" });
                    _ = Task.Run(() => Kill($"panic: {reason}"));
                    return response;
                }

                case "status":
                    return GetStatusText(GetString(root, "requestId"));

                default:
                    return Error($"unknown message type: {type}");
            }
        }
    }

    private async Task MonitorLoopAsync()
    {
        while (!_cts.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(250, _cts.Token);
            }
            catch (OperationCanceledException)
            {
                return;
            }

            string? reason = null;
            lock (_sync)
            {
                if (_killed)
                {
                    return;
                }

                var now = DateTime.UtcNow;
                foreach (var call in _activeCalls.Values)
                {
                    if (now >= call.DeadlineUtc)
                    {
                        reason = $"call {call.Id} ({call.Tool ?? "?"}.{call.Action ?? "?"}) exceeded {call.TimeoutMs}ms + grace";
                        break;
                    }
                }

                if (reason == null &&
                    _activeCalls.Count > 0 &&
                    (now - _lastHeartbeatUtc).TotalMilliseconds > _heartbeatTimeoutMs)
                {
                    reason = $"heartbeat lost with {_activeCalls.Count} active call(s)";
                }
            }

            if (reason != null)
            {
                Kill(reason);
                return;
            }
        }
    }

    private void Kill(string reason)
    {
        lock (_sync)
        {
            if (_killed)
            {
                return;
            }

            _killed = true;
            _shutdownReason = reason;
        }

        _log.Write($"KILL: {reason}");
        try
        {
            _job.Terminate();
        }
        catch (Exception exception)
        {
            _log.Write($"TerminateJobObject failed: {exception.Message}");
        }

        try
        {
            _cts.Cancel();
        }
        catch
        {
            // Ignore cancellation races.
        }
    }

    private static string? GetString(JsonElement root, string name)
    {
        return root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
    }

    private static int GetInt(JsonElement root, string name, int fallback)
    {
        return root.TryGetProperty(name, out var value) &&
               value.ValueKind == JsonValueKind.Number &&
               value.TryGetInt32(out var number)
            ? number
            : fallback;
    }

    private static string Serialize(object value)
    {
        return JsonSerializer.Serialize(value);
    }

    private static string Error(string message)
    {
        return Serialize(new { ok = false, error = message });
    }
}
