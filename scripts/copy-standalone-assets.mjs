import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const standaloneDir = join(root, ".next", "standalone");

if (!existsSync(standaloneDir)) {
  process.exit(0);
}

const copyIfExists = (source, destination) => {
  if (!existsSync(source)) return;

  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true });
};

copyIfExists(join(root, "public"), join(standaloneDir, "public"));
copyIfExists(join(root, "app", "documents"), join(standaloneDir, "app", "documents"));
copyIfExists(join(root, ".next", "static"), join(standaloneDir, ".next", "static"));
