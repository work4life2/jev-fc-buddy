// Copies the browser emulator bundle into web/vendor (git-ignored) so the play page needs no bundler.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "node_modules", "jsnes", "dist", "jsnes.min.js");
const dst = path.join(root, "web", "vendor", "jsnes.min.js");
fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.copyFileSync(src, dst);
console.log(`copied ${path.relative(root, src)} → ${path.relative(root, dst)}`);
