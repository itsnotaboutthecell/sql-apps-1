import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  input?: string;
  redact?: readonly string[];
  sensitiveOutput?: boolean;
}
export type Run = (command: string, args: readonly string[], options?: RunOptions) => Promise<string>;

function execute(command: string, args: readonly string[], env = process.env, options: RunOptions = {}): Promise<string> {
  return new Promise((done, reject) => {
    const child = spawn(command, [...args], { shell: false, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', error => {
      if ((error as NodeJS.ErrnoException).code !== 'EPIPE') reject(error);
    });
    child.stdin.end(options.input);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (data: string) => { stdout += data; });
    child.stderr.setEncoding('utf8').on('data', (data: string) => { stderr += data; });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code !== 0) {
        let message = options.sensitiveOutput ? 'sensitive command output omitted' : stderr.trim() || stdout.trim();
        for (const value of options.redact ?? []) {
          if (value) message = message.replaceAll(value, '[REDACTED]');
        }
        reject(new Error(`${command} failed (${signal ?? code}): ${message}`));
      }
      else done(stdout);
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
