namespace UEVSupervisor;

internal sealed class Options
{
    public string EditorPath { get; private set; } = @"D:\UE-ViteFork\Engine\Binaries\Win64\UE4Editor.exe";
    public string? ProjectPath { get; private set; } = @"D:\Uprojects\ViteMCPTest\ViteMCPTest.uproject";
    public string ChildArgs { get; private set; } = "";
    public string PipeName { get; private set; } = "uev-supervisor";
    public int ProcessMemoryMb { get; private set; } = 20480;
    public int JobMemoryMb { get; private set; } = 28672;
    public int MaxProcesses { get; private set; } = 128;
    public int GraceMs { get; private set; } = 5000;
    public int HeartbeatTimeoutMs { get; private set; } = 30000;
    public bool KillOnClose { get; private set; } = true;
    public string? LogPath { get; private set; }
    public bool ShowHelp { get; private set; }
    public bool ControlApiEnabled { get; private set; }
    public string McpEntryPath { get; private set; } = "";
    public string NodePath { get; private set; } = "node";
    public string McpProfile { get; private set; } = "supervised";
    public int ControlPort { get; private set; } = 8765;
    public bool RestartOnCrash { get; private set; } = true;
    public int MaxRestarts { get; private set; } = 3;
    public int RestartDelayMs { get; private set; } = 5000;
    public int RestartWindowSeconds { get; private set; } = 600;

    public bool IsEditorLaunch => !string.IsNullOrWhiteSpace(ProjectPath);

    /// <summary>True when --restart-on-crash was passed explicitly.</summary>
    public bool RestartExplicit { get; private set; }

    public static Options Parse(string[] args)
    {
        var options = new Options();

        for (var i = 0; i < args.Length; i++)
        {
            var arg = args[i];
            string NextValue()
            {
                if (i + 1 >= args.Length)
                {
                    throw new ArgumentException($"Missing value for {arg}");
                }

                return args[++i];
            }

            switch (arg)
            {
                case "--editor":
                    options.EditorPath = NextValue();
                    break;
                case "--project":
                    options.ProjectPath = NextValue();
                    break;
                case "--child":
                    options.EditorPath = NextValue();
                    options.ProjectPath = null;
                    // Crash-restart is an editor watchdog; a test child stays dead unless asked.
                    options.RestartOnCrash = false;
                    break;
                case "--child-args":
                    options.ChildArgs = NextValue();
                    break;
                case "--pipe":
                    options.PipeName = NormalizePipeName(NextValue());
                    break;
                case "--memory-mb":
                    options.ProcessMemoryMb = ParsePositiveInt(NextValue(), "--memory-mb");
                    break;
                case "--job-memory-mb":
                    options.JobMemoryMb = ParsePositiveInt(NextValue(), "--job-memory-mb");
                    break;
                case "--max-processes":
                    options.MaxProcesses = ParsePositiveInt(NextValue(), "--max-processes");
                    break;
                case "--grace-ms":
                    options.GraceMs = ParsePositiveInt(NextValue(), "--grace-ms");
                    break;
                case "--heartbeat-timeout-ms":
                    options.HeartbeatTimeoutMs = ParsePositiveInt(NextValue(), "--heartbeat-timeout-ms");
                    break;
                case "--no-kill-on-close":
                    options.KillOnClose = false;
                    break;
                case "--log":
                    options.LogPath = NextValue();
                    break;
                case "--control-api":
                    options.ControlApiEnabled = true;
                    break;
                case "--mcp-entry":
                    options.McpEntryPath = NextValue();
                    break;
                case "--mcp-node":
                    options.NodePath = NextValue();
                    break;
                case "--mcp-profile":
                    var profile = NextValue().Trim().ToLowerInvariant();
                    if (profile != "unattended" && profile != "supervised")
                    {
                        throw new ArgumentException("--mcp-profile must be 'unattended' or 'supervised'.");
                    }

                    options.McpProfile = profile;
                    break;
                case "--no-restart":
                    options.RestartOnCrash = false;
                    break;
                case "--restart-on-crash":
                    options.RestartOnCrash = true;
                    options.RestartExplicit = true;
                    break;
                case "--max-restarts":
                    options.MaxRestarts = ParseNonNegativeInt(NextValue(), "--max-restarts");
                    break;
                case "--restart-delay-ms":
                    options.RestartDelayMs = ParsePositiveInt(NextValue(), "--restart-delay-ms");
                    break;
                case "--restart-window-seconds":
                    options.RestartWindowSeconds = ParsePositiveInt(NextValue(), "--restart-window-seconds");
                    break;
                case "--control-port":
                    options.ControlPort = ParsePositiveInt(NextValue(), "--control-port");
                    break;
                case "--help":
                case "-h":
                    options.ShowHelp = true;
                    break;
                default:
                    throw new ArgumentException($"Unknown argument: {arg}");
            }
        }

        return options;
    }

    public static void PrintUsage()
    {
        Console.WriteLine("""
            UEVSupervisor - Job Object watchdog for the UEV (UnrealEngineVite MCP) server

            Usage:
              UEVSupervisor [options]

            Options:
              --editor <path>              UE4Editor.exe path. Default: D:\UE-ViteFork\Engine\Binaries\Win64\UE4Editor.exe
              --project <path>             .uproject path. Default: D:\Uprojects\ViteMCPTest\ViteMCPTest.uproject
              --child <path>               Launch a non-editor child for testing (no project required).
              --child-args <args>          Extra command-line arguments for the child.
              --pipe <name>                Named pipe name. Default: uev-supervisor
              --memory-mb <n>              Per-process memory cap. Default: 20480
              --job-memory-mb <n>          Whole-job memory cap. Default: 28672
              --max-processes <n>          Active process limit. Default: 128
              --grace-ms <n>               Grace added to the MCP call timeout. Default: 5000
              --heartbeat-timeout-ms <n>   Kill an active call if heartbeats stop. Default: 30000
              --no-kill-on-close           Do not kill the job when the supervisor closes.
              --log <path>                 Log file path. Default: %LOCALAPPDATA%\UEV\logs\
              --control-api                Start and supervise the MCP control API.
              --mcp-entry <path>           Path to mcp-fork\dist\bin.js (required with --control-api).
              --mcp-node <path>            node.exe path or command. Default: node
              --mcp-profile <name>         unattended or supervised. Default: supervised
              --control-port <n>           Control API loopback port. Default: 8765
              --no-restart                 Do not relaunch the child after a crash.
              --restart-on-crash           Relaunch the child after a non-zero exit. Default: on for editor launches
              --max-restarts <n>           Consecutive crash restarts allowed in the window. Default: 3
              --restart-delay-ms <n>       Wait before relaunching. Default: 5000
              --restart-window-seconds <n> Window that counts restart attempts. Default: 600
              --help                       Show this help.

            Interactive commands in the supervisor console:
              panic    Kill the job immediately.
              status   Print the current supervisor state.
              quit     Kill the job and exit.

            MCP server environment (UEV_* only):
              UEV_SUPERVISOR_PIPE=\\.\pipe\uev-supervisor
              UEV_BIND_ADDRESS=127.0.0.1
              UEV_COMMAND_ADDRESS=127.0.0.1
            """);
    }

    private static int ParseNonNegativeInt(string raw, string name)
    {
        if (!int.TryParse(raw, out var value) || value < 0)
        {
            throw new ArgumentException($"{name} must be zero or a positive integer.");
        }

        return value;
    }

    private static int ParsePositiveInt(string raw, string name)
    {
        if (!int.TryParse(raw, out var value) || value <= 0)
        {
            throw new ArgumentException($"{name} must be a positive integer.");
        }

        return value;
    }

    private static string NormalizePipeName(string value)
    {
        const string prefix = @"\\.\pipe\";
        return value.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)
            ? value[prefix.Length..]
            : value;
    }
}
