import { ValidationPipe } from "@nestjs/common";
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

  const port = process.env.PORT ?? 3003;

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

  await app.listen(port);
}
void bootstrap();
