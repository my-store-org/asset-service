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
import { IsBoolean, IsOptional, IsString, Length } from "class-validator";
import { createHash, timingSafeEqual } from "node:crypto";
import type { Request } from "express";
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

  @ApiProperty({ description: "Its own bucket (S3_BUCKET or one in S3_BUCKETS).", example: "sambath-loan-bucket" })
  @IsString()
  @Length(3, 63)
  bucket: string;

  @ApiPropertyOptional({
    description: "Files already in that bucket that belong to nobody become this client's.",
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  claimExisting?: boolean;
}

export class UpdateClientDto {
  @ApiProperty({ description: "false turns its key off." })
  @IsBoolean()
  active: boolean;
}

@ApiTags("clients")
@ApiHeader({ name: "x-admin-key", required: true, description: "ADMIN_KEY of this service" })
@UseGuards(AdminGuard)
@Controller("clients")
export class ClientsController {
  constructor(private readonly clients: ClientsService) {}

  @Post()
  @ApiOperation({
    summary: "Make an organization's key and secret",
    description:
      "One per app (Sambath Loan, My Store…). The secret is only in this answer: keep it. " +
      "The app then sends x-client-key and x-client-secret, and sees only its own files.",
  })
  create(@Body() dto: CreateClientDto) {
    return this.clients.create(dto.name, dto.bucket, dto.claimExisting);
  }

  @Get()
  @ApiOperation({ summary: "List organizations (without secrets)" })
  list() {
    return this.clients.list();
  }

  @Post(":id/secret")
  @ApiOperation({ summary: "Make a new secret", description: "The old secret stops working at once." })
  rotate(@Param("id", ParseUUIDPipe) id: string) {
    return this.clients.rotateSecret(id);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Turn a key on or off" })
  update(@Param("id", ParseUUIDPipe) id: string, @Body() dto: UpdateClientDto) {
    return this.clients.setActive(id, dto.active);
  }
}
