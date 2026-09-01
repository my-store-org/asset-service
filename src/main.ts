import { Logger, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module";
import { ensureDatabase } from "./database/ensure-database";

const DEFAULT_PORTS = [3000, 3002, 3003];

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

async function bootstrap() {
  // Create the schema before Nest connects to it; migrations then build
  // the tables inside. A fresh deployment needs only DB_* in the env.
  await ensureDatabase();

  const app = await NestFactory.create(AppModule);
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
