// Thin client for the EvoFlow Worker API. Same-origin, authenticated by the HttpOnly login cookie.

/** The server wants a login (missing, expired or invalidated cookie). */
export class AuthError extends Error {}

/** Any other non-2xx answer. `message` is the server's own error text when it sent one. */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const TIMEOUT_MS = 15_000;

async function request(method, path, body) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    // A hung request must not stall the polling loop.
    signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(TIMEOUT_MS) : undefined,
  });
  if (res.status === 401) throw new AuthError(await errorText(res));
  if (!res.ok) throw new HttpError(res.status, await errorText(res));
  return res.status === 204 ? null : res.json();
}

async function errorText(res) {
  try {
    return (await res.json()).error ?? res.statusText;
  } catch {
    return res.statusText;
  }
}

const sessionPath = (key, action) => `/api/sessions/${encodeURIComponent(key)}/${action}`;

export const getSessions = () => request('GET', '/api/sessions');
export const login = (password) => request('POST', '/api/login', { password });
export const logout = () => request('POST', '/api/logout');
export const dismiss = (key) => request('POST', sessionPath(key, 'dismiss'));
export const restore = (key) => request('POST', sessionPath(key, 'restore'));
export const getTimeline = (hours = 12) => request('GET', `/api/timeline?hours=${hours}`);
export const getDiary = () => request('GET', '/api/diary');
export const addDiary = (note) => request('POST', '/api/diary', { note });
