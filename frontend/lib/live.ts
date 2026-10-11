/**
 * Live updates from the server (backend/app/runtime/live.py).
 *
 * The console holds one stream to `GET /live` for the whole session. Each
 * notice says which app and deployment changed; pages that show them re-read
 * from the API — so a push that starts a build in GitHub Actions appears in
 * the console within a second, without a refresh, the way Vercel's does.
 *
 * Notices are re-broadcast as a window event, so any component can listen
 * with `useLive` without threading a context through the tree. Polling stays
 * in place underneath as the fallback for a dropped stream.
 */

"use client";

import { useEffect, useRef } from "react";

import { apiStream } from "@/lib/api";

export type LiveChange = {
  app_id: string;
  deployment_id: string;
  status: string | null;
  stage: string | null;
  level: string | null;
  at: number;
};

const EVENT = "df-live";

/** Open the session's stream. Reconnects with backoff. Returns a closer. */
export function connectLive(): () => void {
  let close: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  let stopped = false;

  const open = () => {
    if (stopped) return;
    close = apiStream(
      "/live",
      (e) => {
        if (e.event === "ready") {
          // Back after a failure: whatever changed meanwhile, re-read once.
          // (A routine rotation of the stream misses nothing.)
          if (attempts > 0) window.dispatchEvent(new CustomEvent(EVENT, { detail: null }));
          attempts = 0;
        } else if (e.event === "change") {
          window.dispatchEvent(new CustomEvent(EVENT, { detail: e.data as LiveChange }));
        }
      },
      () => retry(),
      // The server ended the stream on schedule: reconnect straight away.
      () => {
        if (stopped) return;
        close?.();
        open();
      },
    );
  };
  const retry = () => {
    if (stopped) return;
    close?.();
    attempts += 1;
    timer = setTimeout(open, Math.min(15000, 1000 * 2 ** Math.min(attempts, 4)));
  };

  open();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    close?.();
  };
}

/**
 * Call `onChange` when the server reports a change `matches` cares about
 * (all changes when omitted). `null` means "the stream reconnected; re-read".
 * Bursts are coalesced, so a build's dozen steps cause a handful of reloads.
 */
export function useLive(onChange: () => void, matches?: (change: LiveChange) => boolean) {
  const handler = useRef(onChange);
  const filter = useRef(matches);
  useEffect(() => {
    handler.current = onChange;
    filter.current = matches;
  });

  useEffect(() => {
    let pending: ReturnType<typeof setTimeout> | undefined;
    function listen(e: Event) {
      const change = (e as CustomEvent<LiveChange | null>).detail;
      if (change && filter.current && !filter.current(change)) return;
      if (pending) return;
      pending = setTimeout(() => {
        pending = undefined;
        handler.current();
      }, 250);
    }
    window.addEventListener(EVENT, listen);
    return () => {
      window.removeEventListener(EVENT, listen);
      if (pending) clearTimeout(pending);
    };
  }, []);
}
