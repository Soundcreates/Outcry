const configuredApiBaseUrl = import.meta.env.VITE_API_BASE_URL ||
  import.meta.env.VITE_WORLD_HTTP ||
  (import.meta.env.VITE_WORLD_WS || "ws://localhost:2567").replace(/^ws/, "http");

export const API_BASE_URL = configuredApiBaseUrl.replace(/\/+$/, "");
export const WORLD_WS_URL = import.meta.env.VITE_WORLD_WS || API_BASE_URL.replace(/^http/, "ws");
