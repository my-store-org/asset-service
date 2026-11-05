import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  ForbiddenException,
  Get,
  Injectable,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ApiHeader,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from "@nestjs/swagger";
import { ArrayMaxSize, IsArray, IsBoolean, IsOptional, IsString, Length } from "class-validator";
import { createHash, timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import { AssetsService } from "../assets/assets.service";
import { ClientsService } from "./clients.service";

/** Only whoever runs this service: `x-admin-key` must equal ADMIN_KEY. */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(ctx: ExecutionContext) {
    const want = (this.config.get<string>("ADMIN_KEY") ?? "").trim();
    if (!want) throw new ForbiddenException("Set ADMIN_KEY to manage clients");
    const given = ctx.switchToHttp().getRequest<Request>().header("x-admin-key") ?? "";
    // Hashed first so both sides are the same length for the constant-time compare.
    const h = (s: string) => createHash("sha256").update(s).digest();
    if (!timingSafeEqual(h(given), h(want))) throw new UnauthorizedException("Wrong admin key");
    return true;
  }
}

export class CreateClientDto {
  @ApiProperty({ example: "Sambath Loan" })
  @IsString()
  @Length(1, 120)
  name: string;

  @ApiProperty({ description: "Where its files go (S3_BUCKET or one in S3_BUCKETS).", example: "sambath-loan-bucket" })
  @IsString()
  @Length(3, 63)
  bucket: string;

  @ApiPropertyOptional({ type: [String], description: "Other buckets that are its own.", example: [] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  buckets?: string[];

  @ApiPropertyOptional({
    description: "My Store: it also owns every store's own bucket (<store>-my-store-assets-<id>).",
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  storeBuckets?: boolean;

  @ApiPropertyOptional({
    description: "The same file uploaded again is stored once. Turn off for an app that doesn't send PUT /refs (My Store).",
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  sameFileCheck?: boolean;

  @ApiPropertyOptional({
    description: "Its old files (in its buckets, belonging to no one) become its own. On unless false.",
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  claimExisting?: boolean;

  @ApiPropertyOptional({
    description:
      "false: made turned off. Its key then works like no key and it owns nothing, so the app " +
      "can be deployed with it first; turn it on (PATCH active: true) to claim its files.",
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdateClientDto {
  @ApiPropertyOptional({ description: "false turns its key off." })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(3, 63)
  bucket?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  buckets?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  storeBuckets?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  sameFileCheck?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  claimExisting?: boolean;
}

@ApiTags("clients")
@ApiHeader({ name: "x-admin-key", required: true, description: "ADMIN_KEY of this service" })
@UseGuards(AdminGuard)
@Controller("clients")
export class ClientsController {
  constructor(
    private readonly clients: ClientsService,
    private readonly assets: AssetsService,
  ) {}

  @Post()
  @ApiOperation({
    summary: "Make an organization's key and secret",
    description:
      "One per app (Sambath Loan, My Store…). The secret is only in this answer: keep it. " +
      "The app then sends x-client-key and x-client-secret, and sees only its own files.",
  })
  create(@Body() dto: CreateClientDto) {
    return this.clients.create(dto);
  }

  @Get()
  @ApiOperation({ summary: "List organizations (without secrets)" })
  list() {
    return this.clients.list();
  }

  @Get("buckets")
  @ApiOperation({
    summary: "List buckets",
    description: "Every bucket this service knows, with its owner (if any) and how many files it holds.",
  })
  buckets() {
    return this.assets.bucketSummary();
  }

  @Post(":id/secret")
  @ApiOperation({ summary: "Make a new secret", description: "The old secret stops working at once." })
  rotate(@Param("id", ParseUUIDPipe) id: string) {
    return this.clients.rotateSecret(id);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Turn a key on or off, or change its buckets" })
  update(@Param("id", ParseUUIDPipe) id: string, @Body() dto: UpdateClientDto) {
    return this.clients.update(id, dto);
  }

  @Post(":id/claim")
  @ApiOperation({
    summary: "Claim old files again",
    description: "Files in its buckets that belong to no one become its own.",
  })
  claim(@Param("id", ParseUUIDPipe) id: string) {
    return this.clients.claim(id);
  }
}
