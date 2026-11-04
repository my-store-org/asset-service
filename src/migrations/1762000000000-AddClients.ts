import { MigrationInterface, QueryRunner, Table, TableColumn, TableIndex } from "typeorm";

/**
 * Organizations with their own key and secret, and what goes with them:
 * - clients: one row per organization (app);
 * - assets.client_id: whose file it is (empty on files stored without a key);
 * - assets.sha256: the file's fingerprint, so the same file isn't stored twice;
 * - asset_refs: what uses each file, so it is deleted only once nothing does.
 */
export class AddClients1762000000000 implements MigrationInterface {
  name = "AddClients1762000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable("clients"))) {
      await queryRunner.createTable(
        new Table({
          name: "clients",
          columns: [
            { name: "id", type: "varchar", length: "36", isPrimary: true },
            { name: "name", type: "varchar", length: "120" },
            { name: "client_key", type: "varchar", length: "64", isUnique: true },
            { name: "secret_hash", type: "varchar", length: "64" },
            { name: "bucket", type: "varchar", length: "63" },
            { name: "active", type: "tinyint", default: 1 },
            { name: "created_at", type: "datetime", default: "CURRENT_TIMESTAMP" },
          ],
        }),
        true,
      );
    }

    const assets = await queryRunner.getTable("assets");
    if (assets && !assets.findColumnByName("client_id")) {
      await queryRunner.addColumns("assets", [
        new TableColumn({ name: "client_id", type: "varchar", length: "36", isNullable: true }),
        new TableColumn({ name: "sha256", type: "char", length: "64", isNullable: true }),
      ]);
      await queryRunner.createIndex(
        "assets",
        new TableIndex({ name: "IDX_assets_client_sha", columnNames: ["client_id", "sha256"] }),
      );
    }

    if (!(await queryRunner.hasTable("asset_refs"))) {
      await queryRunner.createTable(
        new Table({
          name: "asset_refs",
          columns: [
            { name: "asset_id", type: "varchar", length: "36", isPrimary: true },
            { name: "ref", type: "varchar", length: "190", isPrimary: true },
            { name: "client_id", type: "varchar", length: "36" },
          ],
          indices: [{ name: "IDX_asset_refs_client_ref", columnNames: ["client_id", "ref"] }],
        }),
        true,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable("asset_refs", true);
    const assets = await queryRunner.getTable("assets");
    if (assets?.findColumnByName("client_id")) {
      await queryRunner.dropIndex("assets", "IDX_assets_client_sha");
      await queryRunner.dropColumn("assets", "sha256");
      await queryRunner.dropColumn("assets", "client_id");
    }
    await queryRunner.dropTable("clients", true);
  }
}
