import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsInt, IsOptional, IsString, IsUrl, Length, Min } from "class-validator";

/** The shape every asset endpoint returns. */
export class AssetResponseDto {
  @ApiProperty({
    description: "Stable id. Store this — urls may change if the CDN moves.",
    example: "9a267d29-6482-4b88-acf0-6aa7c1f7cd72",
    format: "uuid",
  })
  id: string;

  @ApiProperty({
    description: "Public CDN url for the stored object.",
    example:
      "https://dait7q0tunfcy.cloudfront.net/products/165d5c50-acdd-464b.png",
  })
  url: string;

  @ApiProperty({ description: "The bucket it is stored in.", example: "my-store-dev-bucket" })
  bucket: string;

  @ApiProperty({ example: "image/png" })
  contentType: string;

  @ApiProperty({ description: "Size in bytes.", example: 115 })
  size: number;

  @ApiProperty({
    description: "Filename as uploaded, kept for the media library.",
    example: "hoodie-front.png",
  })
  originalName: string;

  @ApiProperty({
    description: "Grouping folder.",
    example: "products",
    enum: ["products", "categories", "marketing", "branding", "ugc", "feed", "avatars", "videos", "voice", "uploads", "apps"],
  })
  folder: string;

  @ApiProperty({
    description:
      "Who the image belongs to — the tag the uploader set. Empty on assets " +
      "stored before ownership was recorded.",
    example: "theme:acme:12",
  })
  scope: string;

  @ApiProperty({ type: String, format: "date-time" })
  createdAt: Date;
}

export class DeletedAssetDto {
  @ApiProperty({ format: "uuid" })
  deleted: string;
}

/** Documents the multipart body; the file itself is handled by multer. */
export class UploadAssetDto {
  @ApiProperty({
    type: "string",
    format: "binary",
    description: "An image (JPEG, PNG, WebP, AVIF — 15 MB), a video (MP4, WebM, MOV — 200 MB) or audio (MP3, M4A, AAC, OGG, WebM, WAV — 50 MB).",
  })
  file: unknown;
}

export class ListAssetsQueryDto {
  @ApiPropertyOptional({
    description: "Restrict to one folder.",
    example: "products",
  })
  folder?: string;

  @ApiPropertyOptional({
    description: "Max rows to return (capped at 200).",
    example: 50,
  })
  limit?: number;
}

/** Asks for a signed link to upload a large file (an APK) straight to the bucket. */
export class SignUploadDto {
  @ApiProperty({ example: "application/vnd.android.package-archive" })
  @IsString()
  @Length(1, 100)
  contentType: string;

  @ApiProperty({ description: "Size in bytes.", example: 78568045 })
  @IsInt()
  @Min(1)
  size: number;

  @ApiProperty({ example: "Staff Portal.apk" })
  @IsString()
  @Length(1, 200)
  fileName: string;

  @ApiPropertyOptional({
    description: "The caller's own bucket (S3_BUCKET or one in S3_BUCKETS); left out, the default.",
    example: "my-store-dev-bucket",
  })
  @IsOptional()
  @IsString()
  @Length(3, 63)
  bucket?: string;
}

/** Registers a file uploaded on a signed link. */
export class CompleteUploadDto {
  @ApiProperty({ example: "apps/9a267d29-6482-4b88-acf0-6aa7c1f7cd72/Staff-Portal.apk" })
  @IsString()
  @Length(1, 512)
  objectKey: string;

  @ApiPropertyOptional({ example: "platform:app" })
  @IsOptional()
  @IsString()
  @Length(0, 190)
  scope?: string;

  @ApiPropertyOptional({
    description: "The bucket it was signed for (S3_BUCKET or one in S3_BUCKETS); left out, the default.",
    example: "my-store-dev-bucket",
  })
  @IsOptional()
  @IsString()
  @Length(3, 63)
  bucket?: string;
}

/** Makes an independently owned CDN object from an existing CDN asset. */
export class CopyAssetDto {
  @ApiProperty({
    description: "Public CDN URL of an asset already owned by this service.",
  })
  @IsUrl({ protocols: ["https"], require_protocol: true })
  sourceUrl: string;

  @ApiProperty({
    enum: ["products", "categories", "marketing", "branding", "ugc", "feed", "avatars", "videos", "voice"],
  })
  @IsString()
  @IsIn(["products", "categories", "marketing", "branding", "ugc", "feed", "avatars", "videos", "voice"])
  folder: string;

  @ApiProperty({ example: "theme:acme:12" })
  @IsString()
  @Length(1, 190)
  scope: string;

  @ApiPropertyOptional({
    description: "The caller's own bucket (S3_BUCKET or one in S3_BUCKETS); left out, the source's own bucket.",
    example: "my-store-dev-bucket",
  })
  @IsOptional()
  @IsString()
  @Length(3, 63)
  bucket?: string;
}
