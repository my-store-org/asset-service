import { Column, CreateDateColumn, Entity, PrimaryColumn } from "typeorm";

/**
 * A bucket made through this service (the asset console). It may be used without being
 * listed in S3_BUCKETS, from the moment it is made.
 */
@Entity("managed_buckets")
export class ManagedBucket {
  @PrimaryColumn({ length: 63 })
  name: string;

  /** A CDN in front of it, if one is set up later; empty = S3's own address. */
  @Column({ name: "public_host", length: 255, default: "" })
  publicHost: string;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;
}
