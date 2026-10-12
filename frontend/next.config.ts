import type { NextConfig } from "next";

// Where this server reaches the API. Never a browser-facing address.
const API_INTERNAL = (process.env.API_INTERNAL_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");

const nextConfig: NextConfig = {
  // The repo's own CLAUDE.md / SCHEMA.md / PROJECT_STRUCTURE.md are the
  // source of truth; don't let Next regenerate template agent docs here.
  agentRules: false,
  // A self-contained server for the Docker image; `next dev` ignores it.
  output: "standalone",
  // Opened through a tunnel (scripts/dev.ps1 tunnel), the dev server must
  // accept requests for the tunnel's host or it refuses its own assets.
  allowedDevOrigins: ["*.ngrok-free.dev", "*.ngrok-free.app", "*.ngrok.app", "*.ngrok.io"],
  // One public address for everything: `/backend/*` is the API. GitHub's
  // webhooks and the GitHub Actions callbacks arrive this way, and so does
  // the console itself when opened through the tunnel (see lib/api.ts).
  async rewrites() {
    return [{ source: "/backend/:path*", destination: `${API_INTERNAL}/:path*` }];
  },
};

export default nextConfig;
