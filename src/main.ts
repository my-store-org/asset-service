import { Logger, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { getDataSourceToken } from "@nestjs/typeorm";
import type { DataSource } from "typeorm";
import { AppModule } from "./app.module";
import { ensureDatabase } from "./database/ensure-database";

// 3004: the staff management app, which uploads profile pictures.
const DEFAULT_PORTS = [3000, 3002, 3003, 3004];

/**
 * localhost and 127.0.0.1 are distinct origins to a browser, so both are
 * allowed — otherwise opening the docs at one and calling the other is
 * blocked by CORS. Port 3003 is included so Swagger UI can call the service
 * it is served from.
 */
function allowedOrigins(): string[] {
  const configured = (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  if (configured.length) return configured;

  return DEFAULT_PORTS.flatMap((port) => [
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
  ]);
}

/**
 * Gives images stored before ownership existed to the scope named in the
 * environment, if one is.
 *
 * The scope migration deliberately leaves those rows unowned: the service
 * cannot know who uploaded them, and guessing would hand one merchant's
 * pictures to another. That is right for a shared bucket and wrong for one
 * that has only ever served a single shop, where it means the media library
 * goes empty.
 *
 * So the decision is a deployment's to make, and making it is setting
 * ASSET_BACKFILL_SCOPE — after which a rebuild applies it. Only rows with no
 * owner are ever touched, so it is safe to leave set: once they are claimed,
 * every later boot finds nothing to do.
 */
async function claimUnownedAssets(ds: DataSource) {
  const scope = (process.env.ASSET_BACKFILL_SCOPE ?? "").trim();
  if (!scope) return;

  const logger = new Logger("AssetBackfill");
  if (scope.length > 190) {
    logger.error("ASSET_BACKFILL_SCOPE is longer than 190 characters — ignored");
    return;
  }

  try {
    const result = await ds.query(
      "UPDATE assets SET scope = ? WHERE scope = ''",
      [scope],
    );
    const claimed = (result as { affectedRows?: number }).affectedRows ?? 0;
    if (claimed) logger.log(`Assigned ${claimed} unowned asset(s) to "${scope}"`);
  } catch (err) {
    // Not worth refusing to start over: the service works, the library is
    // just missing older pictures until this is looked at.
    logger.error(`Backfill failed: ${(err as Error).message}`);
  }
}

async function bootstrap() {
  // Create the schema before Nest connects to it; migrations then build
  // the tables inside. A fresh deployment needs only DB_* in the env.
  await ensureDatabase();

  const app = await NestFactory.create(AppModule);

  // After the migrations the module ran, so the column exists to write to.
  await claimUnownedAssets(app.get(getDataSourceToken()));

  app.enableCors({ origin: allowedOrigins() });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  const port = Number(process.env.PORT ?? 3003);

  // Swagger is a development aid; keep it off in production unless asked for.
  if (process.env.NODE_ENV !== "production" || process.env.SWAGGER === "true") {
    const config = new DocumentBuilder()
      .setTitle("My Store — Asset Service")
      .setDescription(
        "Owns object storage for My Store. Upload a file, get back an id and " +
          "a public url; other services store those two values and never " +
          "touch the bucket themselves.",
      )
      .setVersion("1.0")
      .addTag("assets", "Upload, read and delete stored files")
      .addServer(`http://localhost:${port}`, "Local")
      .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup("docs", app, document, {
      jsonDocumentUrl: "docs/json",
      customSiteTitle: "Asset Service API",
      swaggerOptions: { persistAuthorization: true },
    });
  }

  // 0.0.0.0 rather than the default: a managed host routes to the container
  // from outside, so binding only the loopback interface answers nothing and
  // the proxy in front reports 503.
  await app.listen(port, "0.0.0.0");
  new Logger("Bootstrap").log(`Asset service listening on 0.0.0.0:${port}`);
}

// A failure here happens before the port is bound, so the platform sees a
// process that exited rather than a service that is merely unhealthy. Say
// which stage failed, in one line, where the host's log will show it.
bootstrap().catch((err: unknown) => {
  new Logger("Bootstrap").error(
    `Asset service failed to start: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
