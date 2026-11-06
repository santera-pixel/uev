namespace UEVSupervisor;

internal sealed class SupervisorLog : IDisposable
{
    private readonly object _sync = new();
    private readonly StreamWriter? _writer;

    public string? Path { get; }

    public SupervisorLog(string? path)
    {
        Path = path;
        if (string.IsNullOrWhiteSpace(path))
        {
            return;
        }

        var directory = System.IO.Path.GetDirectoryName(path);
        if (!string.IsNullOrWhiteSpace(directory))
        {
            Directory.CreateDirectory(directory);
        }

        _writer = new StreamWriter(path, append: true) { AutoFlush = true };
    }

    public void Write(string message)
    {
        var line = $"[{DateTime.Now:HH:mm:ss.fff}] {message}";
        lock (_sync)
        {
            Console.WriteLine(line);
            _writer?.WriteLine(line);
        }
    }

    public void Dispose()
    {
        lock (_sync)
        {
            _writer?.Dispose();
        }
    }
}
