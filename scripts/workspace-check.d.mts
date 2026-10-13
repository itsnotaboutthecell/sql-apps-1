export function inspectSource(home: string, options?: {
  foundation?: boolean;
  toolingHome?: string;
}): Promise<{
  home: string;
  toolingHome?: string;
  ready: boolean;
  code: string;
  fingerprint?: string;
  toolingFingerprint?: string;
}>;
