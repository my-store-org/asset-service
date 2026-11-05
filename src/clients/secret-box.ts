import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Keeps client secrets encrypted (AES-256-GCM), so the asset console can show one again.
 * The key is SECRETS_KEY, or ADMIN_KEY when that is not set. Changing that key makes
 * stored secrets unreadable (they still work; make a new one to see it again).
 */
export class SecretBox {
  private readonly key: Buffer | null;

  constructor(secretsKey?: string, adminKey?: string) {
    const material = (secretsKey ?? "").trim() || (adminKey ?? "").trim();
    this.key = material ? createHash("sha256").update(`client-secrets:${material}`).digest() : null;
  }

  get enabled() {
    return !!this.key;
  }

  /** "v1:iv:tag:data" (base64 parts), or null when there is no key to encrypt with. */
  seal(secret: string): string | null {
    if (!this.key) return null;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(":");
  }

  /** The secret, or null when it can't be read (no key, another key, or damaged). */
  open(sealed: string): string | null {
    if (!this.key) return null;
    const [v, iv, tag, data] = sealed.split(":");
    if (v !== "v1" || !iv || !tag || !data) return null;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64"));
      decipher.setAuthTag(Buffer.from(tag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
    } catch {
      return null;
    }
  }
}
