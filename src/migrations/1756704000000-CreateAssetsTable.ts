import { MigrationInterface, QueryRunner, Table } from "typeorm";

/**
 * The service's only table: one row per stored object.
 *
 * Guarded by hasTable so it is safe to run against a database whose schema
 * was built by `synchronize` before migrations existed — the migration is
 * recorded either way, and later migrations run in order from there.
 */
export class CreateAssetsTable1756704000000 implements MigrationInterface {
  name = "CreateAssetsTable1756704000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable("assets")) return;

    await queryRunner.createTable(
      new Table({
        name: "assets",
        columns: [
          { name: "id", type: "varchar", length: "36", isPrimary: true },
          // Where the object lives in the bucket. Unique so the same key can
          // never be claimed by two rows.
          { name: "object_key", type: "varchar", length: "512", isUnique: true },
          { name: "content_type", type: "varchar", length: "100" },
          { name: "size", type: "int", unsigned: true },
          { name: "original_name", type: "varchar", length: "255", default: "''" },
          { name: "folder", type: "varchar", length: "40", default: "'uploads'" },
          {
            name: "created_at",
            type: "datetime",
            default: "CURRENT_TIMESTAMP",
          },
        ],
        indices: [{ name: "IDX_assets_folder", columnNames: ["folder"] }],
      }),
      true,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable("assets", true);
  }
}
