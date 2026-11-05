import { MigrationInterface, QueryRunner, TableColumn } from "typeorm";

/** Each client's secret, encrypted, so the asset console can show it again. Null for older ones. */
export class AddClientSecretEnc1762000000500 implements MigrationInterface {
  name = "AddClientSecretEnc1762000000500";

  public async up(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable("clients");
    if (!table || table.findColumnByName("secret_enc")) return;
    await queryRunner.addColumn("clients", new TableColumn({ name: "secret_enc", type: "varchar", length: "512", isNullable: true }));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable("clients");
    if (table?.findColumnByName("secret_enc")) await queryRunner.dropColumn("clients", "secret_enc");
  }
}
