/**
 * Tiny typed fetch wrapper. Sends cookies, parses JSON, surfaces error messages.
 *
 * When VITE_API_BASE is set (e.g. for a GitHub Pages demo pointing at a remote
 * backend), the client switches to Bearer-token auth stored in localStorage so
 * cross-origin requests work without SameSite cookie issues.
 */
export interface ApiResult<T> { ok: boolean; data?: T; error?: string }

const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';
const STORAGE_KEY = 'keres_token';

function getStoredToken(): string | null {
  return API_BASE ? localStorage.getItem(STORAGE_KEY) : null;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
  /* Hard timeout so a stalled request (cold start, flaky network, blocked
     XHR) can never leave the UI hanging forever — it settles as an error. */
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const storedToken = getStoredToken();
    if (storedToken) headers['Authorization'] = `Bearer ${storedToken}`;

    const init: RequestInit = {
      method,
      credentials: API_BASE ? 'omit' : 'include',
      headers,
      signal: controller.signal,
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(`${API_BASE}/api${path}`, init);
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok || json.ok === false) {
      return { ok: false, error: json.error ?? `HTTP ${res.status}`, data: json };
    }
    return { ok: true, data: json as T };
  } catch (e: any) {
    return { ok: false, error: e?.name === 'AbortError' ? 'timeout' : (e?.message ?? 'network_error') };
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  get:   <T = any>(p: string) => request<T>('GET', p),
  post:  <T = any>(p: string, b?: unknown) => request<T>('POST', p, b),
  put:   <T = any>(p: string, b?: unknown) => request<T>('PUT', p, b),
  patch: <T = any>(p: string, b?: unknown) => request<T>('PATCH', p, b),
  del:   <T = any>(p: string) => request<T>('DELETE', p),
};

export async function login(token: string): Promise<boolean> {
  if (API_BASE) {
    // Cross-origin mode: validate token via a real API call, then store it.
    localStorage.setItem(STORAGE_KEY, token);
    const r = await api.get('/settings');
    if (!r.ok) { localStorage.removeItem(STORAGE_KEY); return false; }
    return true;
  }
  const r = await api.post('/auth/login', { token });
  return !!r.ok;
}

export async function logout(): Promise<void> {
  if (API_BASE) { localStorage.removeItem(STORAGE_KEY); return; }
  await api.post('/auth/logout');
}

/** True when a stored token exists (cross-origin mode) or when a session cookie may be present. */
export function hasCachedSession(): boolean {
  return API_BASE ? !!localStorage.getItem(STORAGE_KEY) : true;
}
