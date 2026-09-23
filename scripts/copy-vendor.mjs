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

// These compiled modules have no Node, SDK, credential or environment dependency.
const aiDir = path.join(root, "web/vendor/ai");
fs.mkdirSync(aiDir, { recursive: true });
for (const name of ["observe", "policy", "route", "tactics", "control", "rollout"]) {
  const source = path.join(root, "dist/ai", `${name}.js`);
  const code = fs.readFileSync(source, "utf8");
  if (/from ["'](?:node:|\.\.\/|@)|process\./.test(code)) throw new Error(`Node dependency leaked into browser controller: ${name}`);
  fs.writeFileSync(path.join(aiDir, `${name}.js`), code.replace(/\/\/# sourceMappingURL=.*$/m, ""));
}
