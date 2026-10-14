import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  input?: string;
  redact?: readonly string[];
  sensitiveOutput?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
}
export type Run = (command: string, args: readonly string[], options?: RunOptions) => Promise<string>;

function execute(command: string, args: readonly string[], env = process.env, options: RunOptions = {}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1_000;
  const maxOutputBytes = options.maxOutputBytes ?? 64 * 1024 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be a positive integer');
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) throw new Error('maxOutputBytes must be a positive integer');
  return new Promise((done, reject) => {
    const child = spawn(command, [...args], { shell: false, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let failure: Error | undefined;
    let outputBytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let forceTimer: NodeJS.Timeout | undefined;
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      child.kill();
      forceTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
      forceTimer.unref();
    };
    const timeout = setTimeout(() => stop(new Error(`${command} timed out after ${timeoutMs}ms`)), timeoutMs);
    timeout.unref();
    const capture = (target: Buffer[]) => (data: Buffer) => {
      outputBytes += data.byteLength;
      if (outputBytes > maxOutputBytes) {
        stop(new Error(`${command} output exceeded ${maxOutputBytes} bytes`));
        return;
      }
      target.push(data);
    };
    child.stdin.on('error', error => {
      if ((error as NodeJS.ErrnoException).code !== 'EPIPE') reject(error);
    });
    child.stdin.end(options.input);
    child.stdout.on('data', capture(stdout));
    child.stderr.on('data', capture(stderr));
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
      if (failure) {
        reject(failure);
        return;
      }
      const stdoutText = Buffer.concat(stdout).toString('utf8');
      const stderrText = Buffer.concat(stderr).toString('utf8');
      if (code !== 0) {
        let message = options.sensitiveOutput ? 'sensitive command output omitted' : stderrText.trim() || stdoutText.trim();
        for (const value of options.redact ?? []) {
          if (value) message = message.replaceAll(value, '[REDACTED]');
        }
        reject(new Error(`${command} failed (${signal ?? code}): ${message}`));
      }
      else done(stdoutText);
    });
  });
}

export const run: Run = async (command, args, options = {}) => {
  const env = { ...process.env, ...options.env };
  const azureEnv = { ...env, AZURE_EXTENSION_USE_DYNAMIC_INSTALL: 'no' };
  if (command === 'az' && process.platform === 'win32') {
    const candidates = (await execute('where.exe', ['az'])).trim().split(/\r?\n/);
    const script = candidates.find(path => path.toLowerCase().endsWith('.cmd'));
    if (!script) throw new Error('Azure CLI MSI installation required on Windows');
    const python = resolve(dirname(script), '..', 'python.exe');
    if (!existsSync(python)) throw new Error('Azure CLI bundled interpreter not found');
    return execute(python, ['-IBm', 'azure.cli', ...args], { ...azureEnv, AZ_INSTALLER: 'MSI' }, options);
  }
  return execute(command, args, command === 'az' ? azureEnv : env, options);
};
