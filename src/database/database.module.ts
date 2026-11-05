import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Asset } from "../assets/asset.entity";
import { AssetRef } from "../assets/asset-ref.entity";
import { ManagedBucket } from "../assets/managed-bucket.entity";
import { Client } from "../clients/client.entity";
import { DriveFile, DriveFolder } from "../drive/drive.entity";
import { CreateAssetsTable1756704000000 } from "../migrations/1756704000000-CreateAssetsTable";
import { AddAssetScope1757300000000 } from "../migrations/1757300000000-AddAssetScope";
import { AddAssetBucket1761800000000 } from "../migrations/1761800000000-AddAssetBucket";
import { AddClients1762000000000 } from "../migrations/1762000000000-AddClients";
import { AddClientBuckets1762000000100 } from "../migrations/1762000000100-AddClientBuckets";
import { AddClientSameFileCheck1762000000200 } from "../migrations/1762000000200-AddClientSameFileCheck";
import { AddDrive1762000000300 } from "../migrations/1762000000300-AddDrive";
import { AddManagedBuckets1762000000400 } from "../migrations/1762000000400-AddManagedBuckets";
import { AddClientSecretEnc1762000000500 } from "../migrations/1762000000500-AddClientSecretEnc";

/**
 * Migrations are listed explicitly rather than by glob: the compiled build
 * ships .js while development runs .ts, and a glob that matches one does not
 * match the other. Importing them keeps both honest and fails at compile
 * time if a file is renamed.
 */
const MIGRATIONS = [
  CreateAssetsTable1756704000000,
  AddAssetScope1757300000000,
  AddAssetBucket1761800000000,
  AddClients1762000000000,
  AddClientBuckets1762000000100,
  AddClientSameFileCheck1762000000200,
  AddDrive1762000000300,
  AddManagedBuckets1762000000400,
  AddClientSecretEnc1762000000500,
];

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const synchronize = config.get("DB_SYNCHRONIZE") === "true";
        if (synchronize && config.get("NODE_ENV") === "production") {
          throw new Error("DB_SYNCHRONIZE must not be enabled in production");
        }

        return {
          type: "mysql" as const,
          host: config.get<string>("DB_HOST", "127.0.0.1"),
          port: Number(config.get("DB_PORT", 3306)),
          username: config.get<string>("DB_USER"),
          password: config.get<string>("DB_PASSWORD"),
          database: config.get<string>("DB_NAME"),
          entities: [Asset, AssetRef, Client, DriveFolder, DriveFile, ManagedBucket],
          migrations: MIGRATIONS,
          // Schema is built by migrations on start-up, so a new deployment
          // needs nothing but credentials. Opt out with MIGRATIONS_RUN=false
          // to run them as a separate deploy step instead.
          migrationsRun: config.get("MIGRATIONS_RUN") !== "false",
          migrationsTableName: "migrations",
          synchronize,
          charset: "utf8mb4",
          timezone: "Z",
        };
      },
    }),
  ],
})
export class DatabaseModule {}
