import { MigrationInterface, QueryRunner, TableColumn } from "typeorm";

/** The same-file check can be off for an app that doesn't say which files it uses (My Store). */
export class AddClientSameFileCheck1762000000200 implements MigrationInterface {
  name = "AddClientSameFileCheck1762000000200";

  public async up(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable("clients");
    if (!table || table.findColumnByName("same_file_check")) return;
    await queryRunner.addColumn(
      "clients",
      new TableColumn({ name: "same_file_check", type: "tinyint", default: 1 }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable("clients");
    if (table?.findColumnByName("same_file_check")) await queryRunner.dropColumn("clients", "same_file_check");
  }
}
