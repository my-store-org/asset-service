import {
  BadRequestException,
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
   * [claimExisting]: files already in its bucket that belong to nobody become its own,
   * e.g. everything the loan app stored before it had a key. Not allowed for the
   * default bucket, which other apps share.
   */
  async create(name: string, bucketName: string, claimExisting = false) {
    const bucket = this.assets.checkBucket(bucketName);
    if (claimExisting && bucket === this.assets.defaultBucket) {
      throw new BadRequestException(
        "The default bucket is shared by other apps, so its files can't be claimed by one",
      );
    }
    const secret = this.newSecret();
    const client = await this.clients.save(
      this.clients.create({
        name: name.trim(),
        clientKey: `ck_${randomBytes(12).toString("hex")}`,
        secretHash: sha256(secret),
        bucket,
      }),
    );
    const claimed = claimExisting ? await this.assets.claimUnowned(bucket, client.id) : 0;
    this.logger.log(`Client "${client.name}" made for ${bucket}${claimed ? `, claimed ${claimed} file(s)` : ""}`);
    return { ...this.present(client), clientSecret: secret, claimed };
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

  async setActive(id: string, active: boolean) {
    const client = await this.find(id);
    client.active = active;
    return this.present(await this.clients.save(client));
  }

  /** The client a key and secret belong to; refused when either is wrong or it is turned off. */
  async authenticate(clientKey: string, secret: string): Promise<Client> {
    const client = await this.clients.findOne({ where: { clientKey } });
    const given = Buffer.from(sha256(secret), "hex");
    const ok =
      !!client &&
      timingSafeEqual(given, Buffer.from(client.secretHash, "hex")) &&
      client.active;
    if (!ok) throw new UnauthorizedException("Wrong client key or secret, or the client is turned off");
    return client!;
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
      active: c.active,
      createdAt: c.createdAt,
    };
  }
}
