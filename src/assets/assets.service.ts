import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { In, Repository } from "typeorm";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { Asset } from "./asset.entity";
import { Buckets } from "./buckets";
import { StoreBuckets } from "./store-buckets";

const MB = 1024 * 1024;

/**
 * What may be uploaded, with each kind's ceiling: images (15 MB), video
 * (200 MB) and voice or other audio (50 MB). The extension is the stored
 * key's; the folder is where one lands when the caller names none it may use.
 */
export const MEDIA: Record<string, { ext: string; kind: "image" | "video" | "audio"; max: number }> = {
  "image/jpeg": { ext: "jpg", kind: "image", max: 15 * MB },
  "image/png": { ext: "png", kind: "image", max: 15 * MB },
  "image/webp": { ext: "webp", kind: "image", max: 15 * MB },
  "image/avif": { ext: "avif", kind: "image", max: 15 * MB },
  "video/mp4": { ext: "mp4", kind: "video", max: 200 * MB },
  "video/webm": { ext: "webm", kind: "video", max: 200 * MB },
  "video/quicktime": { ext: "mov", kind: "video", max: 200 * MB },
  "audio/mpeg": { ext: "mp3", kind: "audio", max: 50 * MB },
  "audio/mp4": { ext: "m4a", kind: "audio", max: 50 * MB },
  "audio/x-m4a": { ext: "m4a", kind: "audio", max: 50 * MB },
  "audio/aac": { ext: "aac", kind: "audio", max: 50 * MB },
  "audio/ogg": { ext: "ogg", kind: "audio", max: 50 * MB },
  "audio/webm": { ext: "weba", kind: "audio", max: 50 * MB },
  "audio/wav": { ext: "wav", kind: "audio", max: 50 * MB },
  "audio/x-wav": { ext: "wav", kind: "audio", max: 50 * MB },
};

/** The biggest file the upload endpoint takes at all (a video); each type is then held to its own. */
export const MAX_UPLOAD_BYTES = 200 * MB;

export const ALLOWED_TYPES = Object.keys(MEDIA);

/** Where a file lands when the caller names no folder it may use. */
const DEFAULT_FOLDER = { image: "uploads", video: "videos", audio: "voice" } as const;

const limitText = (bytes: number) => `${Math.round(bytes / MB)} MB`;

/**
 * Files too big to pass through the API and the proxies in front of it — the
 * staff app's APK is ~80 MB — go from the browser straight to the bucket on
 * a signed link (`signUpload`), then are registered here (`completeUpload`).
 * Only these kinds, each with its own folder and ceiling.
 */
export const DIRECT_TYPES: Record<string, { ext: string; folder: string; max: number }> = {
  "application/vnd.android.package-archive": { ext: "apk", folder: "apps", max: 500 * MB },
  // Video and voice may come this way too, straight from a browser or an app.
  ...Object.fromEntries(
    Object.entries(MEDIA)
      .filter(([, m]) => m.kind !== "image")
      .map(([type, m]) => [type, { ext: m.ext, folder: DEFAULT_FOLDER[m.kind], max: m.max }]),
  ),
};
/** How long a signed upload link works. */
const DIRECT_LINK_SECONDS = 60 * 60;
/** `<folder>/<uuid>/<name>.<ext>`: the uuid keeps keys unguessable, the name is what a download saves as. */
const DIRECT_KEY = /^(apps|videos|voice)\/[0-9a-f-]{36}\/[A-Za-z0-9._-]{1,120}\.(apk|mp4|webm|mov|mp3|m4a|aac|ogg|weba|wav)$/;

const ALLOWED_FOLDERS = [
  // "avatars" is the people who run the shop, kept apart from "branding",
  // which is the shop itself — a staff photo is not a store asset.
  "products", "categories", "marketing", "branding", "ugc", "feed", "avatars",
  // Video and voice, kept apart from the images.
  "videos", "voice",
];


@Injectable()
export class AssetsService {
  private readonly logger = new Logger(AssetsService.name);
  private readonly client: S3Client;
  /** The buckets callers may name, and each one's public host. */
  private readonly buckets: Buckets;
  /** Each store's own bucket, for a file uploaded with that store's scope. */
  private readonly storeBuckets: StoreBuckets;

  constructor(
    @InjectRepository(Asset) private readonly assets: Repository<Asset>,
    config: ConfigService,
  ) {
    const region = config.get<string>("AWS_REGION");
    const accessKeyId = config.get<string>("AWS_ACCESS_KEY_ID");
    const secretAccessKey = config.get<string>("AWS_SECRET_ACCESS_KEY");
    if (!region) throw new Error("AWS_REGION is not set");

    this.buckets = new Buckets({
      bucket: config.get<string>("S3_BUCKET"),
      buckets: config.get<string>("S3_BUCKETS"),
      publicHost: config.get<string>("S3_PUBLIC_HOST"),
      region,
    });
    this.storeBuckets = new StoreBuckets(config.get<string>("STORE_BUCKETS_URL"));
    const b = this.buckets.list();
    this.logger.log(`Buckets: ${b.default} (default)${b.others.length ? `, ${b.others.join(", ")}` : ""}${b.any ? ", and any other (S3_BUCKETS=*)" : ""}${this.storeBuckets.enabled ? "; each store's own, asked of the API" : ""}`);
    this.client =
      accessKeyId && secretAccessKey
        ? new S3Client({ region, credentials: { accessKeyId, secretAccessKey } })
        : new S3Client({ region });
  }

  /**
   * The bucket a file goes to: the one the caller names (if allowed), else
   * the store's own when the scope is a store's, else the default.
   */
  private async bucketFor(bucketName: string | undefined, scope: string) {
    if (bucketName?.trim()) return this.buckets.pick(bucketName);
    return (await this.storeBuckets.forScope(scope)) ?? this.buckets.default;
  }

  /** `bucket`: the caller's own bucket (one of those allowed); else the store's own, else the default. */
  async upload(file: Express.Multer.File, folder = "uploads", scope = "", bucketName?: string) {
    if (!file) throw new BadRequestException("No file uploaded");
    // The controller writes it to a temporary file (a 200 MB video is not held in memory); gone once handled.
    try {
      const bucket = await this.bucketFor(bucketName, scope);
      const media = MEDIA[file.mimetype];
      if (!media) {
        throw new BadRequestException(
          `Unsupported type ${file.mimetype}. Use an image (JPEG, PNG, WebP, AVIF), a video (MP4, WebM, MOV) or audio (MP3, M4A, AAC, OGG, WebM, WAV).`,
        );
      }
      if (file.size > media.max) {
        throw new BadRequestException(`${{ image: "An image", video: "A video", audio: "An audio file" }[media.kind]} can be up to ${limitText(media.max)}`);
      }
      const safeFolder = ALLOWED_FOLDERS.includes(folder) ? folder : DEFAULT_FOLDER[media.kind];

      // The key is service-generated so a caller can never overwrite another
      // asset by choosing a path.
      const objectKey = `${safeFolder}/${randomUUID()}.${media.ext}`;

      await this.client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: objectKey,
          Body: file.path ? createReadStream(file.path) : file.buffer,
          ContentLength: file.size,
          ContentType: file.mimetype,
          CacheControl: "public, max-age=31536000, immutable",
        }),
      );

      const asset = await this.assets.save(
        this.assets.create({
          bucket,
          objectKey,
          contentType: file.mimetype,
          size: file.size,
          originalName: file.originalname?.slice(0, 255) ?? "",
          folder: safeFolder,
          // Trusted as given: the caller knows whose file this is, and the tag
          // is only ever compared for equality, never interpreted here.
          scope: scope.slice(0, 190),
        }),
      );
      this.logger.log(`Stored ${asset.id} (${file.size}B) at ${bucket}/${objectKey}`);
      return this.present(asset);
    } finally {
      if (file.path) await unlink(file.path).catch(() => undefined);
    }
  }

  /**
   * A signed link the browser PUTs a large file to, straight into the bucket.
   *
   * The key is made here, so a caller cannot pick one; the file name in it is
   * cleaned to safe characters and is what the download saves as. The browser
   * must send the same Content-Type it was signed for.
   */
  async signUpload(contentType: string, size: number, fileName: string, bucketName?: string) {
    const bucket = this.buckets.pick(bucketName);
    const kind = DIRECT_TYPES[contentType];
    if (!kind) throw new BadRequestException("Only an Android app (.apk), a video or audio can be uploaded this way");
    if (!Number.isInteger(size) || size <= 0) throw new BadRequestException("The file is empty");
    if (size > kind.max) throw new BadRequestException(`The file is over ${Math.round(kind.max / 1024 / 1024)} MB`);
    const stem = fileName.replace(/\.[^.]*$/, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 100) || "app";
    const objectKey = `${kind.folder}/${randomUUID()}/${stem}.${kind.ext}`;
    const uploadUrl = await getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: bucket, Key: objectKey, ContentType: contentType }),
      { expiresIn: DIRECT_LINK_SECONDS },
    );
    return { uploadUrl, objectKey, bucket, contentType, expiresAt: new Date(Date.now() + DIRECT_LINK_SECONDS * 1000) };
  }

  /**
   * Records a file the browser uploaded on a signed link, once it is really
   * there: its type and size are read back from the bucket, not taken from the
   * caller. One over its ceiling is deleted rather than kept.
   */
  async completeUpload(objectKey: string, scope = "", bucketName?: string) {
    const bucket = this.buckets.pick(bucketName);
    if (!DIRECT_KEY.test(objectKey)) throw new BadRequestException("Not a file uploaded on a signed link");
    const existing = await this.assets.findOne({ where: { objectKey } });
    if (existing) return this.present(existing);
    let head;
    try {
      head = await this.client.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }));
    } catch {
      throw new NotFoundException("The upload did not arrive — try again");
    }
    const contentType = head.ContentType ?? "";
    const kind = DIRECT_TYPES[contentType];
    const size = head.ContentLength ?? 0;
    if (!kind || size <= 0 || size > kind.max || !objectKey.startsWith(`${kind.folder}/`)) {
      await this.client.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey })).catch(() => undefined);
      throw new BadRequestException("That file is not an allowed type within its size limit");
    }
    const asset = await this.assets.save(
      this.assets.create({
        bucket,
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
  async copy(sourceUrl: string, folder: string, scope: string, bucketName?: string) {
    let parsed: URL;
    try {
      parsed = new URL(sourceUrl);
    } catch {
      throw new BadRequestException("Invalid source asset URL");
    }
    // The source's bucket, from its url: only one of ours, so this never fetches an outside url.
    const from = parsed.protocol === "https:" ? this.buckets.fromHost(parsed.host) : null;
    if (!from) {
      throw new BadRequestException("Source must belong to this asset service");
    }
    // The copy goes to the bucket asked for, else its store's own, else next to its source.
    const bucket = bucketName ? this.buckets.pick(bucketName) : ((await this.storeBuckets.forScope(scope)) ?? from);

    const objectKey = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
    const source = await this.assets.findOne({ where: { objectKey } });

    // Saving an existing theme should not manufacture a new file each time.
    if (source?.scope === scope && source.folder === folder && this.bucketOf(source) === bucket) {
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
          new HeadObjectCommand({ Bucket: from, Key: objectKey }),
        );
        contentType = metadata.ContentType;
        size = metadata.ContentLength;
        originalName = objectKey.split("/").pop() ?? "catalogue-image";
      } catch {
        throw new NotFoundException("Source asset not found");
      }
    }

    const safeFolder = ALLOWED_FOLDERS.includes(folder) ? folder : "uploads";
    const extension = contentType ? MEDIA[contentType]?.ext : undefined;
    if (!extension) throw new BadRequestException("Unsupported source asset type");
    const targetKey = `${safeFolder}/${randomUUID()}.${extension}`;

    await this.client.send(
      new CopyObjectCommand({
        Bucket: bucket,
        CopySource: encodeURIComponent(`${from}/${objectKey}`).replace(/%2F/g, "/"),
        Key: targetKey,
        ContentType: contentType,
        CacheControl: "public, max-age=31536000, immutable",
        MetadataDirective: "REPLACE",
      }),
    );

    const copy = await this.assets.save(
      this.assets.create({
        bucket,
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
  async findAll(folder?: string, limit = 50, scope?: string, bucketName?: string) {
    // A bucket named: only its assets (rows from before buckets count as the default's).
    const bucket = bucketName ? this.buckets.pick(bucketName) : undefined;
    const rows = await this.assets.find({
      where: {
        ...(folder ? { folder } : {}),
        ...(scope ? { scope } : {}),
        ...(bucket ? { bucket: bucket === this.buckets.default ? In([bucket, ""]) : bucket } : {}),
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
        new DeleteObjectCommand({ Bucket: this.bucketOf(asset), Key: asset.objectKey }),
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

  /** The bucket an asset is in: its own, or the default for one stored before buckets. */
  private bucketOf(asset: Asset) {
    return asset.bucket || this.buckets.default;
  }

  private present(asset: Asset) {
    const bucket = this.bucketOf(asset);
    return {
      id: asset.id,
      url: `https://${this.buckets.host(bucket)}/${asset.objectKey}`,
      bucket,
      contentType: asset.contentType,
      size: asset.size,
      originalName: asset.originalName,
      folder: asset.folder,
      scope: asset.scope,
      createdAt: asset.createdAt,
    };
  }
}
