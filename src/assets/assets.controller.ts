import {
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Redirect,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConsumes,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import {
  AssetResponseDto,
  DeletedAssetDto,
  UploadAssetDto,
} from "./asset.dto";
import { AssetsService, MAX_UPLOAD_BYTES } from "./assets.service";

@ApiTags("assets")
@Controller("assets")
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  @Post()
  @ApiOperation({
    summary: "Upload a file",
    description:
      "Stores the file and returns its id and public url. Callers persist " +
      "those two values; the bucket layout stays private to this service.",
  })
  @ApiConsumes("multipart/form-data")
  @ApiBody({ type: UploadAssetDto })
  @ApiQuery({
    name: "folder",
    required: false,
    enum: ["products", "categories", "marketing", "ugc", "feed"],
    description: "Grouping folder. Unknown values fall back to 'uploads'.",
  })
  @ApiQuery({
    name: "scope",
    required: false,
    example: "theme:acme:12",
    description:
      "Who the image belongs to. Listing filters on it, so a shop sees only " +
      "its own uploads and a design only the ones made for it.",
  })
  @ApiOkResponse({ type: AssetResponseDto })
  @ApiBadRequestResponse({
    description: "Missing file, unsupported type, or over the 15 MB limit.",
  })
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: MAX_UPLOAD_BYTES } }),
  )
  upload(
    @UploadedFile() file: Express.Multer.File,
    @Query("folder") folder?: string,
    @Query("scope") scope?: string,
  ) {
    return this.assets.upload(file, folder, scope);
  }

  @Get()
  @ApiOperation({
    summary: "List assets",
    description: "Newest first. Used by the admin's media library.",
  })
  @ApiQuery({ name: "folder", required: false, example: "products" })
  @ApiQuery({ name: "limit", required: false, example: 50 })
  @ApiQuery({ name: "scope", required: false, example: "store:acme" })
  @ApiOkResponse({ type: AssetResponseDto, isArray: true })
  findAll(
    @Query("folder") folder?: string,
    @Query("limit") limit?: string,
    @Query("scope") scope?: string,
  ) {
    return this.assets.findAll(folder, limit ? Number(limit) : undefined, scope);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get asset metadata" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ type: AssetResponseDto })
  @ApiNotFoundResponse({ description: "No asset with that id." })
  findOne(@Param("id", ParseUUIDPipe) id: string) {
    return this.assets.findOne(id);
  }

  @Get(":id/raw")
  @ApiOperation({
    summary: "Redirect to the file",
    description:
      "302s to the CDN url, so an <img> can point at the service directly.",
  })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiNotFoundResponse({ description: "No asset with that id." })
  @Redirect()
  async raw(@Param("id", ParseUUIDPipe) id: string) {
    const asset = await this.assets.findOne(id);
    return { url: asset.url, statusCode: 302 };
  }

  @Delete(":id")
  @ApiOperation({
    summary: "Delete an asset",
    description:
      "Removes the stored object and its record. Callers should drop their " +
      "reference first; a missing object is not treated as an error.",
  })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ type: DeletedAssetDto })
  @ApiNotFoundResponse({ description: "No asset with that id." })
  remove(@Param("id", ParseUUIDPipe) id: string) {
    return this.assets.remove(id);
  }
}
