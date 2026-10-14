import { createHash } from 'node:crypto';

export function deploymentName(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^[^a-z]+/, '').replace(/-+$/, '');
  if (!/^[a-z][a-z0-9-]{2,}$/.test(normalized)) {
    throw new Error('Could not derive a deployment name; pass --name <at least 3 lowercase letters, digits or hyphens>.');
  }
  if (normalized.length <= 20) return normalized;
  const suffix = createHash('sha256').update(normalized).digest('hex').slice(0, 6);
  return `${normalized.slice(0, 13).replace(/-+$/, '')}-${suffix}`;
}
