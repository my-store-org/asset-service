import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { CallerMiddleware } from "../clients/caller";
import { Client } from "../clients/client.entity";
import { AdminGuard, ClientsController } from "../clients/clients.controller";
import { ClientsService } from "../clients/clients.service";
import { DriveController } from "../drive/drive.controller";
import { DriveFile, DriveFolder } from "../drive/drive.entity";
import { DriveService } from "../drive/drive.service";
import { AssetRef } from "./asset-ref.entity";
import { Asset } from "./asset.entity";
import { AssetsController, RefsController } from "./assets.controller";
import { AssetsService } from "./assets.service";

@Module({
  imports: [TypeOrmModule.forFeature([Asset, AssetRef, Client, DriveFolder, DriveFile])],
  controllers: [AssetsController, RefsController, ClientsController, DriveController],
  providers: [AssetsService, ClientsService, AdminGuard, DriveService],
})
export class AssetsModule implements NestModule {
  // Who is calling, for the file routes (not /clients, which takes the admin key).
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(CallerMiddleware).forRoutes(AssetsController, RefsController, DriveController);
  }
}
