import { deploymentSchema, type DeploymentConfig } from './config.js';
import type { Run } from './process.js';
import { roleBasedSchemaFingerprint } from './role-based-profile.js';
import { realpath } from 'node:fs/promises';
import { toolingAsset } from './runtime-roots.js';

export const imageFields = ['gatewayImage', 'dabImage', 'functionsImage'] as const;
export function deploymentImageFields(config: DeploymentConfig) {
  return config.profile === 'role-based-data' ? imageFields.slice(0, 2) : [...imageFields];
}
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

export async function buildArtifacts(config: DeploymentConfig, run: Run): Promise<DeploymentConfig> {
  const fields = deploymentImageFields(config);
  const root = await realpath(process.env.SQL_APPS_PROJECT_HOME ?? process.cwd());
  const source = config.profile === 'role-based-data' ? await roleBasedSchemaFingerprint(root) : undefined;
  if (fields.some(field => config[field].includes('@'))) {
    throw new Error('Artifact builds require new version tags for every selected image, not digests');
  }
  if (new Set(fields.map(field => config[field])).size !== fields.length) {
    throw new Error('Artifact builds require distinct references for every selected service image');
  }
  await run('az', ['acr', 'show', '--subscription', config.subscriptionId,
    '--resource-group', config.resourceGroup, '--name', config.registryServer.split('.')[0]!, '-o', 'none']);
  const dockerfiles = [
    toolingAsset('Dockerfile'),
    toolingAsset('dab', 'Dockerfile'),
    toolingAsset('functions', 'Dockerfile'),
  ];
  const pinned = { ...config };
  for (const [index, field] of fields.entries()) {
    await run('az', ['acr', 'build', '--subscription', config.subscriptionId,
      '--registry', config.registryServer.split('.')[0]!, '--image', config[field].slice(config.registryServer.length + 1),
      '--file', dockerfiles[index]!, root]);
    pinned[field] = await imageDigest(config[field], config, run);
  }
  if (source !== undefined && source !== await roleBasedSchemaFingerprint(root)) {
    throw new Error('Role-based SQL/DAB source changed during artifact publication; published images may exist but configuration was not updated');
  }
  return deploymentSchema.parse(pinned);
}
