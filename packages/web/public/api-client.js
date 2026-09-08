export function normalizeApiBase(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  const withScheme = /^https?:\/\//i.test(text) ? text : `http://${text}`;
  try {
    const url = new URL(withScheme);
    if (url.username || url.password) return null;
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function apiUrl(baseUrl, path) {
  if (!baseUrl) return path;
  return new URL(path, baseUrl).toString();
}

export function authorizedRequestOptions(path, token, options) {
  if (!String(path).startsWith("/api/") || !token) return options;
  const headers = new Headers(options?.headers);
  headers.set("authorization", `Bearer ${token}`);
  return { ...options, headers };
}

export function readBootstrapApiToken(documentRoot = document) {
  const token = documentRoot.querySelector('meta[name="idel-api-auth"]')?.content ??
    documentRoot.querySelector('meta[name="idel-native-terminal-auth"]')?.content ?? "";
  return token === "__IDEL_API_AUTH_TOKEN__" || token === "__IDEL_NATIVE_TERMINAL_AUTH_TOKEN__"
    ? ""
    : token;
}
