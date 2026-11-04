import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Repository } from "typeorm";
import { AssetsService } from "../assets/assets.service";
import { Client } from "./client.entity";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Organizations and their keys. */
@Injectable()
export class ClientsService {
  private readonly logger = new Logger(ClientsService.name);

  constructor(
    @InjectRepository(Client) private readonly clients: Repository<Client>,
    private readonly assets: AssetsService,
  ) {}

  /**
   * Makes an organization with a new key and secret. The secret is only in this
   * answer; keep it, it can't be shown again (make a new one with rotateSecret).
   *
   * [bucket] is where its files go; [buckets] other buckets that are its own;
   * [storeBuckets] (My Store) every store's own bucket too. A bucket can belong to only
   * one organization, and once it does, no one without that key can write to it.
   *
   * Its old files (already in those buckets, belonging to no one) become its own,
   * unless [claimExisting] is false; any left over also become its own as it uses them.
   */
  async create(opts: { name: string; bucket: string; buckets?: string[]; storeBuckets?: boolean; sameFileCheck?: boolean; claimExisting?: boolean; active?: boolean }) {
    const client = this.clients.create({
      name: opts.name.trim(),
      active: opts.active ?? true,
      sameFileCheck: opts.sameFileCheck ?? true,
      clientKey: `ck_${randomBytes(12).toString("hex")}`,
      ...(await this.checkBuckets(opts.bucket, opts.buckets ?? [], opts.storeBuckets ?? false)),
    });
    const secret = this.newSecret();
    client.secretHash = sha256(secret);
    await this.clients.save(client);
    this.assets.forgetOwners();
    // Made turned off (to set its key in the app first): it owns nothing until turned on.
    const claimed = !client.active || opts.claimExisting === false ? 0 : await this.assets.claimUnowned(client);
    this.logger.log(`Client "${client.name}" made for ${[client.bucket, ...client.buckets].join(", ")}${client.storeBuckets ? " and store buckets" : ""}; ${claimed} old file(s) claimed`);
    return { ...this.present(client), clientSecret: secret, claimed };
  }

  /** Turns a key on or off, or changes its buckets (old files in new ones become its own). */
  async update(id: string, opts: { active?: boolean; bucket?: string; buckets?: string[]; storeBuckets?: boolean; sameFileCheck?: boolean; claimExisting?: boolean }) {
    const client = await this.find(id);
    const turningOn = opts.active === true && !client.active;
    if (opts.active !== undefined) client.active = opts.active;
    if (opts.sameFileCheck !== undefined) client.sameFileCheck = opts.sameFileCheck;
    if (turningOn || opts.bucket !== undefined || opts.buckets !== undefined || opts.storeBuckets !== undefined) {
      Object.assign(
        client,
        await this.checkBuckets(opts.bucket ?? client.bucket, opts.buckets ?? client.buckets, opts.storeBuckets ?? client.storeBuckets, client.id),
      );
    }
    await this.clients.save(client);
    this.assets.forgetOwners();
    const claimed = client.active && opts.claimExisting !== false ? await this.assets.claimUnowned(client) : 0;
    return { ...this.present(client), claimed };
  }

  /** Old files in its buckets that belong to no one become its own (again, e.g. after a gap). */
  async claim(id: string) {
    const client = await this.find(id);
    return { claimed: await this.assets.claimUnowned(client) };
  }

  /** Checks the buckets are allowed and not another organization's. */
  private async checkBuckets(bucket: string, extra: string[], storeBuckets: boolean, self?: string) {
    const main = this.assets.checkBucket(bucket);
    const others = [...new Set(extra.map((b) => this.assets.checkBucket(b)))].filter((b) => b !== main);
    const taken = (await this.clients.find({ where: { active: true } })).filter((c) => c.id !== self);
    for (const b of [main, ...others]) {
      const owner = taken.find((c) => this.assets.owns(c, b));
      if (owner) throw new ConflictException(`Bucket "${b}" already belongs to ${owner.name}`);
    }
    if (storeBuckets) {
      const owner = taken.find((c) => c.storeBuckets);
      if (owner) throw new ConflictException(`Store buckets already belong to ${owner.name}`);
    }
    return { bucket: main, buckets: others, storeBuckets };
  }

  async list() {
    const rows = await this.clients.find({ order: { createdAt: "ASC" } });
    return rows.map((c) => this.present(c));
  }

  /** A new secret; the old one stops working at once. */
  async rotateSecret(id: string) {
    const client = await this.find(id);
    const secret = this.newSecret();
    client.secretHash = sha256(secret);
    await this.clients.save(client);
    return { ...this.present(client), clientSecret: secret };
  }

  /**
   * The client a key and secret belong to; refused when either is wrong. A client that
   * is turned off gives null: its key works like no key (it owns nothing while off), so
   * an app can be given its key before it is turned on, without a gap.
   */
  async authenticate(clientKey: string, secret: string): Promise<Client | null> {
    const client = await this.clients.findOne({ where: { clientKey } });
    const given = Buffer.from(sha256(secret), "hex");
    const ok = !!client && timingSafeEqual(given, Buffer.from(client.secretHash, "hex"));
    if (!ok) throw new UnauthorizedException("Wrong client key or secret");
    return client!.active ? client! : null;
  }

  private async find(id: string) {
    const client = await this.clients.findOne({ where: { id } });
    if (!client) throw new NotFoundException(`Client ${id} not found`);
    return client;
  }

  private newSecret() {
    return `sk_${randomBytes(24).toString("hex")}`;
  }

  private present(c: Client) {
    return {
      id: c.id,
      name: c.name,
      clientKey: c.clientKey,
      bucket: c.bucket,
      buckets: c.buckets ?? [],
      storeBuckets: c.storeBuckets,
      sameFileCheck: c.sameFileCheck,
      active: c.active,
      createdAt: c.createdAt,
    };
  }
}
