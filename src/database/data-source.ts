import { config } from "dotenv";
import { DataSource } from "typeorm";
import { Asset } from "../assets/asset.entity";
import { AssetRef } from "../assets/asset-ref.entity";
import { ManagedBucket } from "../assets/managed-bucket.entity";
import { Client } from "../clients/client.entity";
import { DriveFile, DriveFolder } from "../drive/drive.entity";

// Used by the TypeORM CLI (npm run migration:generate / migration:run).
// Nest loads its own configuration at runtime; this only serves the CLI.
config({ path: [".env", "../../.env"] });

export default new DataSource({
  type: "mysql",
  host: process.env.DB_HOST ?? "127.0.0.1",
  port: Number(process.env.DB_PORT ?? 3306),
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  entities: [Asset, AssetRef, Client, DriveFolder, DriveFile, ManagedBucket],
  migrations: ["src/migrations/*.ts"],
  charset: "utf8mb4",
  timezone: "Z",
});
