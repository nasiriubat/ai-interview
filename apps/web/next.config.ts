import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false, // repository-level AGENTS.md is the single source of working rules
  output: "standalone",
  outputFileTracingRoot: path.join(import.meta.dirname, "../../"),
  reactStrictMode: true,
  poweredByHeader: false,
};

export default nextConfig;
