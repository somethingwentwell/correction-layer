import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** Repository root (works from src/ under type-stripping and from dist/src/ after build). */
export function repoRoot(): string {
  let dir = import.meta.dirname;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "schemas"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("cannot locate the repository root (package.json + schemas/)");
}
