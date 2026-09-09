// const AUTH_URL = import.meta.env.VITE_AUTH_URL ?? "http://localhost:4000";
// const SHORT_URL = import.meta.env.VITE_SHORT_URL ?? "http://localhost:5000";
const AUTH_URL = "";
const SHORT_URL = "";

const TOKEN_KEY = "shorten-url-token";

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (token) => localStorage.setItem(TOKEN_KEY, token);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

async function request(baseUrl, path, { method = "GET", body, auth } = {}) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";

  const token = auth ? getToken() : null;
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || data.error || "Request failed");
  return data;
}

export const api = {
  register: (email, password) =>
    request(AUTH_URL, "/auth/register", {
      method: "POST",
      body: { email, password },
    }),

  login: (email, password) =>
    request(AUTH_URL, "/auth/login", {
      method: "POST",
      body: { email, password },
    }),

  me: () => request(AUTH_URL, "/auth/me", { auth: true }),

  // Auth is optional here: anonymous users can shorten too.
  shorten: (url) =>
    request(SHORT_URL, "/api/shorten", {
      method: "POST",
      body: { url },
      auth: true,
    }),

  history: () => request(SHORT_URL, "/api/links", { auth: true }),
};
