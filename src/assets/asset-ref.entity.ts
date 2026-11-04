import { Column, Entity, Index, PrimaryColumn } from "typeorm";

/**
 * "This file is used by <ref>", where ref is the caller's own name for the thing
 * using it, e.g. "loan:13" or "doc:55". A client's file is deleted once its last
 * ref is gone, so a file shared by several records (the same photo uploaded twice,
 * or a copied document) stays until none of them use it.
 */
@Entity("asset_refs")
@Index("IDX_asset_refs_client_ref", ["clientId", "ref"])
export class AssetRef {
  @PrimaryColumn({ name: "asset_id", length: 36 })
  assetId: string;

  @PrimaryColumn({ length: 190 })
  ref: string;

  @Column({ name: "client_id", length: 36 })
  clientId: string;
}
