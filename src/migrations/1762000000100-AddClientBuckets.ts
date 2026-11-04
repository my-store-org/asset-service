import { MigrationInterface, QueryRunner, TableColumn } from "typeorm";

/** An organization can own several buckets, and (My Store) every store's own bucket. */
export class AddClientBuckets1762000000100 implements MigrationInterface {
  name = "AddClientBuckets1762000000100";

  public async up(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable("clients");
    if (!table || table.findColumnByName("buckets")) return;
    await queryRunner.addColumns("clients", [
      new TableColumn({ name: "buckets", type: "varchar", length: "1000", default: "''" }),
      new TableColumn({ name: "store_buckets", type: "tinyint", default: 0 }),
    ]);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable("clients");
    if (!table?.findColumnByName("buckets")) return;
    await queryRunner.dropColumn("clients", "store_buckets");
    await queryRunner.dropColumn("clients", "buckets");
  }
}
