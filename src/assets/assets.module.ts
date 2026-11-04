import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { CallerMiddleware } from "../clients/caller";
import { Client } from "../clients/client.entity";
import { AdminGuard, ClientsController } from "../clients/clients.controller";
import { ClientsService } from "../clients/clients.service";
import { AssetRef } from "./asset-ref.entity";
import { Asset } from "./asset.entity";
import { AssetsController, RefsController } from "./assets.controller";
import { AssetsService } from "./assets.service";

@Module({
  imports: [TypeOrmModule.forFeature([Asset, AssetRef, Client])],
  controllers: [AssetsController, RefsController, ClientsController],
  providers: [AssetsService, ClientsService, AdminGuard],
})
export class AssetsModule implements NestModule {
  // Who is calling, for the file routes (not /clients, which takes the admin key).
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(CallerMiddleware).forRoutes(AssetsController, RefsController);
  }
}
