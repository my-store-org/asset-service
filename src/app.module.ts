import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AssetsModule } from "./assets/assets.module";
import { DatabaseModule } from "./database/database.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // .env.production first so a production file wins where both exist;
      // it is absent in development, which falls through to .env. Real
      // environment variables set by the host beat both.
      envFilePath: [".env.production", ".env"],
    }),
    DatabaseModule,
    AssetsModule,
  ],
})
export class AppModule {}
