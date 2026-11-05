import { BadRequestException } from "@nestjs/common";

/** The bucket used when a caller names none, and when S3_BUCKET is not set. */
export const FALLBACK_BUCKET = "my-store-dev-bucket";

/** S3's own rule for a bucket name: 3–63 of a-z, 0-9, dot and dash. */
const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/**
 * A store's own bucket, as the API names it: `<store>-my-store-assets-<id>`.
 * Always allowed, without listing each one in S3_BUCKETS — a new store gets
 * one every time.
 */
export const STORE_BUCKET = /^(?:[a-z0-9-]+-)?my-store-assets-\d+$/;

/**
 * Which buckets this service may write to, and the public host of each.
 *
 * One service, several projects: each caller may name its own bucket on a
 * request. Only the default (S3_BUCKET) and those listed in S3_BUCKETS are
 * accepted — otherwise anyone who can reach the service could make it write
 * to any bucket its AWS keys open. S3_BUCKETS is a comma list of
 * `name` or `name=public-host` (a CDN in front of that bucket); `*` accepts any
 * bucket, for a service whose keys are already limited to the right ones.
 *
 * Urls: the default bucket's host is S3_PUBLIC_HOST (its CloudFront); another
 * bucket's is the host listed with it, else S3's own address for it.
 */
export class Buckets {
  readonly default: string;
  private readonly hosts = new Map<string, string>();
  /** Buckets made through the service (managed_buckets), allowed like those in S3_BUCKETS. */
  private readonly made = new Set<string>();
  private readonly any: boolean;
  private readonly region: string;

  constructor(env: { bucket?: string; buckets?: string; publicHost?: string; region: string }) {
    this.region = env.region;
    this.default = (env.bucket ?? "").trim() || FALLBACK_BUCKET;
    if (env.publicHost?.trim()) this.hosts.set(this.default, env.publicHost.trim());
    const listed = (env.buckets ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    this.any = listed.includes("*");
    for (const entry of listed) {
      if (entry === "*") continue;
      const [name, host] = entry.split("=").map((x) => x.trim());
      if (!BUCKET_NAME.test(name)) throw new Error(`S3_BUCKETS: "${name}" is not a bucket name`);
      // The default bucket keeps S3_PUBLIC_HOST unless a host is listed for it here.
      if (host) this.hosts.set(name, host);
      else if (!this.hosts.has(name)) this.hosts.set(name, "");
    }
    if (!this.hosts.has(this.default)) this.hosts.set(this.default, "");
  }

  /** The bucket for a request: the default when none is named; refused when it is not allowed. */
  pick(name?: string | null): string {
    const wanted = (name ?? "").trim();
    if (!wanted) return this.default;
    if (!BUCKET_NAME.test(wanted)) throw new BadRequestException(`"${wanted}" is not a bucket name`);
    if (!this.any && !this.hosts.has(wanted) && !STORE_BUCKET.test(wanted)) throw new BadRequestException(`Bucket "${wanted}" is not one this service writes to`);
    return wanted;
  }

  /** The public host files in a bucket are served from. */
  host(bucket: string): string {
    return this.hosts.get(bucket) || `${bucket}.s3.${this.region}.amazonaws.com`;
  }

  /** Which bucket a public url belongs to (by its host), if it is one of ours. */
  fromHost(host: string): string | null {
    for (const [name] of this.hosts) if (this.host(name) === host) return name;
    // S3's own address of a bucket we may use (with "*", any of them).
    const m = /^([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])\.s3[.-][a-z0-9-]*\.?amazonaws\.com$/.exec(host);
    if (m && (this.any || this.hosts.has(m[1]) || STORE_BUCKET.test(m[1]))) return m[1];
    return null;
  }

  /** Allows a bucket made through the service (from then on, like one in S3_BUCKETS). */
  add(name: string, host = "") {
    if (!this.hosts.has(name)) this.hosts.set(name, host);
    else if (host) this.hosts.set(name, host);
    if (name !== this.default) this.made.add(name);
  }

  /** Whether this name is already one of the service's buckets (set up, or made here). */
  knows(name: string) {
    return this.hosts.has(name);
  }

  /** The buckets named in configuration, and those made through the service. */
  list() {
    return {
      default: this.default,
      others: [...this.hosts.keys()].filter((b) => b !== this.default && !this.made.has(b)),
      made: [...this.made],
      any: this.any,
    };
  }
}
