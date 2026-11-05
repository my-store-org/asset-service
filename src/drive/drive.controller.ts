import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UnauthorizedException,
} from "@nestjs/common";
import { ApiOperation, ApiSecurity, ApiTags } from "@nestjs/swagger";
import { Caller } from "../clients/caller";
import type { Client } from "../clients/client.entity";
import { AddFilesDto, CopyToDto, CreateFolderDto, ImportDto, ListDriveQuery, UpdateFileDto, UpdateFolderDto } from "./drive.dto";
import { DriveService } from "./drive.service";

/** The drive is per organization: it always needs a client key. */
function needKey(caller: Client | null): Client {
  if (!caller) throw new UnauthorizedException("Send x-client-key and x-client-secret");
  return caller;
}

/**
 * An organization's folders and files. Upload a file with POST /assets, then add it with
 * POST /drive/files. Only the organization's own key sees its drive.
 */
@ApiTags("drive")
@ApiSecurity("client-key")
@ApiSecurity("client-secret")
@Controller("drive")
export class DriveController {
  constructor(private readonly drive: DriveService) {}

  @Get()
  @ApiOperation({
    summary: "Open a folder, or search",
    description: "A folder's sub-folders and files (the top when folderId is left out). With search: matching folders and files anywhere, each with its path.",
  })
  list(@Query() { folderId, search }: ListDriveQuery, @Caller() caller: Client | null) {
    const c = needKey(caller);
    return search?.trim() ? this.drive.search(c, search) : this.drive.list(c, folderId);
  }

  @Post("folders")
  @ApiOperation({ summary: "Make a folder" })
  createFolder(@Body() dto: CreateFolderDto, @Caller() caller: Client | null) {
    return this.drive.createFolder(needKey(caller), dto);
  }

  @Patch("folders/:id")
  @ApiOperation({ summary: "Rename or move a folder" })
  updateFolder(@Param("id", ParseIntPipe) id: number, @Body() dto: UpdateFolderDto, @Caller() caller: Client | null) {
    return this.drive.updateFolder(needKey(caller), id, dto);
  }

  @Delete("folders/:id")
  @ApiOperation({ summary: "Delete a folder with everything inside it" })
  removeFolder(@Param("id", ParseIntPipe) id: number, @Caller() caller: Client | null) {
    return this.drive.removeFolder(needKey(caller), id);
  }

  @Post("folders/:id/copy")
  @ApiOperation({ summary: "Copy a folder with everything inside it", description: "The copies use the same stored files." })
  copyFolder(@Param("id", ParseIntPipe) id: number, @Body() { folderId }: CopyToDto, @Caller() caller: Client | null) {
    return this.drive.copyFolder(needKey(caller), id, folderId ?? null);
  }

  @Post("files")
  @ApiOperation({ summary: "Add stored files to a folder" })
  addFiles(@Body() dto: AddFilesDto, @Caller() caller: Client | null) {
    return this.drive.addFiles(needKey(caller), dto);
  }

  @Patch("files/:id")
  @ApiOperation({ summary: "Rename or move a file" })
  updateFile(@Param("id", ParseIntPipe) id: number, @Body() dto: UpdateFileDto, @Caller() caller: Client | null) {
    return this.drive.updateFile(needKey(caller), id, dto);
  }

  @Post("files/:id/copy")
  @ApiOperation({ summary: "Copy a file", description: "The copy uses the same stored file." })
  copyFile(@Param("id", ParseIntPipe) id: number, @Body() { folderId }: CopyToDto, @Caller() caller: Client | null) {
    return this.drive.copyFile(needKey(caller), id, folderId ?? null);
  }

  @Delete("files/:id")
  @HttpCode(204)
  @ApiOperation({ summary: "Delete a file" })
  async removeFile(@Param("id", ParseIntPipe) id: number, @Caller() caller: Client | null) {
    await this.drive.removeFile(needKey(caller), id);
  }

  @Post("import")
  @ApiOperation({
    summary: "Move an app's existing folders and files in",
    description: "Once, with the same ids. Safe to repeat: what is already here is skipped.",
  })
  import(@Body() dto: ImportDto, @Caller() caller: Client | null) {
    return this.drive.import(needKey(caller), dto);
  }
}
