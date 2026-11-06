using System.Text.Json;

namespace UEVSupervisor;

/// <summary>
/// Finds the crash report the engine wrote last, so the watchdog can log a path a human can open.
/// UE4 writes one folder per crash under &lt;project&gt;\Saved\Crashes (UE4CC-Windows-...).
/// </summary>
internal static class CrashReportLocator
{
    public static string? Newest(string? projectPath)
    {
        var crashesDir = CrashesDirectory(projectPath);
        if (crashesDir == null || !Directory.Exists(crashesDir))
        {
            return null;
        }

        try
        {
            var newest = new DirectoryInfo(crashesDir)
                .EnumerateDirectories()
                .Where(dir => dir.Name.StartsWith("UE4CC-", StringComparison.OrdinalIgnoreCase))
                .OrderByDescending(dir => dir.LastWriteTimeUtc)
                .FirstOrDefault();
            return newest?.FullName;
        }
        catch (Exception)
        {
            return null;
        }
    }

    public static string? CrashesDirectory(string? projectPath)
    {
        if (string.IsNullOrWhiteSpace(projectPath))
        {
            return null;
        }

        var projectDir = Path.GetDirectoryName(projectPath);
        return string.IsNullOrWhiteSpace(projectDir)
            ? null
            : Path.Combine(projectDir, "Saved", "Crashes");
    }

    /// <summary>One-line crash summary (error message plus first stack frame) for the supervisor log.</summary>
    public static string? Describe(string? crashPath)
    {
        if (string.IsNullOrWhiteSpace(crashPath))
        {
            return null;
        }

        var report = Path.Combine(crashPath, "CrashContext.runtime-xml");
        if (!File.Exists(report))
        {
            return crashPath;
        }

        try
        {
            var text = File.ReadAllText(report);
            var error = Tag(text, "ErrorMessage");
            var callstack = Tag(text, "CallStack");
            var first = callstack?
                .Split('\n', StringSplitOptions.RemoveEmptyEntries)
                .FirstOrDefault(line => !string.IsNullOrWhiteSpace(line));
            if (error == null && first == null)
            {
                return crashPath;
            }

            var detail = (error == null ? "" : " | " + error.Trim())
                + (first == null ? "" : " | " + first.Trim());
            return crashPath + detail;
        }
        catch (Exception)
        {
            return crashPath;
        }
    }

    private static string? Tag(string xml, string name)
    {
        var open = "<" + name + ">";
        var close = "</" + name + ">";
        var start = xml.IndexOf(open, StringComparison.Ordinal);
        if (start < 0)
        {
            return null;
        }

        start += open.Length;
        var end = xml.IndexOf(close, start, StringComparison.Ordinal);
        return end < 0 ? null : xml[start..end].Trim();
    }
}
