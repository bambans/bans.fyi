type Env = {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_ALLOWED_USER: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  GITHUB_BRANCH: string;
  GITHUB_REPO_TOKEN: string;
  SESSION_SECRET: string;
  APP_ORIGIN: string;
};

type GitHubContentFile = {
  path: string;
  name: string;
  size: number;
  type: string;
  sha: string;
};

type Session = {
  login: string;
  avatar_url?: string;
  exp: number;
};

const CONTENT_PREFIX = 'content/';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      if (request.method === 'OPTIONS') return corsResponse(request, env);

      const url = new URL(request.url);
      const path = url.pathname;

      if (path === '/api/auth/login') return authLogin(env);
      if (path === '/api/auth/callback') return authCallback(request, env);
      if (path === '/api/auth/me') return authMe(request, env);
      if (path === '/api/auth/logout') return authLogout(request, env);

      if (path === '/api/files' && request.method === 'GET') return withCors(request, env, await listFiles(env));
      if (path === '/api/file' && request.method === 'GET') return withCors(request, env, await getFile(request, env));
      if (path === '/api/graph' && request.method === 'GET') return withCors(request, env, await getGraph(env));

      if (path === '/api/admin/file') {
        const session = await requireSession(request, env);
        if (!session) return withCors(request, env, json({ error: 'Unauthorized' }, 401));

        if (request.method === 'POST') return withCors(request, env, await createOrUpdateFile(request, env, false));
        if (request.method === 'PUT') return withCors(request, env, await createOrUpdateFile(request, env, true));
        if (request.method === 'DELETE') return withCors(request, env, await deleteFile(request, env));
      }

      return withCors(request, env, json({ error: 'Not found' }, 404));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return withCors(request, env, json({ error: message }, 500));
    }
  }
};

async function authLogin(env: Env): Promise<Response> {
  const state = crypto.randomUUID();
  const authorize = new URL('https://github.com/login/oauth/authorize');
  authorize.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  authorize.searchParams.set('redirect_uri', `${apiOrigin(env)}/api/auth/callback`);
  authorize.searchParams.set('scope', 'read:user');
  authorize.searchParams.set('state', state);

  return new Response(null, {
    status: 302,
    headers: {
      location: authorize.toString(),
      'set-cookie': cookie('oauth_state', state, { httpOnly: true, maxAge: 600, sameSite: 'Lax' })
    }
  });
}

async function authCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const expectedState = getCookie(request, 'oauth_state');

  if (!code || !state || !expectedState || state !== expectedState) {
    return redirectWithError(env, 'Invalid OAuth state.');
  }

  const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${apiOrigin(env)}/api/auth/callback`
    })
  });

  const tokenData = await tokenResponse.json() as { access_token?: string; error_description?: string };
  if (!tokenData.access_token) return redirectWithError(env, tokenData.error_description || 'GitHub OAuth failed.');

  const userResponse = await fetch('https://api.github.com/user', {
    headers: githubHeaders(tokenData.access_token)
  });
  const user = await userResponse.json() as { login?: string; avatar_url?: string };

  if (!user.login || user.login.toLowerCase() !== env.GITHUB_ALLOWED_USER.toLowerCase()) {
    return redirectWithError(env, 'This GitHub account is not allowed.');
  }

  const session: Session = {
    login: user.login,
    avatar_url: user.avatar_url,
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7
  };

  const signed = await signSession(session, env.SESSION_SECRET);

  return new Response(null, {
    status: 302,
    headers: {
      location: `${env.APP_ORIGIN}/#/admin`,
      'set-cookie': cookie('session', signed, { httpOnly: true, maxAge: 60 * 60 * 24 * 7, sameSite: 'Lax' })
    }
  });
}

async function authMe(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env);
  if (!session) return withCors(request, env, json({ authenticated: false }));
  return withCors(request, env, json({ authenticated: true, user: { login: session.login, avatar_url: session.avatar_url } }));
}

function authLogout(request: Request, env: Env): Response {
  return withCors(request, env, json({ ok: true }, 200, {
    'set-cookie': cookie('session', '', { httpOnly: true, maxAge: 0, sameSite: 'Lax' })
  }));
}

async function listFiles(env: Env): Promise<Response> {
  const tree = await githubJson<{ tree: GitHubContentFile[] }>(env, `/git/trees/${encodeURIComponent(env.GITHUB_BRANCH)}?recursive=1`);
  const mdFiles = tree.tree
    .filter((item) => item.type === 'blob' && isAllowedMarkdownPath(item.path))
    .map((item) => ({ path: item.path, name: item.path.split('/').pop() || item.path, size: item.size || 0 }));

  const files = await Promise.all(mdFiles.map(async (file) => {
    try {
      const content = await readRawFile(env, file.path);
      const metadata = parseFrontmatter(content);
      return { ...file, ...metadata };
    } catch {
      return file;
    }
  }));

  return json({ files: files.filter((file) => file.status !== 'private' && file.status !== 'draft') });
}

async function getFile(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.searchParams.get('path');
  assertAllowedPath(path);
  const content = await readRawFile(env, path!);
  return json({ path, content });
}

async function getGraph(env: Env): Promise<Response> {
  const filesResponse = await listFiles(env);
  const { files } = await filesResponse.json() as { files: Array<{ path: string; title?: string; name: string }> };
  const nodes = files.map((file) => ({ id: file.path, path: file.path, title: file.title || file.name }));
  const existing = new Set(nodes.map((node) => node.path));
  const edges: Array<{ from: string; to: string }> = [];

  for (const file of files) {
    const content = await readRawFile(env, file.path);
    const links = extractWikiLinks(content);
    for (const link of links) {
      const target = wikiTargetToPath(link);
      if (existing.has(target)) edges.push({ from: file.path, to: target });
    }
  }

  return json({ nodes, edges });
}

async function createOrUpdateFile(request: Request, env: Env, updateOnly: boolean): Promise<Response> {
  const body = await request.json() as { path?: string; content?: string };
  assertAllowedPath(body.path);
  if (typeof body.content !== 'string') throw new Error('Missing content.');

  let sha: string | undefined;
  const existing = await getContentMetadata(env, body.path!);

  if (updateOnly && !existing?.sha) throw new Error('File does not exist.');
  if (!updateOnly && existing?.sha) throw new Error('File already exists. Use update instead.');
  if (existing?.sha) sha = existing.sha;

  const result = await githubJson(env, `/contents/${encodePath(body.path!)}`, {
    method: 'PUT',
    body: JSON.stringify({
      message: `${sha ? 'Update' : 'Create'} ${body.path}`,
      content: bytesToBase64(new TextEncoder().encode(body.content)),
      branch: env.GITHUB_BRANCH,
      ...(sha ? { sha } : {})
    })
  });

  return json({ ok: true, result });
}

async function deleteFile(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as { path?: string };
  assertAllowedPath(body.path);
  const existing = await getContentMetadata(env, body.path!);
  if (!existing?.sha) throw new Error('File does not exist.');

  const result = await githubJson(env, `/contents/${encodePath(body.path!)}`, {
    method: 'DELETE',
    body: JSON.stringify({
      message: `Delete ${body.path}`,
      sha: existing.sha,
      branch: env.GITHUB_BRANCH
    })
  });

  return json({ ok: true, result });
}

async function readRawFile(env: Env, path: string): Promise<string> {
  assertAllowedPath(path);
  const response = await githubFetch(env, `/contents/${encodePath(path)}`, {
    headers: { accept: 'application/vnd.github.raw+json' }
  });
  if (!response.ok) throw new Error(`GitHub read failed: ${response.status}`);
  return response.text();
}

async function getContentMetadata(env: Env, path: string): Promise<{ sha?: string } | null> {
  const response = await githubFetch(env, `/contents/${encodePath(path)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub metadata failed: ${response.status}`);
  return response.json() as Promise<{ sha?: string }>;
}

async function githubJson<T = unknown>(env: Env, apiPath: string, init: RequestInit = {}): Promise<T> {
  const response = await githubFetch(env, apiPath, init);
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = data?.message || `GitHub API failed: ${response.status}`;
    throw new Error(message);
  }
  return data as T;
}

function githubFetch(env: Env, apiPath: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers || {});
  const defaultHeaders = githubHeaders(env.GITHUB_REPO_TOKEN);
  for (const [key, value] of Object.entries(defaultHeaders)) headers.set(key, value);

  return fetch(`https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}${apiPath}`, {
    ...init,
    headers
  });
}

function githubHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'bans-fyi-worker',
    'x-github-api-version': '2022-11-28'
  };
}

function assertAllowedPath(path: string | null | undefined): asserts path is string {
  if (!path) throw new Error('Missing path.');
  if (!isAllowedMarkdownPath(path)) throw new Error('Only content/**/*.md files are allowed.');
  if (path.includes('..') || path.startsWith('/')) throw new Error('Invalid path.');
}

function isAllowedMarkdownPath(path: string): boolean {
  return path.startsWith(CONTENT_PREFIX) && path.endsWith('.md') && !path.includes('..');
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function parseFrontmatter(markdown: string): Record<string, unknown> {
  if (!markdown.startsWith('---')) return {};
  const end = markdown.indexOf('\n---', 3);
  if (end === -1) return {};
  const raw = markdown.slice(3, end).trim();
  const result: Record<string, unknown> = {};

  for (const line of raw.split('\n')) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const [, key, value] = match;
    if (value.startsWith('[') && value.endsWith(']')) {
      result[key] = value.slice(1, -1).split(',').map((v) => v.trim()).filter(Boolean);
    } else {
      result[key] = value.replace(/^['"]|['"]$/g, '');
    }
  }

  return result;
}

function extractWikiLinks(markdown: string): string[] {
  const regex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  const links: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(markdown))) links.push(match[1].trim());
  return links;
}

function wikiTargetToPath(target: string): string {
  const clean = target.replace(/^content\//, '').replace(/\.md$/, '');
  if (clean === 'index') return 'content/index.md';
  if (clean.includes('/')) return `content/${clean}.md`;
  return `content/notes/${clean}.md`;
}

async function requireSession(request: Request, env: Env): Promise<Session | null> {
  const raw = getCookie(request, 'session');
  if (!raw) return null;
  const session = await verifySession(raw, env.SESSION_SECRET);
  if (!session) return null;
  if (session.exp < Math.floor(Date.now() / 1000)) return null;
  if (session.login.toLowerCase() !== env.GITHUB_ALLOWED_USER.toLowerCase()) return null;
  return session;
}

async function signSession(session: Session, secret: string): Promise<string> {
  const payload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(session)));
  const signature = await hmac(payload, secret);
  return `${payload}.${signature}`;
}

async function verifySession(value: string, secret: string): Promise<Session | null> {
  const [payload, signature] = value.split('.');
  if (!payload || !signature) return null;
  const expected = await hmac(payload, secret);
  if (signature !== expected) return null;
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload))) as Session;
}

async function hmac(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(signature));
}

function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function cookie(name: string, value: string, options: { httpOnly?: boolean; maxAge?: number; sameSite?: 'Lax' | 'Strict' | 'None' } = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'Secure'];
  if (options.httpOnly) parts.push('HttpOnly');
  if (typeof options.maxAge === 'number') parts.push(`Max-Age=${options.maxAge}`);
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  return parts.join('; ');
}

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers }
  });
}

function corsResponse(request: Request, env: Env): Response {
  return withCors(request, env, new Response(null, { status: 204 }));
}

function withCors(request: Request, env: Env, response: Response): Response {
  const origin = request.headers.get('origin');
  const allowedOrigin = env.APP_ORIGIN;
  const headers = new Headers(response.headers);

  if (origin === allowedOrigin) {
    headers.set('access-control-allow-origin', allowedOrigin);
    headers.set('access-control-allow-credentials', 'true');
    headers.set('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS');
    headers.set('access-control-allow-headers', 'content-type');
  }

  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function redirectWithError(env: Env, message: string): Response {
  return new Response(null, { status: 302, headers: { location: `${env.APP_ORIGIN}/#/admin?error=${encodeURIComponent(message)}` } });
}

function apiOrigin(env: Env): string {
  return env.APP_ORIGIN.replace('https://', 'https://api.');
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
