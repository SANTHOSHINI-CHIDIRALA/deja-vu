import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Data JSON under /data is read at runtime by API routes; make sure it ships with the functions.
  outputFileTracingIncludes: { "/api/**": ["./data/**/*.json"] },
};

export default nextConfig;
