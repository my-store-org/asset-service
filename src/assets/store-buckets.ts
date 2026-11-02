import { Logger } from "@nestjs/common";

/**
 * A store's own bucket (one store, one bucket), found by the scope a file is
 * uploaded with: `store:<slug>` or `theme:<slug>:<id>` are that store's.
 *
 * The API knows which bucket each store has; this asks it
 * (GET <STORE_BUCKETS_URL>/platform/storage/stores/<slug>) and remembers the
 * answer. No answer — no store bucket, the API down, STORE_BUCKETS_URL unset —
 * means the default bucket, as before, so an upload never fails over it.
 */
export class StoreBuckets {
  private readonly logger = new Logger(StoreBuckets.name);
  private readonly cache = new Map<string, { bucket: string | null; until: number }>();

  constructor(private readonly apiUrl: string | undefined) {}

  /** The store a scope belongs to, if any (its slug). */
  static slugOf(scope: string | undefined | null): string | null {
    const m = /^(?:store|theme):([a-z0-9-]{1,63})(?::|$)/.exec(scope ?? "");
    return m ? m[1] : null;
  }

  get enabled() {
    return !!this.apiUrl?.trim();
  }

  /** The bucket for a scope's files: its store's own, or null for the default. */
  async forScope(scope: string | undefined | null): Promise<string | null> {
    const slug = StoreBuckets.slugOf(scope);
    if (!slug || !this.enabled) return null;
    const hit = this.cache.get(slug);
    if (hit && hit.until > Date.now()) return hit.bucket;

    let bucket: string | null = null;
    try {
      const res = await fetch(`${this.apiUrl!.replace(/\/+$/, "")}/platform/storage/stores/${slug}`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) throw new Error(`API answered ${res.status}`);
      bucket = ((await res.json()) as { bucket?: string | null }).bucket ?? null;
    } catch (err) {
      this.logger.warn(`Bucket of ${slug} unknown (${(err as Error).message}); using the default`);
      // Try again soon: the store's own bucket is wanted once the API answers.
      this.cache.set(slug, { bucket: null, until: Date.now() + 30_000 });
      return hit?.bucket ?? null;
    }
    // A bucket never changes once made; none yet may be made any moment.
    this.cache.set(slug, { bucket, until: Date.now() + (bucket ? 3_600_000 : 30_000) });
    return bucket;
  }
}
