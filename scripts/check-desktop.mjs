import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
const output = resolve(import.meta.dirname, '../dist/installers');
const macFolder = process.arch === 'arm64' ? 'mac-arm64' : 'mac';
const executable = process.platform === 'win32' ? join(output, 'win-unpacked/OpenExecution IDEL.exe')
  : process.platform === 'darwin' ? join(output, macFolder, 'OpenExecution IDEL.app/Contents/MacOS/OpenExecution IDEL')
  : join(output, 'linux-unpacked/idel-desktop');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const args = ['--idel-smoke', ...(process.platform === 'linux' ? ['--ozone-platform=headless', '--disable-gpu'] : [])];
const child = spawn(executable, args, { env, stdio: 'inherit', cwd: output });
const timer = setTimeout(() => { child.kill('SIGKILL'); process.exitCode = 1; }, 45000);
child.on('error', error => { clearTimeout(timer); console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
