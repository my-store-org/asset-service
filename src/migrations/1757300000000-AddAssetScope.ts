import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from "typeorm";

/**
 * Ownership for stored images.
 *
 * Until now the only grouping was `folder`, one of six global buckets, so the
 * admin's media library showed every shop every other shop's uploads. Scope
 * is the tag that says whose an image is; the listing endpoint filters on it.
 *
 * Existing rows are left empty rather than assigned to a store: the service
 * cannot know who uploaded them, and guessing would hand one merchant's
 * pictures to another.
 */
export class AddAssetScope1757300000000 implements MigrationInterface {
  name = "AddAssetScope1757300000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable("assets");
    if (!table || table.findColumnByName("scope")) return;

    await queryRunner.addColumn(
      "assets",
      new TableColumn({
        name: "scope",
        type: "varchar",
        length: "190",
        default: "''",
      }),
    );
    await queryRunner.createIndex(
      "assets",
      new TableIndex({ name: "IDX_assets_scope", columnNames: ["scope"] }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable("assets");
    if (!table?.findColumnByName("scope")) return;
    await queryRunner.dropIndex("assets", "IDX_assets_scope");
    await queryRunner.dropColumn("assets", "scope");
  }
}
