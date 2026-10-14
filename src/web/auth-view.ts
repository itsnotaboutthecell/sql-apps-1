import { ApiError } from '../client.js';
import { SessionExpiredError } from './session.js';

export type AuthState =
  | { kind: 'signed-out' | 'signing-in' | 'signing-out' | 'expired' }
  | { kind: 'checking' | 'authorized' | 'forbidden'; name: string }
  | { kind: 'unavailable'; name?: string };

export interface AuthElements {
  login: { hidden: boolean; disabled: boolean; textContent: string | null };
  logout: { hidden: boolean; disabled: boolean; textContent: string | null };
  retry: { hidden: boolean; disabled: boolean };
  status: { textContent: string | null };
  workspace: { hidden: boolean };
}

export function authenticationErrorMessage(error: unknown, mode: 'local' | 'entra' = 'entra'): string {
  if (error instanceof SessionExpiredError || (error instanceof ApiError && error.status === 401)) {
    return mode === 'local' ? 'Your test session expired. Sign in again.' : 'Your session expired. Sign in again.';
  }
  if (error instanceof ApiError && error.status === 403) return 'This action is not permitted for the current session.';
  if (error instanceof ApiError && error.status >= 500) return `Backend service is unavailable (${error.status}). Try again.`;
  return error instanceof Error ? error.message : 'Operation failed';
}

export function renderAuthentication(elements: AuthElements, mode: 'local' | 'entra', state: AuthState): void {
  const busy = state.kind === 'signing-in' || state.kind === 'signing-out' || state.kind === 'checking';
  const named = 'name' in state && Boolean(state.name);
  elements.login.textContent = mode === 'local' ? 'Sign in' : 'Sign in with Microsoft';
  elements.logout.textContent = 'Sign out';
  elements.login.hidden = state.kind !== 'signed-out' && state.kind !== 'expired' && state.kind !== 'signing-in';
  elements.logout.hidden = state.kind !== 'authorized' && state.kind !== 'forbidden' && state.kind !== 'signing-out' &&
    !(state.kind === 'unavailable' && named);
  elements.retry.hidden = state.kind !== 'unavailable';
  elements.login.disabled = elements.logout.disabled = elements.retry.disabled = busy;
  elements.workspace.hidden = state.kind !== 'authorized';
  switch (state.kind) {
    case 'signed-out':
      elements.status.textContent = mode === 'local'
        ? 'Sign in to use this application. This local session uses a test account.'
        : 'Sign in to use this application.';
      break;
    case 'signing-in':
      elements.status.textContent = mode === 'local' ? 'Signing in...' : 'Starting Microsoft sign-in...';
      break;
    case 'signing-out':
      elements.status.textContent = 'Signing out...';
      break;
    case 'checking':
      elements.status.textContent = 'Checking application access...';
      break;
    case 'authorized':
      elements.status.textContent = `Signed in as ${state.name}`;
      break;
    case 'forbidden':
      elements.status.textContent = mode === 'local' ? `Signed in as ${state.name}. Your account does not have access to this app.` :
        `Signed in as ${state.name}. You do not have access to this app. Ask the app owner for access.`;
      break;
    case 'expired':
      elements.status.textContent = mode === 'local' ? 'Your test session expired. Sign in again.' :
        'Your session expired. Sign in again.';
      break;
    case 'unavailable':
      elements.status.textContent = 'Application access could not be confirmed. Try again.';
      break;
  }
}
