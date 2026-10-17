export type LocalScope = 'restore' | 'build' | 'workspace' | 'sql-start' | 'schema' | 'services' | 'synthetic' | 'stop' | 'maintenance';
export interface LocalRequest { operation: string; selection?: string }
export interface Requirement {
  scope: LocalScope;
  target: string;
  effects: string[];
  contract: string;
  reusable: boolean;
}
export interface ConsentPlan {
  version: 1;
  home: string;
  request: LocalRequest;
  requirements: Requirement[];
  missing: Requirement[];
  termsRequired: boolean;
  termsAcknowledged: boolean;
  allowed: boolean;
}
export function planConsent(home: string, request: LocalRequest): Promise<ConsentPlan>;
export function grantConsent(home: string, plan: ConsentPlan, options?: { once?: boolean }): Promise<void>;
export function assertConsent(home: string, request: LocalRequest): Promise<void>;
export function revokeConsent(home: string, scope?: LocalScope | 'terms'): Promise<void>;
export function acknowledgeTerms(home: string, document: string): Promise<void>;
export const SQL_TERMS: { readonly url: string; readonly statement: string };
export interface BundleRequest { profile: 'role-based-data'; workspace?: string; sqlTarget?: import('./sql-target.mjs').SqlTarget }
export interface BundlePlan {
  version: 1;
  home: string;
  profile: BundleRequest['profile'];
  workspace: string;
  operation: 'app' | 'role-based-app';
  requirements: Requirement[];
  missing: Requirement[];
  terms: { required: boolean; url: string; statement: string; sha256: string; acknowledged: boolean };
  approval: string;
  allowed: boolean;
  sqlTarget?: import('./sql-target.mjs').SqlTarget;
}
export function planBundle(home: string, request: BundleRequest): Promise<BundlePlan>;
export function grantBundle(home: string, approved: BundleRequest & { approval: string }): Promise<void>;
