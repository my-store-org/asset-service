import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

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
    enum: ["products", "categories", "marketing", "ugc", "feed", "uploads"],
  })
  folder: string;

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
    description: "JPEG, PNG, WebP or AVIF. Max 15 MB.",
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
