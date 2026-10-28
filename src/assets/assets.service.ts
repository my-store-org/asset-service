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
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";
import { Asset } from "./asset.entity";

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

export const ALLOWED_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
];

/**
 * Files too big to pass through the API and the proxies in front of it — the
 * staff app's APK is ~80 MB — go from the browser straight to the bucket on
 * a signed link (`signUpload`), then are registered here (`completeUpload`).
 * Only these kinds, each with its own folder and ceiling.
 */
export const DIRECT_TYPES: Record<string, { ext: string; folder: string; max: number }> = {
  "application/vnd.android.package-archive": { ext: "apk", folder: "apps", max: 300 * 1024 * 1024 },
};
/** How long a signed upload link works. */
const DIRECT_LINK_SECONDS = 60 * 60;
/** `apps/<uuid>/<name>.apk`: the uuid keeps keys unguessable, the name is what a download saves as. */
const DIRECT_KEY = /^apps\/[0-9a-f-]{36}\/[A-Za-z0-9._-]{1,120}\.apk$/;

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

  /**
   * A signed link the browser PUTs a large file to, straight into the bucket.
   *
   * The key is made here, so a caller cannot pick one; the file name in it is
   * cleaned to safe characters and is what the download saves as. The browser
   * must send the same Content-Type it was signed for.
   */
  async signUpload(contentType: string, size: number, fileName: string) {
    const kind = DIRECT_TYPES[contentType];
    if (!kind) throw new BadRequestException("Only an Android app (.apk) can be uploaded this way");
    if (!Number.isInteger(size) || size <= 0) throw new BadRequestException("The file is empty");
    if (size > kind.max) throw new BadRequestException(`The file is over ${Math.round(kind.max / 1024 / 1024)} MB`);
    const stem = fileName.replace(/\.[^.]*$/, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 100) || "app";
    const objectKey = `${kind.folder}/${randomUUID()}/${stem}.${kind.ext}`;
    const uploadUrl = await getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.bucket, Key: objectKey, ContentType: contentType }),
      { expiresIn: DIRECT_LINK_SECONDS },
    );
    return { uploadUrl, objectKey, contentType, expiresAt: new Date(Date.now() + DIRECT_LINK_SECONDS * 1000) };
  }

  /**
   * Records a file the browser uploaded on a signed link, once it is really
   * there: its type and size are read back from the bucket, not taken from the
   * caller. One over its ceiling is deleted rather than kept.
   */
  async completeUpload(objectKey: string, scope = "") {
    if (!DIRECT_KEY.test(objectKey)) throw new BadRequestException("Not an uploaded app file");
    const existing = await this.assets.findOne({ where: { objectKey } });
    if (existing) return this.present(existing);
    let head;
    try {
      head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: objectKey }));
    } catch {
      throw new NotFoundException("The upload did not arrive — try again");
    }
    const contentType = head.ContentType ?? "";
    const kind = DIRECT_TYPES[contentType];
    const size = head.ContentLength ?? 0;
    if (!kind || size <= 0 || size > kind.max) {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey })).catch(() => undefined);
      throw new BadRequestException("That file is not an Android app within the size limit");
    }
    const asset = await this.assets.save(
      this.assets.create({
        objectKey,
        contentType,
        size,
        originalName: objectKey.split("/").pop() ?? "",
        folder: kind.folder,
        scope: scope.slice(0, 190),
      }),
    );
    this.logger.log(`Registered ${asset.id} (${size}B) at ${objectKey}`);
    return this.present(asset);
  }

  /**
   * Gives another store or theme its own physical copy of a catalogue asset.
   *
   * Only this service's public host is accepted. That keeps the operation an
   * S3-side copy and prevents this endpoint becoming a general URL fetcher.
   */
  async copy(sourceUrl: string, folder: string, scope: string) {
    let parsed: URL;
    try {
      parsed = new URL(sourceUrl);
    } catch {
      throw new BadRequestException("Invalid source asset URL");
    }
    if (parsed.protocol !== "https:" || parsed.host !== this.publicHost) {
      throw new BadRequestException("Source must belong to this asset service");
    }

    const objectKey = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
    const source = await this.assets.findOne({ where: { objectKey } });

    // Saving an existing theme should not manufacture a new file each time.
    if (source?.scope === scope && source.folder === folder) {
      return this.present(source);
    }

    /*
     * Catalogue files are deployed with the API image, while asset metadata
     * lives in this service's database. On a fresh production database an
     * older CDN object can therefore exist in our bucket without having a row
     * here. Read its trusted S3 metadata so it can still seed a new store.
     * The host check above keeps this an operation on our own bucket; it never
     * downloads an arbitrary external URL.
     */
    let contentType = source?.contentType;
    let size = source?.size;
    let originalName = source?.originalName;
    if (!source) {
      try {
        const metadata = await this.client.send(
          new HeadObjectCommand({ Bucket: this.bucket, Key: objectKey }),
        );
        contentType = metadata.ContentType;
        size = metadata.ContentLength;
        originalName = objectKey.split("/").pop() ?? "catalogue-image";
      } catch {
        throw new NotFoundException("Source asset not found");
      }
    }

    const safeFolder = ALLOWED_FOLDERS.includes(folder) ? folder : "uploads";
    const extension = contentType ? EXTENSION[contentType] : undefined;
    if (!extension) throw new BadRequestException("Unsupported source asset type");
    const targetKey = `${safeFolder}/${randomUUID()}.${extension}`;

    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: encodeURIComponent(`${this.bucket}/${objectKey}`).replace(/%2F/g, "/"),
        Key: targetKey,
        ContentType: contentType,
        CacheControl: "public, max-age=31536000, immutable",
        MetadataDirective: "REPLACE",
      }),
    );

    const copy = await this.assets.save(
      this.assets.create({
        objectKey: targetKey,
        contentType,
        size: size ?? 0,
        originalName: (originalName ?? "catalogue-image").slice(0, 255),
        folder: safeFolder,
        scope,
      }),
    );
    this.logger.log(`Copied ${source?.id ?? objectKey} to ${copy.id} for ${scope}`);
    return this.present(copy);
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
