import { createHash, randomBytes } from 'node:crypto';
import { SCOPES } from './gmail/client.js';

export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function authUrl({ clientId, redirectUri, state, challenge }: { clientId: string; redirectUri: string; state: string; challenge: string }): string {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent select_account',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}

/** Google's granular consent lets users untick scopes; the token response lists what was actually granted. */
export function missingScopes(granted: string | null | undefined): string[] {
  const set = new Set((granted ?? '').split(/\s+/).filter(Boolean));
  return SCOPES.filter(scope => !set.has(scope));
}
