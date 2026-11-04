import { Column, Entity, PrimaryGeneratedColumn } from "typeorm";

/**
 * One organization (app) that calls this service with its own key and secret,
 * e.g. "Sambath Loan" or "My Store". Its files are its own: other callers can't
 * see, list, copy or delete them.
 */
@Entity("clients")
export class Client {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ length: 120 })
  name: string;

  /** Public half, sent as `x-client-key`, e.g. "ck_3f9a…". */
  @Column({ name: "client_key", length: 64, unique: true })
  clientKey: string;

  /** SHA-256 of the secret. The secret itself is shown once, when made, and never kept. */
  @Column({ name: "secret_hash", length: 64 })
  secretHash: string;

  /** Where its files go when it names no other bucket of its own. */
  @Column({ length: 63 })
  bucket: string;

  /** Other buckets that are its own, e.g. another project's (comma list in the database). */
  @Column({
    type: "varchar",
    length: 1000,
    default: "",
    transformer: {
      to: (list?: string[]) => (list ?? []).join(","),
      from: (v?: string | string[] | null) =>
        Array.isArray(v) ? v : (v ?? "").split(",").filter(Boolean),
    },
  })
  buckets: string[];

  /**
   * It also owns every store's own bucket (`<store>-my-store-assets-<id>`), and a file
   * uploaded for a store goes to that store's bucket. For My Store.
   */
  @Column({ name: "store_buckets", default: false })
  storeBuckets: boolean;

  /**
   * The same file uploaded again comes back as the stored one (stored once). Only for
   * an app that says which of its records use each file (PUT /refs): otherwise deleting
   * one record's copy would take it from the others. On for Sambath Loan, off for My Store.
   */
  @Column({ name: "same_file_check", default: true })
  sameFileCheck: boolean;

  /** A turned-off client is refused. */
  @Column({ default: true })
  active: boolean;

  @Column({ name: "created_at", type: "datetime", default: () => "CURRENT_TIMESTAMP" })
  createdAt: Date;
}

/** Every bucket [client] owns by name (not counting store buckets). */
export const namedBuckets = (client: Client) => [
  ...new Set([client.bucket, ...(client.buckets ?? [])].filter(Boolean)),
];
