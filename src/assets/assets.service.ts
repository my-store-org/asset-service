import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { In, IsNull, Repository } from "typeorm";
import { Client as ClientRow, namedBuckets } from "../clients/client.entity";
import {
  CopyObjectCommand,
  CreateBucketCommand,
  type BucketLocationConstraint,
  DeleteObjectCommand,
  PutBucketCorsCommand,
  PutBucketPolicyCommand,
  PutPublicAccessBlockCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { unlink } from "node:fs/promises";
import type { Readable } from "node:stream";
import type { Client } from "../clients/client.entity";
import { AssetRef } from "./asset-ref.entity";
import { ManagedBucket } from "./managed-bucket.entity";
import { Asset } from "./asset.entity";
import { Buckets, STORE_BUCKET } from "./buckets";
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


/** S3's rule for a bucket name: 3–63 of a-z, 0-9, dot and dash. */
const BUCKET_NAME_RULE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/** The organization calling (by its key), or null for a caller without one. */
type Caller = Client | null;

/** SHA-256 of a stream's bytes, read chunk by chunk (a 200 MB video is never held in memory). */
async function hashStream(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

@Injectable()
export class AssetsService implements OnApplicationBootstrap, OnModuleInit {
  private readonly logger = new Logger(AssetsService.name);
  private readonly client: S3Client;
  private readonly region: string;
  /** The buckets callers may name, and each one's public host. */
  private readonly buckets: Buckets;
  /** Each store's own bucket, for a file uploaded with that store's scope. */
  private readonly storeBuckets: StoreBuckets;

  constructor(
    @InjectRepository(Asset) private readonly assets: Repository<Asset>,
    @InjectRepository(AssetRef) private readonly refs: Repository<AssetRef>,
    @InjectRepository(ClientRow) private readonly clientRows: Repository<ClientRow>,
    @InjectRepository(ManagedBucket) private readonly managed: Repository<ManagedBucket>,
    config: ConfigService,
  ) {
    const region = config.get<string>("AWS_REGION");
    const accessKeyId = config.get<string>("AWS_ACCESS_KEY_ID");
    const secretAccessKey = config.get<string>("AWS_SECRET_ACCESS_KEY");
    if (!region) throw new Error("AWS_REGION is not set");
    this.region = region;

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

  /** Buckets made through the service are allowed from start-up, before any request. */
  async onModuleInit() {
    for (const b of await this.managed.find()) this.buckets.add(b.name, b.publicHost);
  }

  /**
   * Makes a bucket in this service's region and allows it at once (no S3_BUCKETS edit,
   * no restart). Set up like every other one: anyone can read a file by its url, nobody
   * can list or write without keys, and a browser may upload on a signed link.
   */
  async createBucket(name: string) {
    const bucket = name.trim().toLowerCase();
    if (!BUCKET_NAME_RULE.test(bucket) || bucket.includes("..") || /^\d+\.\d+\.\d+\.\d+$/.test(bucket)) {
      throw new BadRequestException("A bucket name is 3–63 of a-z, 0-9, dot and dash, starting and ending with a letter or digit");
    }
    if (this.buckets.knows(bucket)) throw new ConflictException(`"${bucket}" is already one of this service's buckets`);
    const region = this.region;
    try {
      await this.client.send(
        new CreateBucketCommand({
          Bucket: bucket,
          ...(region !== "us-east-1" && { CreateBucketConfiguration: { LocationConstraint: region as BucketLocationConstraint } }),
        }),
      );
    } catch (err) {
      const code = (err as { name?: string }).name;
      // Made before (a retry, or by hand) in this same AWS account: take it as it is.
      if (code !== "BucketAlreadyOwnedByYou") throw this.s3Problem(code, bucket, err as Error);
    }
    try {
      await this.client.send(
        new PutPublicAccessBlockCommand({
          Bucket: bucket,
          // ACLs stay blocked; only the read policy below makes files public.
          PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: false, RestrictPublicBuckets: false },
        }),
      );
      await this.client.send(
        new PutBucketPolicyCommand({
          Bucket: bucket,
          Policy: JSON.stringify({
            Version: "2012-10-17",
            Statement: [{ Sid: "PublicRead", Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: `arn:aws:s3:::${bucket}/*` }],
          }),
        }),
      );
      await this.client.send(
        new PutBucketCorsCommand({
          Bucket: bucket,
          CORSConfiguration: { CORSRules: [{ AllowedMethods: ["GET", "HEAD", "PUT"], AllowedOrigins: ["*"], AllowedHeaders: ["*"], MaxAgeSeconds: 3600 }] },
        }),
      );
    } catch (err) {
      throw this.s3Problem((err as { name?: string }).name, bucket, err as Error, true);
    }
    await this.managed.save(this.managed.create({ name: bucket }));
    this.buckets.add(bucket);
    this.logger.log(`Bucket ${bucket} made in ${region}`);
    return { bucket, host: this.buckets.host(bucket), region };
  }

  /** An S3 refusal, as something a person can act on. */
  private s3Problem(code: string | undefined, bucket: string, err: Error, settingUp = false) {
    if (code === "BucketAlreadyExists") {
      return new ConflictException(`"${bucket}" is taken: bucket names are shared by every AWS account in the world. Try another.`);
    }
    if (code === "InvalidBucketName") return new BadRequestException(`"${bucket}" is not a name S3 accepts`);
    if (code === "AccessDenied" || code === "AllAccessDisabled") {
      return new ForbiddenException(
        settingUp
          ? `The bucket was made, but the service's AWS keys may not set it up (s3:PutBucketPublicAccessBlock, s3:PutBucketPolicy, s3:PutBucketCORS). Allow those and make it again.`
          : `The service's AWS keys may not make buckets (s3:CreateBucket). Allow it in IAM, or make the bucket in the AWS console.`,
      );
    }
    if (code === "TooManyBuckets") return new BadRequestException("This AWS account has reached its bucket limit");
    this.logger.error(`S3 refused ${bucket}: ${code ?? ""} ${err.message}`);
    return new BadRequestException(`S3 refused: ${err.message}`);
  }

  /** A bucket this service may write to (refused otherwise). */
  checkBucket(name: string) {
    return this.buckets.pick(name);
  }

  /**
   * Every bucket this service knows: the ones it is set up to write to (S3_BUCKET,
   * S3_BUCKETS), the ones organizations own, and any it holds files in (a store's own,
   * made later). Each with its owner and how many files it holds.
   */
  async bucketSummary() {
    const config = this.buckets.list();
    const rows = (await this.assets.query(
      `SELECT bucket, COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes,
              SUM(client_id IS NULL) AS unowned, MAX(created_at) AS lastUpload
         FROM assets GROUP BY bucket`,
    )) as { bucket: string; files: string; bytes: string; unowned: string; lastUpload: Date | null }[];
    // Rows from before buckets were recorded are in the default one.
    const stats = new Map<string, { files: number; bytes: number; unowned: number; lastUpload: Date | null }>();
    for (const r of rows) {
      const name = r.bucket || config.default;
      const s = stats.get(name) ?? { files: 0, bytes: 0, unowned: 0, lastUpload: null };
      s.files += Number(r.files);
      s.bytes += Number(r.bytes);
      s.unowned += Number(r.unowned);
      if (r.lastUpload && (!s.lastUpload || r.lastUpload > s.lastUpload)) s.lastUpload = r.lastUpload;
      stats.set(name, s);
    }
    const clients = await this.clientRows.find();
    const names = new Set([config.default, ...config.others, ...config.made, ...stats.keys(), ...clients.flatMap((c) => namedBuckets(c))]);
    const kindOf = (b: string): "default" | "listed" | "made" | "store" | "other" =>
      b === config.default
        ? "default"
        : config.others.includes(b)
          ? "listed"
          : config.made.includes(b)
            ? "made"
            : STORE_BUCKET.test(b)
              ? "store"
              : "other";
    const order = { default: 0, listed: 1, made: 2, store: 3, other: 4 } as const;
    return {
      anyBucket: config.any,
      buckets: [...names]
        .map((bucket) => {
          const owners = clients.filter((c) => this.owns(c, bucket));
          const owner = owners.find((c) => c.active) ?? null;
          const s = stats.get(bucket) ?? { files: 0, bytes: 0, unowned: 0, lastUpload: null };
          return {
            bucket,
            kind: kindOf(bucket),
            host: this.buckets.host(bucket),
            owner: owner && { id: owner.id, name: owner.name },
            // Keys made for it but still turned off (they own nothing yet).
            waiting: owners.filter((c) => !c.active).map((c) => ({ id: c.id, name: c.name })),
            ...s,
          };
        })
        .sort((a, b) => order[a.kind] - order[b.kind] || b.files - a.files || a.bucket.localeCompare(b.bucket)),
    };
  }

  get defaultBucket() {
    return this.buckets.default;
  }

  /** Whether [client] owns [bucket]: one it names, or (store buckets on) any store's own. */
  owns(client: Client, bucket: string) {
    return namedBuckets(client).includes(bucket) || (client.storeBuckets && STORE_BUCKET.test(bucket));
  }

  /**
   * Files that belong to nobody and are in [client]'s buckets become its own: its old
   * files, stored before it had a key, keep working with it. Only [ids] when given,
   * else all of them. Returns how many.
   */
  async claimUnowned(client: Client, ids?: string[]) {
    if (ids && !ids.length) return 0;
    const q = this.assets
      .createQueryBuilder()
      .update()
      .set({ clientId: client.id })
      .where("client_id IS NULL")
      .andWhere(
        client.storeBuckets
          ? "(bucket IN (:...named) OR bucket REGEXP :store)"
          : "bucket IN (:...named)",
        { named: namedBuckets(client), store: STORE_BUCKET.source },
      );
    if (ids) q.andWhere("id IN (:...ids)", { ids });
    const claimed = (await q.execute()).affected ?? 0;
    if (claimed) {
      this.logger.log(`${claimed} old file(s) now belong to ${client.name}`);
      void this.fillFingerprints();
    }
    return claimed;
  }

  /**
   * Whether [caller] may see [asset]: an organization its own files (and old ones of no
   * one in its buckets, which become its own on use); a caller without a key only files
   * that belong to no organization.
   */
  private mine(asset: Asset, caller: Caller) {
    if (!caller) return !asset.clientId;
    return asset.clientId === caller.id || (!asset.clientId && this.owns(caller, this.bucketOf(asset)));
  }

  /** The asset with this id, if [caller] may see it; otherwise not found (it isn't said that it exists). */
  private async owned(id: string, caller: Caller) {
    const asset = await this.assets.findOne({ where: { id } });
    if (!asset || !this.mine(asset, caller)) throw new NotFoundException(`Asset ${id} not found`);
    if (caller && !asset.clientId) {
      await this.claimUnowned(caller, [asset.id]);
      asset.clientId = caller.id;
    }
    return asset;
  }

  /** Active organizations, briefly remembered (asked on every keyless write). */
  private owners: { list: Client[]; until: number } | null = null;

  /** Call after a client changes. */
  forgetOwners() {
    this.owners = null;
  }

  /** The active organization that owns [bucket], if any. */
  async ownerOf(bucket: string): Promise<Client | null> {
    if (!this.owners || this.owners.until < Date.now()) {
      this.owners = { list: await this.clientRows.find({ where: { active: true } }), until: Date.now() + 30_000 };
    }
    return this.owners.list.find((c) => this.owns(c, bucket)) ?? null;
  }

  /**
   * Refuses writing into a bucket that belongs to an organization (app) for anyone
   * without that app's key: once the loan app has a key, nothing else can put files in
   * its bucket. Buckets of no organization (my-store's) stay open as before.
   */
  private async assertMayWrite(bucket: string, caller: Caller) {
    const owner = await this.ownerOf(bucket);
    if (owner && owner.id !== caller?.id) {
      throw new ForbiddenException(`Bucket "${bucket}" belongs to ${owner.name}: send its client key and secret`);
    }
  }

  /**
   * The bucket a file goes to. An organization: the one it names if it is its own,
   * else (store buckets on) the store's own for a store's scope, else its main one.
   * Without a key: the one named (if allowed), else the store's own when the scope is a
   * store's, else the default.
   */
  private async bucketFor(bucketName: string | undefined, scope: string, caller: Caller = null) {
    if (caller) {
      const named = bucketName?.trim();
      if (named) {
        if (!this.owns(caller, named)) throw new ForbiddenException(`Bucket "${named}" is not ${caller.name}'s`);
        return named;
      }
      if (caller.storeBuckets) return (await this.storeBuckets.forScope(scope)) ?? caller.bucket;
      return caller.bucket;
    }
    if (bucketName?.trim()) return this.buckets.pick(bucketName);
    return (await this.storeBuckets.forScope(scope)) ?? this.buckets.default;
  }

  /**
   * `bucket`: the caller's own bucket (one of those allowed); else the store's own, else the default.
   *
   * An organization's upload goes to its own bucket, and the same file (same SHA-256 of
   * its contents) it stored before is not stored again: that one comes back, with
   * `duplicate: true`, so it takes space only once. (Only for organizations: they say
   * which files they use, so a shared one is kept until nothing uses it.)
   */
  async upload(file: Express.Multer.File, folder = "uploads", scope = "", bucketName?: string, caller: Caller = null) {
    if (!file) throw new BadRequestException("No file uploaded");
    // The controller writes it to a temporary file (a 200 MB video is not held in memory); gone once handled.
    try {
      const bucket = await this.bucketFor(bucketName, scope, caller);
      await this.assertMayWrite(bucket, caller);
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

      let sha256: string | null = null;
      if (caller?.sameFileCheck) {
        sha256 = file.path
          ? await hashStream(createReadStream(file.path))
          : createHash("sha256").update(file.buffer).digest("hex");
        const same = await this.assets.findOne({ where: { clientId: caller.id, bucket, sha256 } });
        if (same) {
          this.logger.log(`Same file as ${same.id} for ${caller.name}; not stored again`);
          return { ...this.present(same), originalName: file.originalname?.slice(0, 255) || same.originalName, duplicate: true };
        }
      }

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
          clientId: caller?.id ?? null,
          sha256,
        }),
      );
      this.logger.log(`Stored ${asset.id} (${file.size}B) at ${bucket}/${objectKey}${caller ? ` for ${caller.name}` : ""}`);
      return { ...this.present(asset), duplicate: false };
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
  async signUpload(contentType: string, size: number, fileName: string, bucketName?: string, caller: Caller = null) {
    const bucket = caller ? await this.bucketFor(bucketName, "", caller) : this.buckets.pick(bucketName);
    await this.assertMayWrite(bucket, caller);
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
  async completeUpload(objectKey: string, scope = "", bucketName?: string, caller: Caller = null) {
    const bucket = caller ? await this.bucketFor(bucketName, "", caller) : this.buckets.pick(bucketName);
    await this.assertMayWrite(bucket, caller);
    if (!DIRECT_KEY.test(objectKey)) throw new BadRequestException("Not a file uploaded on a signed link");
    const existing = await this.assets.findOne({ where: { objectKey } });
    if (existing) {
      if (!this.mine(existing, caller)) throw new NotFoundException("The upload did not arrive — try again");
      return this.present(await this.owned(existing.id, caller));
    }
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
        clientId: caller?.id ?? null,
      }),
    );
    if (caller) void this.fillFingerprints();
    this.logger.log(`Registered ${asset.id} (${size}B) at ${objectKey}`);
    return this.present(asset);
  }

  /**
   * Gives another store or theme its own physical copy of a catalogue asset.
   *
   * Only this service's public host is accepted. That keeps the operation an
   * S3-side copy and prevents this endpoint becoming a general URL fetcher.
   */
  async copy(sourceUrl: string, folder: string, scope: string, bucketName?: string, caller: Caller = null) {
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
    // The copy goes to an organization's own bucket; else the bucket asked for, else its store's own, else next to its source.
    const bucket = caller
      ? await this.bucketFor(bucketName, scope, caller)
      : bucketName ? this.buckets.pick(bucketName) : ((await this.storeBuckets.forScope(scope)) ?? from);
    await this.assertMayWrite(bucket, caller);

    const objectKey = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
    const source = await this.assets.findOne({ where: { objectKey } });
    // Another organization's file can't be copied (nor, by an organization, a file with no row here).
    if (source ? !this.mine(source, caller) : caller) throw new NotFoundException("Source asset not found");
    if (source && caller && !source.clientId) await this.owned(source.id, caller);

    // Saving an existing theme should not manufacture a new file each time.
    if (source?.scope === scope && source.folder === folder && this.bucketOf(source) === bucket && !caller) {
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
        clientId: caller?.id ?? null,
        sha256: source?.sha256 ?? null,
      }),
    );
    this.logger.log(`Copied ${source?.id ?? objectKey} to ${copy.id} for ${scope}`);
    return this.present(copy);
  }

  async findOne(id: string, caller: Caller = null) {
    return this.present(await this.owned(id, caller));
  }

  /**
   * Newest first, narrowed by kind and by owner.
   *
   * A caller that passes a scope sees only what belongs to it. Passing none
   * still returns everything — the service's own tooling wants that, and the
   * endpoint is not the place to decide a caller is untrustworthy.
   */
  async findAll(folder?: string, limit = 50, scope?: string, bucketName?: string, caller: Caller = null) {
    // A bucket named: only its assets (rows from before buckets count as the default's).
    const bucket = bucketName ? this.buckets.pick(bucketName) : undefined;
    const rows = await this.assets.find({
      where: {
        // An organization: only its own. Without a key: only files of no organization.
        clientId: caller ? caller.id : IsNull(),
        ...(folder ? { folder } : {}),
        ...(scope ? { scope } : {}),
        ...(bucket ? { bucket: bucket === this.buckets.default ? In([bucket, ""]) : bucket } : {}),
      },
      order: { createdAt: "DESC" },
      take: Math.min(limit, 200),
    });
    return rows.map((a) => this.present(a));
  }

  /**
   * Removes the object then the record; a missing object is not an error. An
   * organization's file that something still uses (see setRefs) is refused.
   */
  async remove(id: string, caller: Caller = null) {
    const asset = await this.owned(id, caller);
    if (caller) {
      const used = await this.refs.count({ where: { assetId: id } });
      if (used) throw new ConflictException(`Asset ${id} is still used by ${used} record(s)`);
    }
    return this.delete(asset);
  }

  /**
   * Says which files each of [caller]'s records uses ("loan:13" -> its file ids).
   *
   * mode "set": the record now uses exactly these (an empty list: nothing, e.g. it was
   * deleted). A file that no record uses any more after this is deleted from storage.
   * mode "add": these are added to what is known, nothing is taken away or deleted; for
   * telling the service about records it hasn't heard of (safe to repeat).
   *
   * Ids that aren't the caller's files are left out, and listed in `missing`.
   */
  async setRefs(caller: Client, items: { ref: string; assetIds: string[] }[], mode: "set" | "add") {
    const wanted = [...new Set(items.flatMap((i) => i.assetIds))];
    // Its old files (stored before it had a key) become its own as it says it uses them.
    await this.claimUnowned(caller, wanted);
    const own = new Set(
      wanted.length
        ? (await this.assets.find({ where: { id: In(wanted), clientId: caller.id }, select: { id: true } })).map((a) => a.id)
        : [],
    );
    const missing = wanted.filter((id) => !own.has(id));
    const names = [...new Set(items.map((i) => i.ref))];

    const dropped = await this.refs.manager.transaction(async (m) => {
      const refs = m.getRepository(AssetRef);
      let before: AssetRef[] = [];
      if (mode === "set" && names.length) {
        before = await refs.find({ where: { clientId: caller.id, ref: In(names) } });
        await refs.delete({ clientId: caller.id, ref: In(names) });
      }
      const rows = items.flatMap((i) =>
        [...new Set(i.assetIds)].filter((id) => own.has(id)).map((assetId) => ({ assetId, ref: i.ref, clientId: caller.id })),
      );
      if (rows.length) await refs.upsert(rows, ["assetId", "ref"]);
      return [...new Set(before.map((r) => r.assetId))];
    });

    // Files that lost a record: deleted once nothing at all uses them.
    const removed: string[] = [];
    if (dropped.length) {
      const still = new Set(
        (await this.refs.find({ where: { assetId: In(dropped) }, select: { assetId: true } })).map((r) => r.assetId),
      );
      for (const asset of await this.assets.find({ where: { id: In(dropped.filter((id) => !still.has(id))), clientId: caller.id } })) {
        await this.delete(asset);
        removed.push(asset.id);
      }
    }
    return { removed, missing };
  }

  private async delete(asset: Asset) {
    const id = asset.id;
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucketOf(asset), Key: asset.objectKey }),
      );
    } catch (err) {
      this.logger.warn(
        `S3 delete failed for ${asset.objectKey}: ${(err as Error).message}`,
      );
    }
    await this.refs.delete({ assetId: id });
    await this.assets.delete(id);
    this.logger.log(`Deleted asset ${id}`);
    return { deleted: id };
  }

  /**
   * Organizations' files stored before fingerprints (or claimed from before keys)
   * get theirs, read back from the bucket one at a time, so a later upload of the
   * same file is found. In the background: start-up doesn't wait for it.
   */
  onApplicationBootstrap() {
    void this.fillFingerprints();
  }

  private filling = false;

  private async fillFingerprints() {
    if (this.filling) return;
    this.filling = true;
    let done = 0;
    try {
      // Only apps with the same-file check (no join: the tables may differ in collation).
      const ids = (await this.clientRows.find({ where: { sameFileCheck: true }, select: { id: true } })).map((c) => c.id);
      for (; ids.length; ) {
        const batch = await this.assets
          .createQueryBuilder("a")
          .where("a.sha256 IS NULL AND a.client_id IN (:...ids)", { ids })
          .orderBy("a.created_at", "ASC")
          .take(50)
          .getMany();
        if (!batch.length) break;
        for (const asset of batch) {
          let sha256 = "-"; // can't be read: marked so it isn't tried again
          try {
            const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucketOf(asset), Key: asset.objectKey }));
            sha256 = await hashStream(res.Body as Readable);
          } catch (err) {
            this.logger.warn(`No fingerprint for ${asset.id}: ${(err as Error).message}`);
          }
          await this.assets.update(asset.id, { sha256 });
          done++;
        }
      }
      if (done) this.logger.log(`Fingerprinted ${done} stored file(s)`);
    } catch (err) {
      this.logger.error(`Fingerprinting stopped: ${(err as Error).message}`);
    } finally {
      this.filling = false;
    }
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
