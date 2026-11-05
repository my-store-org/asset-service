import { MigrationInterface, QueryRunner } from "typeorm";

/** Buckets made through the service (the asset console): allowed without being in S3_BUCKETS. */
export class AddManagedBuckets1762000000400 implements MigrationInterface {
  name = "AddManagedBuckets1762000000400";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS managed_buckets (
         name        VARCHAR(63)  NOT NULL PRIMARY KEY,
         public_host VARCHAR(255) NOT NULL DEFAULT '',
         created_at  DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS managed_buckets`);
  }
}
