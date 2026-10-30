import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from "typeorm";

/**
 * Which bucket each asset is in.
 *
 * The service now serves several projects, each with its own bucket. Every
 * row written before this was in the one bucket there was, so it is filled in
 * with that one (S3_BUCKET as configured now, else my-store-dev-bucket):
 * nothing already stored moves, and its url stays the same.
 */
export class AddAssetBucket1761800000000 implements MigrationInterface {
  name = "AddAssetBucket1761800000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable("assets");
    if (!table || table.findColumnByName("bucket")) return;

    await queryRunner.addColumn(
      "assets",
      new TableColumn({ name: "bucket", type: "varchar", length: "63", default: "''" }),
    );
    const current = (process.env.S3_BUCKET ?? "").trim() || "my-store-dev-bucket";
    await queryRunner.query("UPDATE `assets` SET `bucket` = ? WHERE `bucket` = ''", [current]);
    await queryRunner.createIndex("assets", new TableIndex({ name: "IDX_assets_bucket", columnNames: ["bucket"] }));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable("assets");
    if (!table?.findColumnByName("bucket")) return;
    await queryRunner.dropIndex("assets", "IDX_assets_bucket");
    await queryRunner.dropColumn("assets", "bucket");
  }
}
