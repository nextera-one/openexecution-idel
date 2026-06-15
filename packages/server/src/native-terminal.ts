import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { platform } from "node:os";
import { resolve } from "node:path";

export interface NativeTerminalInfo {
  id: string;
  cwd: string;
  shell: string;
  pty: boolean;
  cols: number;
  rows: number;
  pid: number | undefined;
  startedAt: string;
  exited: boolean;
  exitCode: number | null | undefined;
}

export type NativeTerminalEvent =
  | { type: "data"; data: string }
  | { type: "exit"; code: number | null; signal: NodeJS.Signals | null };

export interface NativeTerminalOptions {
  cwd?: string;
  disabled?: boolean;
}

export interface StartNativeTerminalRequest {
  cwd?: string;
  shell?: string;
  cols?: number;
  rows?: number;
}

export type NativeTerminalSignal = "interrupt" | "terminate" | "kill" | "hangup";

type NativeTerminalListener = (event: NativeTerminalEvent) => void;

const MAX_BACKLOG_CHARS = 64_000;

const PYTHON_PTY_BRIDGE = `
import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios

shell = os.environ.get("IDEL_PTY_SHELL") or os.environ.get("SHELL") or "/bin/sh"
os.environ.setdefault("TERM", "xterm-256color")
cols = max(2, min(1000, int(os.environ.get("IDEL_PTY_COLS") or "80")))
rows = max(1, min(1000, int(os.environ.get("IDEL_PTY_ROWS") or "24")))

def apply_winsize(fd, next_cols, next_rows):
    next_cols = max(2, min(1000, int(next_cols)))
    next_rows = max(1, min(1000, int(next_rows)))
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", next_rows, next_cols, 0, 0))

def notify_resize(pid):
    try:
        os.killpg(pid, signal.SIGWINCH)
    except Exception:
        try:
            os.kill(pid, signal.SIGWINCH)
        except Exception:
            pass

try:
    pid, master = pty.fork()
    if pid == 0:
        os.environ["COLUMNS"] = str(cols)
        os.environ["LINES"] = str(rows)
        try:
            apply_winsize(0, cols, rows)
        except Exception:
            pass
        os.execlp(shell, shell)

    apply_winsize(master, cols, rows)
    notify_resize(pid)

    stdin_fd = sys.stdin.buffer.fileno()
    stdout_fd = sys.stdout.buffer.fileno()
    buf = bytearray()
    status = None

    def wait_nonblocking():
        global status
        if status is not None:
            return True
        try:
            waited_pid, waited_status = os.waitpid(pid, os.WNOHANG)
            if waited_pid == pid:
                status = waited_status
                return True
        except ChildProcessError:
            status = 0
            return True
        return False

    def wait_blocking():
        global status
        if status is not None:
            return
        try:
            _, status = os.waitpid(pid, 0)
        except ChildProcessError:
            status = 0

    def read_frames():
        global cols, rows
        chunk = os.read(stdin_fd, 65536)
        if not chunk:
            return False
        buf.extend(chunk)
        while len(buf) >= 5:
            kind = chr(buf[0])
            size = struct.unpack(">I", bytes(buf[1:5]))[0]
            if size > 1024 * 1024:
                raise RuntimeError("frame too large")
            if len(buf) < 5 + size:
                break
            payload = bytes(buf[5:5 + size])
            del buf[:5 + size]
            if kind == "d":
                if payload:
                    os.write(master, payload)
            elif kind == "r" and len(payload) == 8:
                cols, rows = struct.unpack(">II", payload)
                apply_winsize(master, cols, rows)
                notify_resize(pid)
            elif kind == "s":
                name = payload.decode("ascii", "ignore").upper()
                sig = {
                    "INT": signal.SIGINT,
                    "TERM": signal.SIGTERM,
                    "KILL": signal.SIGKILL,
                    "HUP": signal.SIGHUP,
                }.get(name)
                if sig is not None:
                    try:
                        os.killpg(pid, sig)
                    except Exception:
                        os.kill(pid, sig)
        return True

    while True:
        if wait_nonblocking():
            break
        ready, _, _ = select.select([stdin_fd, master], [], [], 0.1)
        if stdin_fd in ready and not read_frames():
            try:
                os.killpg(pid, signal.SIGHUP)
            except Exception:
                try:
                    os.kill(pid, signal.SIGHUP)
                except Exception:
                    pass
            wait_blocking()
            break
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError as exc:
                if exc.errno != errno.EIO:
                    raise
                wait_blocking()
                break
            if not data:
                wait_blocking()
                break
            os.write(stdout_fd, data)

    wait_blocking()
    os.close(master)
    if hasattr(os, "waitstatus_to_exitcode"):
        sys.exit(os.waitstatus_to_exitcode(status))
    sys.exit(0)
except Exception as exc:
    sys.stderr.write("IDEL PTY failed: %s\\n" % exc)
    sys.stderr.flush()
    sys.exit(1)
`;

export class NativeTerminalManager {
  private readonly sessions = new Map<string, NativeTerminalSession>();
  private readonly cwd: string;
  private readonly disabled: boolean;

  constructor(options: NativeTerminalOptions = {}) {
    this.cwd = resolve(options.cwd ?? process.cwd());
    this.disabled = options.disabled === true;
  }

  get available(): boolean {
    return !this.disabled;
  }

  start(req: StartNativeTerminalRequest = {}): NativeTerminalInfo {
    if (this.disabled) {
      throw new NativeTerminalError("native terminals are disabled for this server", 403);
    }
    const cwd = req.cwd ? resolve(req.cwd) : this.cwd;
    const isWindows = platform() === "win32";
    const shell = req.shell?.trim() || defaultShell(isWindows);
    const size = normalizeTerminalSize(req.cols, req.rows);
    const session = NativeTerminalSession.start({ cwd, shell, pty: !isWindows, ...size });
    this.sessions.set(session.id, session);
    session.subscribe((event) => {
      if (event.type === "exit") this.sessions.delete(session.id);
    });
    return session.info();
  }

  get(id: string): NativeTerminalSession | undefined {
    return this.sessions.get(id);
  }

  list(): NativeTerminalInfo[] {
    return Array.from(this.sessions.values(), (session) => session.info());
  }

  write(id: string, data: string): boolean {
    return this.sessions.get(id)?.write(data) ?? false;
  }

  close(id: string): boolean {
    return this.sessions.get(id)?.close() ?? false;
  }

  resize(id: string, cols: number, rows: number): boolean {
    return this.sessions.get(id)?.resize(cols, rows) ?? false;
  }

  signal(id: string, signal: NativeTerminalSignal): boolean {
    return this.sessions.get(id)?.signal(signal) ?? false;
  }

  closeAll(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }
}

export class NativeTerminalSession {
  readonly id = `native_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly cwd: string;
  private readonly shell: string;
  private readonly pty: boolean;
  private readonly startedAt = new Date().toISOString();
  private readonly listeners = new Set<NativeTerminalListener>();
  private backlog = "";
  private exited = false;
  private exitCode: number | null | undefined;
  private cols: number;
  private rows: number;

  private constructor(
    child: ChildProcessWithoutNullStreams,
    options: { cwd: string; shell: string; pty: boolean; cols: number; rows: number },
  ) {
    this.child = child;
    this.cwd = options.cwd;
    this.shell = options.shell;
    this.pty = options.pty;
    this.cols = options.cols;
    this.rows = options.rows;

    child.stdout.on("data", (chunk) => this.emit({ type: "data", data: chunk.toString("utf8") }));
    child.stderr.on("data", (chunk) => this.emit({ type: "data", data: chunk.toString("utf8") }));
    child.once("error", (err) => {
      this.emit({ type: "data", data: `native terminal error: ${err.message}\n` });
      this.finishExit(1, null);
    });
    child.once("exit", (code, signal) => {
      this.finishExit(code, signal);
    });
  }

  static start(options: { cwd: string; shell: string; pty: boolean; cols: number; rows: number }): NativeTerminalSession {
    const child = options.pty
      ? spawn("python3", ["-u", "-c", PYTHON_PTY_BRIDGE], {
          cwd: options.cwd,
          env: {
            ...process.env,
            IDEL_PTY_SHELL: options.shell,
            IDEL_PTY_COLS: String(options.cols),
            IDEL_PTY_ROWS: String(options.rows),
            SHELL: options.shell,
            TERM: process.env.TERM || "xterm-256color",
            COLORTERM: process.env.COLORTERM || "truecolor",
          },
        })
      : spawn(options.shell, ["-NoLogo"], {
          cwd: options.cwd,
          env: process.env,
          shell: false,
        });
    return new NativeTerminalSession(child, options);
  }

  info(): NativeTerminalInfo {
    return {
      id: this.id,
      cwd: this.cwd,
      shell: this.shell,
      pty: this.pty,
      cols: this.cols,
      rows: this.rows,
      pid: this.child.pid,
      startedAt: this.startedAt,
      exited: this.exited,
      exitCode: this.exitCode,
    };
  }

  subscribe(listener: NativeTerminalListener): () => void {
    this.listeners.add(listener);
    if (this.backlog) listener({ type: "data", data: this.backlog });
    if (this.exited) listener({ type: "exit", code: this.exitCode ?? null, signal: null });
    return () => {
      this.listeners.delete(listener);
    };
  }

  write(data: string): boolean {
    if (this.exited || this.child.stdin.destroyed) return false;
    if (this.pty) return this.writeFrame("d", Buffer.from(data, "utf8"));
    this.child.stdin.write(data);
    return true;
  }

  resize(cols: number, rows: number): boolean {
    const size = normalizeTerminalSize(cols, rows, this.cols, this.rows);
    this.cols = size.cols;
    this.rows = size.rows;
    if (this.exited || this.child.stdin.destroyed) return false;
    if (!this.pty) return true;
    const payload = Buffer.allocUnsafe(8);
    payload.writeUInt32BE(size.cols, 0);
    payload.writeUInt32BE(size.rows, 4);
    return this.writeFrame("r", payload);
  }

  signal(signal: NativeTerminalSignal): boolean {
    if (this.exited) return false;
    if (signal === "interrupt") {
      if (this.pty) return this.write("\x03");
      return this.killChild("SIGINT") || this.write("\x03");
    }
    const nodeSignal = nodeSignalForNativeSignal(signal);
    if (this.pty) {
      const bridgeSignal = bridgeSignalForNativeSignal(signal);
      return this.writeFrame("s", Buffer.from(bridgeSignal, "ascii"));
    }
    return this.killChild(nodeSignal);
  }

  close(): boolean {
    if (this.exited) return false;
    if (this.pty) this.signal("hangup");
    else this.killChild("SIGTERM");
    this.child.stdin.end();
    const timer = setTimeout(() => {
      if (!this.exited) this.killChild("SIGTERM");
    }, 250);
    timer.unref?.();
    return true;
  }

  private emit(event: NativeTerminalEvent): void {
    if (event.type === "data") {
      this.backlog = (this.backlog + event.data).slice(-MAX_BACKLOG_CHARS);
    }
    for (const listener of this.listeners) listener(event);
  }

  private finishExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exitCode = code;
    this.exited = true;
    this.emit({ type: "exit", code, signal });
  }

  private writeFrame(kind: "d" | "r" | "s", payload: Buffer): boolean {
    if (this.exited || this.child.stdin.destroyed) return false;
    const frame = Buffer.allocUnsafe(5 + payload.length);
    frame.writeUInt8(kind.charCodeAt(0), 0);
    frame.writeUInt32BE(payload.length, 1);
    payload.copy(frame, 5);
    this.child.stdin.write(frame);
    return true;
  }

  private killChild(signal: NodeJS.Signals): boolean {
    try {
      return this.child.kill(signal);
    } catch {
      return false;
    }
  }
}

export class NativeTerminalError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function defaultShell(isWindows: boolean): string {
  if (isWindows) return "powershell.exe";
  return process.env.SHELL || "/bin/sh";
}

function normalizeTerminalSize(
  cols: unknown,
  rows: unknown,
  fallbackCols = 80,
  fallbackRows = 24,
): { cols: number; rows: number } {
  return {
    cols: clampTerminalSize(cols, fallbackCols, 2),
    rows: clampTerminalSize(rows, fallbackRows, 1),
  };
}

function clampTerminalSize(value: unknown, fallback: number, min: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(1000, Math.floor(parsed)));
}

function nodeSignalForNativeSignal(signal: NativeTerminalSignal): NodeJS.Signals {
  switch (signal) {
    case "interrupt":
      return "SIGINT";
    case "kill":
      return "SIGKILL";
    case "hangup":
      return "SIGHUP";
    case "terminate":
    default:
      return "SIGTERM";
  }
}

function bridgeSignalForNativeSignal(signal: NativeTerminalSignal): "INT" | "TERM" | "KILL" | "HUP" {
  switch (signal) {
    case "interrupt":
      return "INT";
    case "kill":
      return "KILL";
    case "hangup":
      return "HUP";
    case "terminate":
    default:
      return "TERM";
  }
}
