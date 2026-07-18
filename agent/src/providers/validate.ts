/** Live provider probing: validate an API key and list the account's models. */
import { loadConfig } from "../config.js";

export interface ProbeResult {
  ok: boolean;
  models?: string[];
  error?: string;
}

export async function probeProvider(providerId: string, overrideKey?: string): Promise<ProbeResult> {
  const cfg = loadConfig();
  const p = cfg.providers[providerId];
  if (!p) return { ok: false, error: `unknown provider "${providerId}"` };
  const key = overrideKey ?? p.apiKey;
  if (!key) return { ok: false, error: "no API key saved" };

  let url: string;
  let headers: Record<string, string>;
  if (p.kind === "anthropic") {
    url = `${p.baseUrl}/v1/models?limit=100`;
    headers = { "x-api-key": key, "anthropic-version": "2023-06-01" };
  } else if (p.kind === "azure") {
    url = `${p.baseUrl}/models`;
    headers = { "api-key": key };
  } else {
    url = `${p.baseUrl}/models`;
    headers = { authorization: `Bearer ${key}` };
  }

  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(12_000) });
    if (!res.ok) {
      const hint =
        res.status === 401 || res.status === 403
          ? "the provider rejected this key"
          : res.status === 429
            ? "rate limited — key is probably valid"
            : `HTTP ${res.status}`;
      return { ok: res.status === 429, error: `${hint} (${res.status})` };
    }
    const j: any = await res.json();
    const models = (j.data ?? j.models ?? [])
      .map((m: any) => m.id ?? m.name)
      .filter((id: unknown): id is string => typeof id === "string")
      .map((id: string) => id.replace(/^models\//, ""))
      .slice(0, 200);
    return { ok: true, models };
  } catch (err: any) {
    // Network-level failures (DNS, connection refused, TLS, malformed URL)
    // otherwise surface raw Node/undici error text (e.g. "fetch failed:
    // getaddrinfo ENOTFOUND ...") straight into the settings UI — normalize
    // to one friendly message instead, matching the HTTP-status branch above.
    const friendly = err?.name === "TimeoutError" ? "timed out reaching provider" : "could not reach provider — check the base URL and your network connection";
    return { ok: false, error: friendly };
  }
}
