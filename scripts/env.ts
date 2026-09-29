// Loads .env / .env.local for standalone scripts the same way Next.js does.
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());
