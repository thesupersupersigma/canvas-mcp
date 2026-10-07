// Docs drift: every setting the CLI reads is documented, and example Canvas addresses are placeholders. Run after `npm run build`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const help = execFileSync("node", ["dist/index.js", "--help"], { encoding: "utf8" });
const readme = read("README.md"), envExample = read(".env.example");
const sources = readdirSync(new URL("../src", import.meta.url)).map((f) => read(`src/${f}`));

// CANVAS_URL and CANVAS_TOKEN are old aliases of CANVAS_BASE_URL and CANVAS_API_TOKEN, left undocumented on purpose.
const settings = [...new Set([...read("src/index.ts").matchAll(/\benv\.([A-Z][A-Z_]+)/g)].map((m) => m[1]))]
  .filter((name) => name !== "CANVAS_URL" && name !== "CANVAS_TOKEN");
assert.ok(settings.includes("PUBLIC_URL") && settings.includes("MCP_SECRET"), `found the settings index.ts reads: ${settings}`);
for (const [doc, text] of [["--help", help], ["README.md", readme]])
  for (const name of settings) assert.ok(new RegExp(`\\b${name}\\b`).test(text), `${doc} documents ${name}`);
for (const name of envExample.match(/^#?\s*([A-Z][A-Z_]+)=/gm).map((l) => l.replace(/^#?\s*|=$/g, "")))
  assert.ok(settings.includes(name), `.env.example names ${name}, which the CLI doesn't read`);
for (const name of ["PUBLIC_URL", "CANVAS_MCP_KEY"]) assert.ok(envExample.includes(`${name}=`), `.env.example has ${name}`);

// The image's health check asks the port the server listens on (CANVAS_MCP_PORT, read when the check runs), not a fixed one.
const healthcheck = read("Dockerfile").match(/^HEALTHCHECK .*$/m)?.[0] ?? "";
assert.match(healthcheck, /http:\/\/127\.0\.0\.1:\$\{CANVAS_MCP_PORT:-7341\}\/health/, `Dockerfile: ${healthcheck}`);
assert.doesNotMatch(healthcheck, /\[/, "shell form (exec form would not expand the variable)");

// No real school: every example Canvas host is the placeholder.
for (const [doc, text] of [["--help", help], ["README.md", readme], [".env.example", envExample], ["src", sources.join("\n")]])
  for (const [host] of text.matchAll(/[\w.-]+\.instructure\.com/g))
    assert.equal(host, "yourschool.instructure.com", `${doc}: ${host} is not the placeholder`);

console.log(`[docs] ${settings.length} settings documented in --help and README; example hosts are placeholders`);
