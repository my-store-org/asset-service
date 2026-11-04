import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Redirect,
  UnauthorizedException,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { diskStorage } from "multer";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConsumes,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiSecurity,
  ApiTags,
} from "@nestjs/swagger";
import { Caller } from "../clients/caller";
import type { Client } from "../clients/client.entity";
import {
  AssetResponseDto,
  CompleteUploadDto,
  CopyAssetDto,
  DeletedAssetDto,
  SetRefsDto,
  SignUploadDto,
  UploadAssetDto,
} from "./asset.dto";
import { AssetsService, MAX_UPLOAD_BYTES } from "./assets.service";

@ApiTags("assets")
@ApiSecurity("client-key")
@ApiSecurity("client-secret")
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
    enum: ["products", "categories", "marketing", "ugc", "feed", "videos", "voice"],
    description: "Grouping folder. Unknown values fall back to 'uploads' (images), 'videos' or 'voice'.",
  })
  @ApiQuery({
    name: "scope",
    required: false,
    example: "theme:acme:12",
    description:
      "Who the image belongs to. Listing filters on it, so a shop sees only " +
      "its own uploads and a design only the ones made for it.",
  })
  @ApiQuery({
    name: "bucket",
    required: false,
    example: "my-store-dev-bucket",
    description:
      "The caller's own bucket, for a project other than the default. Must be " +
      "S3_BUCKET or listed in S3_BUCKETS; left out, the default bucket.",
  })
  @ApiOkResponse({ type: AssetResponseDto })
  @ApiBadRequestResponse({
    description: "Missing file, unsupported type, over its size limit (image 15 MB, video 200 MB, audio 50 MB), or a bucket that is not allowed.",
  })
  @UseInterceptors(
    FileInterceptor("file", {
      // To a temporary file, not memory: a 200 MB video would otherwise sit in RAM. The service deletes it.
      storage: diskStorage({ destination: tmpdir(), filename: (_req, _file, done) => done(null, `asset-upload-${randomUUID()}`) }),
      limits: { fileSize: MAX_UPLOAD_BYTES },
    }),
  )
  upload(
    @UploadedFile() file: Express.Multer.File,
    @Query("folder") folder?: string,
    @Query("scope") scope?: string,
    @Query("bucket") bucket?: string,
    @Caller() caller?: Client | null,
  ) {
    return this.assets.upload(file, folder, scope, bucket, caller ?? null);
  }

  @Post("copies")
  @ApiOperation({
    summary: "Copy an existing CDN asset",
    description:
      "Creates a separate S3 object and asset record for another store or theme scope.",
  })
  @ApiBody({ type: CopyAssetDto })
  @ApiOkResponse({ type: AssetResponseDto })
  copy(@Body() dto: CopyAssetDto, @Caller() caller: Client | null) {
    return this.assets.copy(dto.sourceUrl, dto.folder, dto.scope, dto.bucket, caller);
  }

  @Post("uploads")
  @ApiOperation({
    summary: "Sign a direct upload",
    description:
      "A one-hour link to PUT a large file (an Android APK) straight to the " +
      "bucket, for files too big to pass through the API. Register it with " +
      "POST /assets/uploads/complete once the PUT has finished.",
  })
  @ApiBody({ type: SignUploadDto })
  signUpload(@Body() dto: SignUploadDto, @Caller() caller: Client | null) {
    return this.assets.signUpload(dto.contentType, dto.size, dto.fileName, dto.bucket, caller);
  }

  @Post("uploads/complete")
  @ApiOperation({
    summary: "Register a direct upload",
    description: "Reads the uploaded file back from the bucket and records it as an asset.",
  })
  @ApiBody({ type: CompleteUploadDto })
  @ApiOkResponse({ type: AssetResponseDto })
  completeUpload(@Body() dto: CompleteUploadDto, @Caller() caller: Client | null) {
    return this.assets.completeUpload(dto.objectKey, dto.scope, dto.bucket, caller);
  }

  @Get()
  @ApiOperation({
    summary: "List assets",
    description: "Newest first. Used by the admin's media library.",
  })
  @ApiQuery({ name: "folder", required: false, example: "products" })
  @ApiQuery({ name: "limit", required: false, example: 50 })
  @ApiQuery({ name: "scope", required: false, example: "store:acme" })
  @ApiQuery({ name: "bucket", required: false, example: "my-store-dev-bucket", description: "Only that bucket's assets." })
  @ApiOkResponse({ type: AssetResponseDto, isArray: true })
  findAll(
    @Query("folder") folder?: string,
    @Query("limit") limit?: string,
    @Query("scope") scope?: string,
    @Query("bucket") bucket?: string,
    @Caller() caller?: Client | null,
  ) {
    return this.assets.findAll(folder, limit ? Number(limit) : undefined, scope, bucket, caller ?? null);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get asset metadata" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ type: AssetResponseDto })
  @ApiNotFoundResponse({ description: "No asset with that id." })
  findOne(@Param("id", ParseUUIDPipe) id: string, @Caller() caller: Client | null) {
    return this.assets.findOne(id, caller);
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
  async raw(@Param("id", ParseUUIDPipe) id: string, @Caller() caller: Client | null) {
    const asset = await this.assets.findOne(id, caller);
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
  remove(@Param("id", ParseUUIDPipe) id: string, @Caller() caller: Client | null) {
    return this.assets.remove(id, caller);
  }
}

/** What an organization's records use, so a file is deleted only once nothing does. */
@ApiTags("refs")
@ApiSecurity("client-key")
@ApiSecurity("client-secret")
@Controller("refs")
export class RefsController {
  constructor(private readonly assets: AssetsService) {}

  @Put()
  @ApiOperation({
    summary: "Set what records use",
    description:
      "Each record (\"loan:13\") now uses exactly these files; an empty list for one that " +
      "is gone. Files no record uses any more are deleted. Needs a client key.",
  })
  @ApiBody({ type: SetRefsDto })
  set(@Body() dto: SetRefsDto, @Caller() caller: Client | null) {
    return this.assets.setRefs(needKey(caller), dto.refs, "set");
  }

  @Post()
  @ApiOperation({
    summary: "Add what records use",
    description: "Adds to what is known and never deletes anything: for catching up, safe to repeat. Needs a client key.",
  })
  @ApiBody({ type: SetRefsDto })
  add(@Body() dto: SetRefsDto, @Caller() caller: Client | null) {
    return this.assets.setRefs(needKey(caller), dto.refs, "add");
  }
}

function needKey(caller: Client | null): Client {
  if (!caller) throw new UnauthorizedException("Send x-client-key and x-client-secret");
  return caller;
}
