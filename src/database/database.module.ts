import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Asset } from "../assets/asset.entity";

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
          entities: [Asset],
          synchronize,
          charset: "utf8mb4",
          timezone: "Z",
        };
      },
    }),
  ],
})
export class DatabaseModule {}
