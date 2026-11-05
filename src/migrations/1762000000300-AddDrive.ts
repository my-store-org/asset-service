import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * The drive: each organization's own folders (nested) and the files kept in them. A
 * folder's sub-folders and files go with it when it is deleted (ON DELETE CASCADE).
 */
export class AddDrive1762000000300 implements MigrationInterface {
  name = "AddDrive1762000000300";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS drive_folders (
         id         INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
         client_id  VARCHAR(36)  NOT NULL,
         parent_id  INT          NULL,
         name       VARCHAR(255) NOT NULL,
         created_at DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
         updated_at DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
         INDEX IDX_drive_folders_client_parent (client_id, parent_id),
         CONSTRAINT FK_drive_folders_parent FOREIGN KEY (parent_id)
           REFERENCES drive_folders (id) ON DELETE CASCADE
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS drive_files (
         id         INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
         client_id  VARCHAR(36)  NOT NULL,
         folder_id  INT          NULL,
         name       VARCHAR(255) NOT NULL,
         file       JSON         NOT NULL,
         thumb      JSON         NULL,
         created_at DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
         updated_at DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
         INDEX IDX_drive_files_client_folder (client_id, folder_id),
         CONSTRAINT FK_drive_files_folder FOREIGN KEY (folder_id)
           REFERENCES drive_folders (id) ON DELETE CASCADE
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS drive_files`);
    await queryRunner.query(`DROP TABLE IF EXISTS drive_folders`);
  }
}
