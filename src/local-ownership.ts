import { z } from 'zod';
import type { Run } from './process.js';
import { runtimeFor, portState, type WorkspaceRuntime } from './workspace.mjs';

export async function verifyContainerWorkspace(
  name: string, runtime: WorkspaceRuntime, image: string | RegExp,
  ports: Record<string, number>, runner: Run,
): Promise<void> {
  if (runtime.mode !== 'isolated') return;
  const details = z.object({
    workspace: z.string(), image: z.string(),
    ports: z.record(z.string(), z.array(z.object({ HostIp: z.string(), HostPort: z.string() })).nullable()),
  }).parse(JSON.parse(await runner('docker', ['inspect', name, '--format',
    '{"workspace":{{json (index .Config.Labels "sql-apps.workspace")}},"image":{{json .Config.Image}},"ports":{{json .HostConfig.PortBindings}}}'])));
  if (details.workspace !== runtime.id) throw new Error(`Container ${name} belongs to another workspace; refusing to modify it`);
  if (typeof image === 'string' ? details.image !== image : !image.test(details.image)) {
    throw new Error(`Container ${name} has an unexpected image; review its provenance before modifying it`);
  }
  for (const [internal, external] of Object.entries(ports)) {
    const bindings = details.ports[internal];
    if (!bindings?.length || bindings.some(binding => binding.HostIp !== '127.0.0.1' || binding.HostPort !== String(external))) {
      throw new Error(`Container ${name} has unexpected published ports; refusing to modify it`);
    }
  }
}

export async function checkWorkspacePorts(container: string, runner: Run, images: Record<string, string | RegExp>): Promise<void> {
  const runtime = runtimeFor(container);
  if (runtime.mode !== 'isolated') return;
  const components: [number | null, string | null, string | null][] = [
    [runtime.ports.internalGateway ?? runtime.ports.gateway, null, null],
    [runtime.ports.data, runtime.names.data, 'data'],
  ];
  if (runtime.ownsSqlName) components.push([runtime.ports.sql, container, 'sql']);
  for (const [port, name, role] of components) {
    if (port === null) continue;
    const state = await portState(port);
    if (state === 'free') continue;
    if (state !== 'occupied' || name === null) {
      throw new Error(`Port ${port} is occupied or unverifiable. Confirm and reuse the intended gateway instead of restarting services; do not stop unrelated processes.`);
    }
    const present = (await runner('docker', ['ps', '--filter', `name=^/${name}$`, '--format', '{{.Names}}'])).trim();
    if (present !== name) throw new Error(`Port ${port} is used by another service; choose an approved free workspace port block before startup.`);
    const owner = z.object({ workspace: z.string(), role: z.string(), image: z.string(), ports: z.record(z.string(),
      z.array(z.object({ HostIp: z.string(), HostPort: z.string() })).nullable()) })
      .parse(JSON.parse(await runner('docker', ['inspect', name, '--format',
        '{"workspace":{{json (index .Config.Labels "sql-apps.workspace")}},"role":{{json (index .Config.Labels "sql-apps.local")}},"image":{{json .Config.Image}},"ports":{{json .HostConfig.PortBindings}}}'])));
    const expectedImage = role ? images[role] : undefined;
    if (owner.workspace !== runtime.id || owner.role !== role ||
        !expectedImage || (typeof expectedImage === 'string' ? owner.image !== expectedImage : !expectedImage.test(owner.image)) ||
        !Object.values(owner.ports).some(bindings => bindings?.some(binding => binding.HostIp === '127.0.0.1' && binding.HostPort === String(port)))) {
      throw new Error(`Port ${port} ownership does not match this workspace; no services were changed.`);
    }
  }
}
