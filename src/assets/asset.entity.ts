import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

/**
 * The service's own record of every stored object. Callers hold only the id
 * and url — the bucket layout stays private to this service.
 */
@Entity("assets")
export class Asset {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  /**
   * The bucket it is in. One service serves several projects, each with its
   * own bucket; rows from before that are in the default one.
   */
  @Index()
  @Column({ length: 63, default: "" })
  bucket: string;

  /** S3 object key. Never exposed outside this service. */
  @Column({ name: "object_key", length: 512, unique: true })
  objectKey: string;

  @Column({ name: "content_type", length: 100 })
  contentType: string;

  @Column({ type: "int", unsigned: true })
  size: number;

  /** Original filename, kept for the media library listing. */
  @Column({ name: "original_name", length: 255, default: "" })
  originalName: string;

  /** Free-form grouping, e.g. "products" or "categories". */
  @Index()
  @Column({ length: 40, default: "uploads" })
  folder: string;

  /**
   * Who the image belongs to, as an opaque tag the caller chooses —
   * "store:acme" for a shop's own library, "theme:acme:12" for one design's.
   *
   * The folder says what kind of image it is and where it sits in the bucket;
   * this says whose it is. They are different questions: two shops both
   * upload marketing banners, and neither should see the other's when picking
   * one. Listing without a scope still returns everything, which is what the
   * service's own tooling wants — callers that serve a merchant must pass it.
   *
   * Empty on rows written before this existed, so nothing already stored is
   * claimed by a store that may not have uploaded it.
   */
  @Index()
  @Column({ length: 190, default: "" })
  scope: string;

  @Column({ name: "created_at", type: "datetime", default: () => "CURRENT_TIMESTAMP" })
  createdAt: Date;
}
