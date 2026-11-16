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

/** Validate a loopback redirect (from the local listener or pasted by the user) and return its code. */
export function parseCallback(input: string, state: string): string {
  let url: URL;
  try { url = new URL(input.trim()); }
  catch { throw new Error('That is not a URL. Paste the full address from the browser, starting with http://127.0.0.1'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Expected the http://127.0.0.1:… address the browser was redirected to');
  }
  const params = url.searchParams;
  if (params.get('state') !== state) throw new Error('OAuth state mismatch: stale or forged redirect. Run the command again.');
  const error = params.get('error');
  if (error) throw new Error(`Google sign-in failed: ${error.replace(/[^\w.-]/g, '').slice(0, 100)}`);
  const code = params.get('code');
  if (!code) throw new Error('No authorisation code in the redirect');
  return code;
}
