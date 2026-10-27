import { win32 } from "node:path";
import { fileURLToPath } from "node:url";

export function windowsJobLaunch(command, args) {
  if (typeof command !== "string" || !command || command.includes("\0") ||
      !Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
    throw new TypeError("Windows job command and arguments must be strings without NUL characters");
  }
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT;
  if (!systemRoot || !win32.isAbsolute(systemRoot)) {
    throw new Error("An absolute SystemRoot is required to locate Windows PowerShell");
  }
  const config = Buffer.from(JSON.stringify({
    source: fileURLToPath(new URL("./windows-job.cs", import.meta.url)),
    command,
    arguments: args,
  }), "utf8").toString("base64");
  // Only base64 enters PowerShell source. The launch arguments never pass
  // through its command parser, pipeline, or text stream conversion.
  const script = `$ErrorActionPreference = 'Stop'
try {
  $config = ConvertFrom-Json -InputObject ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${config}')))
  Add-Type -LiteralPath $config.source
  [AgentChatWindowsJob]::Run([string]$config.command, [string[]]$config.arguments)
} catch {
  [Console]::Error.WriteLine('Windows App Server launcher failed: ' + $_.Exception.Message)
  [Environment]::Exit(1)
}`;
  return {
    file: win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
  };
}
