// URLs for the API, which may be on another origin (a Cloudflare Worker) than the page (GitHub
// Pages). The base comes from runtime-config.js.
const base = String(globalThis.BT3D_API ?? '').replace(/\/+$/, '');

export const apiUrl = path => `${base}${path}`;

export async function getApiJson(path) {
  const res = await fetch(apiUrl(path));
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}
