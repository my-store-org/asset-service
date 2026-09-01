import { Logger } from "@nestjs/common";
import { createConnection } from "mysql2/promise";

const logger = new Logger("Database");

/**
 * Creates the service's database if it does not exist yet, so a fresh
 * deployment only needs credentials in the environment.
 *
 * The connection deliberately omits `database`: you cannot connect to a
 * schema that has not been created. Once it exists, migrations build the
 * tables inside it.
 *
 * A production user scoped to one schema will not hold CREATE — that is the
 * safer setup, so a denial is logged and start-up continues rather than
 * failing. If the schema really is missing, the connection that follows
 * reports it clearly enough.
 */
export async function ensureDatabase(): Promise<void> {
  const name = process.env.DB_NAME;
  if (!name) throw new Error("DB_NAME is not set");

  if (process.env.DB_AUTO_CREATE === "false") {
    logger.log(`DB_AUTO_CREATE=false — expecting "${name}" to exist already`);
    return;
  }

  // Identifiers cannot be parameterised, so allow only safe characters.
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(`DB_NAME "${name}" contains unsupported characters`);
  }

  const connection = await createConnection({
    host: process.env.DB_HOST ?? "127.0.0.1",
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });

  try {
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS \`${name}\` ` +
        "CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
    );
    logger.log(`Database "${name}" is ready`);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ER_DBACCESS_DENIED_ERROR" || code === "ER_SPECIFIC_ACCESS_DENIED_ERROR") {
      logger.warn(
        `No permission to create "${name}". That is expected for a ` +
          "least-privilege user; create the schema once by hand.",
      );
      return;
    }
    throw err;
  } finally {
    await connection.end();
  }
}
