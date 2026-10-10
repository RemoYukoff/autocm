// Minimal fetch helpers with timeouts for provider calls.

export async function fetchJson<T>(url: string, init: RequestInit & { timeoutMs?: number }): Promise<T> {
  const signal = init.signal ?? AbortSignal.timeout(init.timeoutMs ?? 120_000);
  const res = await fetch(url, { ...init, signal });
  const text = await res.text();
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

export async function fetchBytes(url: string, timeoutMs = 120_000): Promise<{ bytes: Buffer; mime: string }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`download ${res.status} ${url.slice(0, 80)}`);
  return { bytes: Buffer.from(await res.arrayBuffer()), mime: res.headers.get("content-type") ?? "application/octet-stream" };
}
