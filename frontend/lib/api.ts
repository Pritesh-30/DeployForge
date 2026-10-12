/**
 * Thin fetch wrapper around the DeployForge backend.
 *
 * Every request goes through here so that the base URL lives in one place and
 * the JWT (added in Task 2) is attached consistently.
 */

const CONFIGURED_API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

/**
 * Where the API is, from this browser's point of view.
 *
 * On the machine running DeployForge that is the configured address. Opened
 * through a public tunnel (an ngrok domain, for a demo), `localhost:8000`
 * would mean the *viewer's* machine — so the console goes through its own
 * origin instead, and Next.js forwards `/backend/*` to the API (see
 * next.config.ts). One tunnel then serves the console, the API, GitHub's
 * webhooks and the callbacks from GitHub Actions.
 */
export function apiBase(): string {
  if (typeof window !== "undefined") {
    const host = window.location.hostname;
    const local = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
    if (!local && /\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(CONFIGURED_API_URL)) return "/backend";
  }
  return CONFIGURED_API_URL;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * The stored JWT (read directly to avoid a circular import with lib/auth),
 * and — through a free ngrok tunnel — the header that stops ngrok answering
 * an API call with its "you are about to visit" page.
 */
function authHeader(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const token = window.localStorage.getItem("deployforge_token");
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  if (apiBase() === "/backend") headers["ngrok-skip-browser-warning"] = "1";
  return headers;
}

export async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...authHeader(),
      ...(options.headers ?? {}),
    },
  });

  // 204 No Content has no body to parse.
  const body = res.status === 204 ? null : await res.json().catch(() => null);

  if (!res.ok) {
    const message =
      (body as { error?: { message?: string } } | null)?.error?.message ??
      formatDetail((body as { detail?: unknown } | null)?.detail) ??
      `Request failed with status ${res.status}`;
    throw new ApiError(message, res.status);
  }

  return body as T;
}

/** FastAPI validation errors arrive as a list of objects, not a string. */
function formatDetail(detail: unknown): string | null {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const messages = detail
      .map((d) => (d as { msg?: string })?.msg)
      .filter(Boolean);
    if (messages.length > 0) return messages.join("; ");
  }
  return null;
}

/* -------------------------------------------------------------------------
 * Server-Sent Events
 * ---------------------------------------------------------------------- */

export type StreamEvent = { event: string; data: Record<string, unknown> };

/**
 * Read an SSE endpoint with `fetch`, not `EventSource`.
 *
 * `EventSource` cannot send an Authorization header, and putting the token
 * in the URL would write it into every proxy and access log on the way.
 * Returns a function that closes the stream.
 */
export function apiStream(
  path: string,
  onEvent: (e: StreamEvent) => void,
  onError?: (err: Error) => void,
  /** The server ended the stream (not an abort from this side). */
  onEnd?: () => void,
): () => void {
  const controller = new AbortController();

  (async () => {
    try {
      const res = await fetch(`${apiBase()}${path}`, {
        headers: { Accept: "text/event-stream", ...authHeader() },
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => null);
        throw new ApiError(
          (body as { error?: { message?: string } } | null)?.error?.message ??
            `Stream failed with status ${res.status}`,
          res.status,
        );
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Events are separated by a blank line.
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
          if (raw.startsWith(":")) continue; // heartbeat comment
          let name = "message";
          const data: string[] = [];
          for (const line of raw.split("\n")) {
            if (line.startsWith("event: ")) name = line.slice(7);
            else if (line.startsWith("data: ")) data.push(line.slice(6));
          }
          if (data.length === 0) continue;
          try {
            onEvent({ event: name, data: JSON.parse(data.join("\n")) });
          } catch {
            /* a malformed event is skipped, not fatal */
          }
        }
      }
      if (!controller.signal.aborted) onEnd?.();
    } catch (err) {
      if (controller.signal.aborted) return;
      onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  return () => controller.abort();
}

export type HealthResponse = {
  status: string;
  service: string;
  version: string;
  environment: string;
  database: string;
  detail: string | null;
};

export function getHealth(): Promise<HealthResponse> {
  return apiFetch<HealthResponse>("/health");
}
