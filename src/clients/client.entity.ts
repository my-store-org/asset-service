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

  /** Where its files are stored; it can't name another bucket. */
  @Column({ length: 63 })
  bucket: string;

  /** A turned-off client is refused. */
  @Column({ default: true })
  active: boolean;

  @Column({ name: "created_at", type: "datetime", default: () => "CURRENT_TIMESTAMP" })
  createdAt: Date;
}
