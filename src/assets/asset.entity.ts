import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

/**
 * The service's own record of every stored object. Callers hold only the id
 * and url — the bucket layout stays private to this service.
 */
@Entity("assets")
export class Asset {
  @PrimaryGeneratedColumn("uuid")
  id: string;

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

  @Column({ name: "created_at", type: "datetime", default: () => "CURRENT_TIMESTAMP" })
  createdAt: Date;
}
