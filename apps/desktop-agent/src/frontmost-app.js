import { readFile } from 'node:fs/promises';

const TIMEOUT_MS = 2000;

const MAC_SCRIPT = 'tell application "System Events" to get name of first application process whose frontmost is true';
const WINDOWS_SCRIPT = [
  'Add-Type @"',
  'using System; using System.Runtime.InteropServices;',
  'public class W { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p); }',
  '"@',
  '$p = 0; [void][W]::GetWindowThreadProcessId([W]::GetForegroundWindow(), [ref]$p); (Get-Process -Id $p).ProcessName',
].join('\n');

/**
 * Name of the application in front, used only to honour the policy's excluded apps. Returns null
 * when it cannot be determined (the agent then skips the capture rather than risk it).
 * On macOS the first call shows the system's Automation prompt for System Events.
 */
export function createFrontmostApp({ platform, execFile }) {
  const run = (cmd, args) =>
    new Promise((resolve) => {
      execFile(cmd, args, { timeout: TIMEOUT_MS, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout).trim() || null));
    });
  return async function frontmostApp() {
    if (platform === 'darwin') return run('osascript', ['-e', MAC_SCRIPT]);
    if (platform === 'win32') return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_SCRIPT]);
    const pid = await run('xdotool', ['getactivewindow', 'getwindowpid']);
    if (!pid || !/^\d+$/.test(pid)) return null;
    return readFile(`/proc/${pid}/comm`, 'utf8').then((name) => name.trim() || null, () => null);
  };
}
