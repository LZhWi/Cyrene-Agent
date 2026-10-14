"use strict";
const http = require('node:http');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
const { createTokenStore } = require('./token-store.cjs');
const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const random = () => randomBytes(32).toString('base64url');

function createOAuth({ secrets, storage, fetchImpl = fetch, jwks }) {
  const store = createTokenStore(secrets, storage);
  let host = storage.get('official.host');
  let pending, refreshFlight;
  async function postToken(body) {
    const r = await fetchImpl(`${ISSUER}/api/accounts/oauth/token`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...body, resource: RESOURCE }),
    });
    if (!r.ok) throw new Error(`OAuth token exchange failed (${r.status}); please sign in again.`);
    return r.json();
  }
  async function verify(idToken, clientId, nonce) {
    const jose = await import('jose');
    jwks ||= jose.createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));
    const { payload } = await jose.jwtVerify(idToken, jwks, {
      issuer: ISSUER, audience: clientId, requiredClaims: ['sub', 'exp', 'iat'], clockTolerance: 5,
    });
    if (!payload.sub || payload.nonce !== nonce) throw new Error('OAuth identity/nonce mismatch');
    return payload;
  }
  function credentials(t, previous = {}) {
    if (!t.access_token || !Number.isFinite(t.expires_in) || t.expires_in <= 0) throw new Error('Invalid OAuth token response');
    return { ...previous, accessToken: t.access_token, refreshToken: t.refresh_token || previous.refreshToken,
      idToken: t.id_token || previous.idToken, scope: t.scope === undefined ? previous.scope : t.scope,
      expiresAt: Date.now() + t.expires_in * 1000 };
  }
  async function begin() {
    if (pending) throw new Error('A sign-in attempt is already open');
    if (!host) { host = `urn:uuid:${randomUUID()}`; storage.set('official.host', host); }
    const previous = await store.get('official');
    const state = random(), nonce = random(), verifier = random();
    let resolve, reject;
    const completion = new Promise((a, b) => { resolve = a; reject = b; });
    // The UI may wait separately; cancellation must not become an unhandled rejection.
    completion.catch(() => {});
    let consumed = false, timer;
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method !== 'GET' || url.pathname !== '/auth/callback') { res.writeHead(404).end(); return; }
      if (consumed || url.searchParams.get('state') !== state) { res.writeHead(400).end('Invalid authorization state'); return; }
      consumed = true;
      try {
        if (url.searchParams.has('error')) throw new Error('Authorization declined; no credentials saved');
        const clientId = url.searchParams.get('client_id') || previous?.clientId;
        if (!clientId || clientId === 'dynamic_agent_client' || (previous && clientId !== previous.clientId)) throw new Error('OAuth client mismatch');
        const code = url.searchParams.get('code');
        if (!code) throw new Error('Missing authorization code');
        const t = await postToken({ grant_type: 'authorization_code', client_id: clientId, code,
          code_verifier: verifier, redirect_uri: redirectUri });
        const identity = await verify(t.id_token, clientId, nonce);
        if (previous && previous.subject !== identity.sub) throw new Error('OAuth account mismatch');
        const record = credentials(t, { clientId, subject: identity.sub, host,
          accountId: createHash('sha256').update(`${clientId}:${identity.sub}`).digest('hex'),
          accountLabel: identity.email || identity.sub });
        await store.set('official', record);
        res.end('Sign-in complete. Return to Cyrene.'); resolve(await status());
      } catch (e) { res.writeHead(400).end('Sign-in failed. Return to Cyrene.'); reject(e); }
      finally { clearTimeout(timer); server.close(); pending = null; }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const redirectUri = `http://127.0.0.1:${server.address().port}/auth/callback`;
    const url = new URL(`${ISSUER}/api/accounts/authorize`);
    url.search = new URLSearchParams({ client_id: previous?.clientId || 'dynamic_agent_client',
      ...(!previous ? { agent_name_hint: 'Cyrene' } : { id_token_hint: previous.idToken }),
      ext_agent_host_id: host, response_type: 'code', redirect_uri: redirectUri, scope: SCOPE,
      resource: RESOURCE, state, nonce, code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url') }).toString();
    const cancel = () => { consumed = true; clearTimeout(timer); server.closeAllConnections(); server.close(); pending = null; reject(new Error('Sign-in cancelled or expired')); };
    timer = setTimeout(cancel, 5 * 60 * 1000); timer.unref();
    pending = { cancel };
    return { url: url.toString(), completion, cancel };
  }
  async function status() {
    const t = await store.get('official');
    return { connected: !!t, planEnabled: !!t?.scope?.split(' ').includes('chatgpt.tokens.use.direct'), label: t?.accountLabel };
  }
  async function accessToken() {
    let t = await store.get('official');
    if (!t?.scope?.split(' ').includes('chatgpt.tokens.use.direct')) throw new Error('Sign in and authorize ChatGPT plan usage first');
    if (t.expiresAt <= Date.now() + 60000) {
      if (!t.refreshToken) throw new Error('Please sign in again');
      if (!refreshFlight) refreshFlight = (async () => {
        const result = await postToken({ grant_type: 'refresh_token', client_id: t.clientId, refresh_token: t.refreshToken });
        const next = credentials(result, t);
        await store.updateAccount('official', t.accountId, next);
        return next;
      })().finally(() => { refreshFlight = null; });
      t = await refreshFlight;
    }
    if (!t.scope?.split(' ').includes('chatgpt.tokens.use.direct')) throw new Error('ChatGPT plan permission is no longer granted');
    return t.accessToken;
  }
  return { begin, status, accessToken, dispose: () => pending?.cancel() };
}
module.exports = { createOAuth, ISSUER, RESOURCE, SCOPE };
