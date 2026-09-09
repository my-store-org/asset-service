import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { Asset } from "./asset.entity";

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

export const ALLOWED_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
];

const ALLOWED_FOLDERS = [
  // "avatars" is the people who run the shop, kept apart from "branding",
  // which is the shop itself — a staff photo is not a store asset.
  "products", "categories", "marketing", "branding", "ugc", "feed", "avatars",
];

const EXTENSION: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
};

@Injectable()
export class AssetsService {
  private readonly logger = new Logger(AssetsService.name);
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicHost: string;

  constructor(
    @InjectRepository(Asset) private readonly assets: Repository<Asset>,
    config: ConfigService,
  ) {
    const region = config.get<string>("AWS_REGION");
    const accessKeyId = config.get<string>("AWS_ACCESS_KEY_ID");
    const secretAccessKey = config.get<string>("AWS_SECRET_ACCESS_KEY");
    if (!region) throw new Error("AWS_REGION is not set");

    this.bucket = config.get<string>("S3_BUCKET") as string;
    this.publicHost = config.get<string>("S3_PUBLIC_HOST") as string;
    this.client =
      accessKeyId && secretAccessKey
        ? new S3Client({ region, credentials: { accessKeyId, secretAccessKey } })
        : new S3Client({ region });
  }

  async upload(file: Express.Multer.File, folder = "uploads", scope = "") {
    if (!file) throw new BadRequestException("No file uploaded");
    if (!ALLOWED_TYPES.includes(file.mimetype)) {
      throw new BadRequestException(
        `Unsupported type ${file.mimetype}. Use JPEG, PNG, WebP or AVIF.`,
      );
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new BadRequestException("File exceeds the 15 MB limit");
    }
    const safeFolder = ALLOWED_FOLDERS.includes(folder) ? folder : "uploads";

    // The key is service-generated so a caller can never overwrite another
    // asset by choosing a path.
    const objectKey = `${safeFolder}/${randomUUID()}.${EXTENSION[file.mimetype]}`;

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        Body: file.buffer,
        ContentType: file.mimetype,
        CacheControl: "public, max-age=31536000, immutable",
      }),
    );

    const asset = await this.assets.save(
      this.assets.create({
        objectKey,
        contentType: file.mimetype,
        size: file.size,
        originalName: file.originalname?.slice(0, 255) ?? "",
        folder: safeFolder,
        // Trusted as given: the caller knows whose image this is, and the tag
        // is only ever compared for equality, never interpreted here.
        scope: scope.slice(0, 190),
      }),
    );
    this.logger.log(`Stored ${asset.id} (${file.size}B) at ${objectKey}`);
    return this.present(asset);
  }

  async findOne(id: string) {
    const asset = await this.assets.findOne({ where: { id } });
    if (!asset) throw new NotFoundException(`Asset ${id} not found`);
    return this.present(asset);
  }

  /**
   * Newest first, narrowed by kind and by owner.
   *
   * A caller that passes a scope sees only what belongs to it. Passing none
   * still returns everything — the service's own tooling wants that, and the
   * endpoint is not the place to decide a caller is untrustworthy.
   */
  async findAll(folder?: string, limit = 50, scope?: string) {
    const rows = await this.assets.find({
      where: {
        ...(folder ? { folder } : {}),
        ...(scope ? { scope } : {}),
      },
      order: { createdAt: "DESC" },
      take: Math.min(limit, 200),
    });
    return rows.map((a) => this.present(a));
  }

  /** Removes the object then the record; a missing object is not an error. */
  async remove(id: string) {
    const asset = await this.assets.findOne({ where: { id } });
    if (!asset) throw new NotFoundException(`Asset ${id} not found`);
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: asset.objectKey }),
      );
    } catch (err) {
      this.logger.warn(
        `S3 delete failed for ${asset.objectKey}: ${(err as Error).message}`,
      );
    }
    await this.assets.delete(id);
    this.logger.log(`Deleted asset ${id}`);
    return { deleted: id };
  }

  private present(asset: Asset) {
    return {
      id: asset.id,
      url: `https://${this.publicHost}/${asset.objectKey}`,
      contentType: asset.contentType,
      size: asset.size,
      originalName: asset.originalName,
      folder: asset.folder,
      scope: asset.scope,
      createdAt: asset.createdAt,
    };
  }
}
