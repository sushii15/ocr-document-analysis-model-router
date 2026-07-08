import path from "node:path";

export function runtimeDataDir(...parts: string[]) {
  const root = process.env.VERCEL ? "/tmp/docrouter" : path.join(process.cwd(), ".docrouter");
  return path.join(root, ...parts);
}
