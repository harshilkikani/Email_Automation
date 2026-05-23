/**
 * Tiny typed fetch wrapper. Sends cookies, parses JSON, surfaces error messages.
 */
export interface ApiResult<T> { ok: boolean; data?: T; error?: string }

async function request<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
  try {
    const init: RequestInit = {
      method,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(`/api${path}`, init);
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok || json.ok === false) {
      return { ok: false, error: json.error ?? `HTTP ${res.status}`, data: json };
    }
    return { ok: true, data: json as T };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'network_error' };
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
  const r = await api.post('/auth/login', { token });
  return !!r.ok;
}

export async function logout(): Promise<void> {
  await api.post('/auth/logout');
}
