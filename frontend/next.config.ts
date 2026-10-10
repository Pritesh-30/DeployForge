import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The repo's own CLAUDE.md / SCHEMA.md / PROJECT_STRUCTURE.md are the
  // source of truth; don't let Next regenerate template agent docs here.
  agentRules: false,
  // A self-contained server for the Docker image; `next dev` ignores it.
  output: "standalone",
};

export default nextConfig;
