/**
 * Native window control for launched game processes.
 *
 * Windows: a small persistent PowerShell helper calling user32 (EnumWindows by
 * process id, ShowWindow, SetForegroundWindow, WM_CLOSE). The game window stays
 * a normal top-level window – reachable with Alt-Tab and the taskbar at any time.
 * Linux (X11): xdotool when installed. Elsewhere window control is unavailable
 * and the game simply stays where the OS puts it.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 'ok' may carry notes from Windows: ok+unhidden, ok+moved, ok+notfront. */
export type WindowResult = 'ok' | `ok+${string}` | 'nowindow' | 'unsupported' | 'error';

export interface WindowController {
  readonly name: string;
  /** Restores and focuses the process' main window. */
  show(pid: number): Promise<WindowResult>;
  /** Minimizes it (stays in the taskbar / Alt-Tab). */
  minimize(pid: number): Promise<WindowResult>;
  /** Asks the window to close (the game saves and disconnects). */
  close(pid: number): Promise<WindowResult>;
  /** Whether the process currently has a top-level window. */
  hasWindow(pid: number): Promise<boolean>;
  dispose(): void;
}

const PS_HELPER = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class HoelniWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
  static bool IsGame(IntPtr h) {
    var sb = new System.Text.StringBuilder(64); GetClassName(h, sb, 64);
    return sb.ToString().StartsWith("GLFW"); // the Minecraft (LWJGL/GLFW) window, even while hidden
  }
  public static IntPtr Find(uint pid) {
    IntPtr found = IntPtr.Zero; IntPtr hidden = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != pid || GetWindow(h, 4) != IntPtr.Zero) return true;
      if (IsWindowVisible(h) && GetWindowTextLength(h) > 0) { found = h; return false; }
      if (hidden == IntPtr.Zero && IsGame(h)) hidden = h;
      return true;
    }, IntPtr.Zero);
    return found != IntPtr.Zero ? found : hidden;
  }
  public static string Run(string action, uint pid) {
    IntPtr h = Find(pid);
    if (h == IntPtr.Zero) return "nowindow";
    switch (action) {
      case "has": return "ok";
      case "show": {
        string note = "";
        if (!IsWindowVisible(h)) { ShowWindow(h, 5); note += "+unhidden"; }
        if (IsIconic(h)) ShowWindow(h, 9); else ShowWindow(h, 5);
        // A window outside every monitor (e.g. a disconnected second screen) is moved onto the main one.
        if (MonitorFromWindow(h, 0) == IntPtr.Zero) { SetWindowPos(h, IntPtr.Zero, 80, 80, 0, 0, 0x0001 | 0x0004 | 0x0040); note += "+moved"; }
        for (int i = 0; i < 3 && GetForegroundWindow() != h; i++) {
          // Pressing ALT lifts the foreground lock Windows puts on background processes.
          keybd_event(0x12, 0, 0, UIntPtr.Zero);
          keybd_event(0x12, 0, 2, UIntPtr.Zero);
          BringWindowToTop(h);
          SetForegroundWindow(h);
          System.Threading.Thread.Sleep(150);
        }
        if (GetForegroundWindow() != h) note += "+notfront";
        return "ok" + note;
      }
      case "minimize": ShowWindow(h, 6); return "ok";
      case "close": PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero); return "ok";
    }
    return "error";
  }
}
"@
[Console]::Out.WriteLine('@@ready')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $parts = $line.Split(' ')
  try { $r = [HoelniWin]::Run($parts[1], [uint32]$parts[2]) } catch { $r = 'error' }
  [Console]::Out.WriteLine('@@' + $parts[0] + ' ' + $r)
}
`;

/** Windows implementation (persistent PowerShell helper, one command at a time). */
export class WindowsWindowController implements WindowController {
  readonly name = 'windows-user32';
  private proc: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private seq = 0;
  private readonly pending = new Map<number, (r: WindowResult) => void>();
  private buf = '';

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoelni-win-'));
    const script = path.join(dir, 'window-helper.ps1');
    fs.writeFileSync(script, PS_HELPER);
    this.ready = new Promise<void>((resolve, reject) => {
      const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true });
      this.proc = p;
      const timer = setTimeout(() => reject(new Error('Window helper did not start')), 30_000);
      p.stdout.setEncoding('utf8');
      p.stdout.on('data', (d: string) => {
        this.buf += d;
        let i: number;
        while ((i = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, i).trim();
          this.buf = this.buf.slice(i + 1);
          if (line === '@@ready') {
            clearTimeout(timer);
            resolve();
          } else if (line.startsWith('@@')) {
            const [id, r] = line.slice(2).split(' ');
            this.pending.get(Number(id))?.(r as WindowResult);
            this.pending.delete(Number(id));
          }
        }
      });
      p.on('exit', () => {
        clearTimeout(timer);
        for (const cb of this.pending.values()) cb('error');
        this.pending.clear();
        this.proc = null;
        this.ready = null;
        reject(new Error('Window helper exited'));
      });
      p.on('error', () => undefined);
    });
    this.ready.catch(() => undefined);
    return this.ready;
  }

  private async run(action: string, pid: number): Promise<WindowResult> {
    try {
      await this.start();
    } catch {
      return 'error';
    }
    const id = ++this.seq;
    return new Promise<WindowResult>((resolve) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        resolve('error');
      }, 10_000);
      this.pending.set(id, (r) => {
        clearTimeout(t);
        resolve(r);
      });
      this.proc?.stdin.write(`${id} ${action} ${pid}\n`);
    });
  }

  show(pid: number) {
    return this.run('show', pid);
  }
  minimize(pid: number) {
    return this.run('minimize', pid);
  }
  close(pid: number) {
    return this.run('close', pid);
  }
  async hasWindow(pid: number) {
    return (await this.run('has', pid)).startsWith('ok');
  }
  dispose(): void {
    this.proc?.stdin.end();
    this.proc?.kill();
  }
}

/** Linux/X11 implementation via xdotool. */
export class XdotoolWindowController implements WindowController {
  readonly name = 'xdotool';

  private windows(pid: number): string[] {
    const r = spawnSync('xdotool', ['search', '--onlyvisible', '--pid', String(pid)], { encoding: 'utf8', timeout: 5000 });
    return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : [];
  }
  private async act(pid: number, cmd: string[]): Promise<WindowResult> {
    const w = this.windows(pid).at(-1);
    if (!w) return 'nowindow';
    const r = spawnSync('xdotool', [...cmd, w], { timeout: 5000 });
    return r.status === 0 ? 'ok' : 'error';
  }
  show(pid: number) {
    return this.act(pid, ['windowactivate']);
  }
  minimize(pid: number) {
    return this.act(pid, ['windowminimize']);
  }
  close(pid: number) {
    return this.act(pid, ['windowclose']);
  }
  async hasWindow(pid: number) {
    return this.windows(pid).length > 0;
  }
  dispose(): void {}
}

export class NoWindowController implements WindowController {
  readonly name = 'none';
  async show() {
    return 'unsupported' as const;
  }
  async minimize() {
    return 'unsupported' as const;
  }
  async close() {
    return 'unsupported' as const;
  }
  async hasWindow() {
    return false;
  }
  dispose(): void {}
}

export function createWindowController(): WindowController {
  if (process.platform === 'win32') return new WindowsWindowController();
  if (process.platform === 'linux' && process.env.DISPLAY && spawnSync('xdotool', ['version'], { timeout: 3000 }).status === 0) return new XdotoolWindowController();
  return new NoWindowController();
}
