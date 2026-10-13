import { deploymentSchema, type DeploymentConfig } from './config.js';
import type { Run } from './process.js';
import { roleBasedSchemaFingerprint } from './role-based-profile.js';
import { realpath } from 'node:fs/promises';
import { toolingAsset } from './runtime-roots.js';

export const imageFields = ['gatewayImage', 'dabImage'] as const;
export const pinnedDabImage = 'mcr.microsoft.com/azure-databases/data-api-builder:2.0.12@sha256:85db5c7f1af9d0bc93af824a0602285880a07dba210854bc68394e08d9d338ac';

export async function imageDigest(image: string, config: DeploymentConfig, run: Run): Promise<string> {
  const reference = image.slice(config.registryServer.length + 1);
  const digest = (await run('az', ['acr', 'repository', 'show',
    '--subscription', config.subscriptionId, '--name', config.registryServer.split('.')[0]!,
    '--image', reference, '--query', 'digest', '-o', 'tsv'])).trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error(`ACR returned an invalid digest for ${reference}`);
  if (image.includes('@') && image.split('@')[1] !== digest) throw new Error(`ACR digest mismatch for ${reference}`);
  const repository = reference.split('@')[0]!.split(':')[0]!;
  return `${config.registryServer}/${repository}@${digest}`;
}

export async function buildArtifacts(config: DeploymentConfig, run: Run, now = new Date()): Promise<DeploymentConfig> {
  const fields = imageFields;
  const root = await realpath(process.env.SQL_APPS_PROJECT_HOME ?? process.cwd());
  const source = await roleBasedSchemaFingerprint(root);
  // Pinned images are rebuilt under a fresh timestamp tag so an update never overwrites a published tag.
  const tag = now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-').toLowerCase();
  const target = { ...config };
  for (const field of fields) if (config[field].includes('@')) target[field] = `${config[field].split('@')[0]!.replace(/:[^:/]+$/, '')}:${tag}`;
  if (new Set(fields.map(field => target[field])).size !== fields.length) {
    throw new Error('Artifact builds require distinct references for every selected service image');
  }
  await run('az', ['acr', 'show', '--subscription', config.subscriptionId,
    '--resource-group', config.resourceGroup, '--name', config.registryServer.split('.')[0]!, '-o', 'none']);
  const dockerfiles = [toolingAsset('Dockerfile'), toolingAsset('dab', 'Dockerfile')];
  const pinned = { ...config, imageSource: source };
  for (const [index, field] of fields.entries()) {
    await run('az', ['acr', 'build', '--subscription', config.subscriptionId,
      '--registry', config.registryServer.split('.')[0]!, '--image', target[field].slice(config.registryServer.length + 1),
      '--file', dockerfiles[index]!, root]);
    pinned[field] = await imageDigest(target[field], config, run);
  }
  if (source !== await roleBasedSchemaFingerprint(root)) {
    throw new Error('Role-based SQL/DAB source changed during artifact publication; published images may exist but configuration was not updated');
  }
  return deploymentSchema.parse(pinned);
}
