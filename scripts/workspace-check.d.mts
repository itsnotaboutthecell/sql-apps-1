export function inspectSource(home: string, options?: {
  foundation?: boolean;
  toolingHome?: string;
}): Promise<{
  home: string;
  toolingHome?: string;
  bootstrap?: boolean;
  ready: boolean;
  code: string;
  fingerprint?: string;
  toolingFingerprint?: string;
}>;
