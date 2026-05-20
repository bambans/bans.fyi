export type ContentFile = {
  path: string;
  name: string;
  size: number;
  title?: string;
  status?: string;
  tags?: string[];
};

const DEFAULT_API_BASE = 'https://api.bans.fyi';
export const API_BASE = import.meta.env.VITE_API_BASE_URL || DEFAULT_API_BASE;

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export const api = {
  files: () => request<{ files: ContentFile[] }>('/api/files'),
  file: (path: string) => request<{ path: string; content: string }>(`/api/file?path=${encodeURIComponent(path)}`),
  graph: () => request<{ nodes: Array<{ id: string; title: string; path: string }>; edges: Array<{ from: string; to: string }> }>('/api/graph'),
  me: () => request<{ authenticated: boolean; user?: { login: string; avatar_url?: string } }>('/api/auth/me'),
  createFile: (path: string, content: string) => request('/api/admin/file', { method: 'POST', body: JSON.stringify({ path, content }) }),
  updateFile: (path: string, content: string) => request('/api/admin/file', { method: 'PUT', body: JSON.stringify({ path, content }) }),
  deleteFile: (path: string) => request('/api/admin/file', { method: 'DELETE', body: JSON.stringify({ path }) }),
  logout: () => request('/api/auth/logout', { method: 'POST' })
};
