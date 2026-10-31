/**
 * Build a WebSocket URL that works across local HTTP dev, remote HTTP VMs,
 * and HTTPS reverse-proxy deployments (preventing Mixed Content ws:// errors).
 */
export function buildWsUrl(path) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;

  if (process.env.REACT_APP_WS_BASE_URL) {
    const base = process.env.REACT_APP_WS_BASE_URL.replace(/\/+$/, "");
    return `${base}${normalizedPath}`;
  }

  const isHttps =
    typeof window !== "undefined" && window.location.protocol === "https:";
  const protocol = isHttps ? "wss" : "ws";
  const host =
    (typeof window !== "undefined" && window.location.hostname) || "localhost";

  // Under HTTPS, assume reverse-proxy on the same origin unless REACT_APP_BACKEND_PORT is explicitly set
  if (isHttps && !process.env.REACT_APP_BACKEND_PORT) {
    const hostWithPort = window.location.host || host;
    return `${protocol}://${hostWithPort}${normalizedPath}`;
  }

  const port = process.env.REACT_APP_BACKEND_PORT || "8000";
  return `${protocol}://${host}:${port}${normalizedPath}`;
}

