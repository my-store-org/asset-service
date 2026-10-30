#!/usr/bin/env node
/**
 * Answers one question: why did the service exit before it bound a port?
 *
 * Everything checked here runs before `listen()` in main.ts, so any failure
 * shows the platform a process that quit rather than a service that is
 * merely unhealthy — which a proxy reports as a bare 503. Run it on the
 * host, in the app's directory:  node scripts/preflight.js
 */

const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
let failed = 0;

/**
 * ConfigModule reads .env at boot, so the check has to as well — otherwise a
 * local run reports variables missing that the service would find. Real
 * environment variables win, as they do in the app.
 */
function loadEnvFile() {
  const path = join(root, ".env");
  if (!existsSync(path)) return false;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[2].trim().replace(/^["']|["']$/g, "");
    if (!(match[1] in process.env)) process.env[match[1]] = value;
  }
  return true;
}

function ok(label, detail) {
  console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
}

function fail(label, detail) {
  failed++;
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const hasEnvFile = loadEnvFile();
  console.log("\nAsset service preflight\n");
  console.log(
    hasEnvFile
      ? "  (read .env from the app directory)\n"
      : "  (no .env file — reading the process environment, as on a managed host)\n",
  );

  // 1. Runtime. Nest 11 requires Node 20 or newer.
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 20) ok("node version", `v${process.versions.node}`);
  else fail("node version", `v${process.versions.node} — Nest 11 needs v20+`);

  // 2. The entry file. `npm start` runs dist/main.js; the build produces it
  //    and dist/ is gitignored, so a deploy without a build step has none.
  if (existsSync(join(root, "dist/main.js"))) ok("dist/main.js", "built");
  else fail("dist/main.js", "missing — run `npm install && npm run build`");

  // 3. Runtime dependencies.
  for (const dep of ["@nestjs/core", "mysql2", "@aws-sdk/client-s3"]) {
    try {
      require.resolve(`${dep}/package.json`, { paths: [root] });
      ok(`dependency ${dep}`);
    } catch {
      fail(`dependency ${dep}`, "not installed");
    }
  }

  // 4. Variables read before the port is bound. Each missing one throws
  //    during boot: DB_NAME in ensureDatabase, AWS_REGION in AssetsService.
  for (const key of ["DB_NAME", "DB_USER", "DB_HOST", "AWS_REGION"]) {
    if (process.env[key]) ok(`env ${key}`, key.startsWith("DB_") ? process.env[key] : "set");
    else fail(`env ${key}`, "not set in this environment");
  }
  // The default bucket: S3_BUCKET, else my-store-dev-bucket. Others a caller may name: S3_BUCKETS.
  ok("env S3_BUCKET", process.env.S3_BUCKET || "my-store-dev-bucket (default)");
  if (process.env.S3_BUCKETS) ok("env S3_BUCKETS", process.env.S3_BUCKETS);

  if (process.env.PORT) {
    console.log(`  NOTE  env PORT is set to ${process.env.PORT} — on managed hosting, leave it unset so the platform assigns it`);
  }

  // 5. The database, reached the same way the service reaches it.
  if (process.env.DB_NAME) {
    try {
      const { createConnection } = require("mysql2/promise");
      const conn = await createConnection({
        host: process.env.DB_HOST ?? "127.0.0.1",
        port: Number(process.env.DB_PORT ?? 3306),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        connectTimeout: 8000,
      });
      await conn.query("SELECT 1");
      await conn.end();
      ok("database connection", `${process.env.DB_NAME} reachable`);
    } catch (err) {
      fail("database connection", `${err.code ?? ""} ${err.message}`.trim());
    }
  }

  console.log(
    failed
      ? `\n${failed} check(s) failed — each one exits the process before it listens, which the proxy shows as 503.\n`
      : "\nAll checks passed. If it still 503s, run `node dist/main.js` by hand and read the error.\n",
  );
  process.exit(failed ? 1 : 0);
}

void main();
