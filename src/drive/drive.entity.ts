import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

/** What a drive file keeps about its stored file (as the asset endpoints return it). */
export type StoredFile = {
  id: string;
  url: string;
  contentType: string;
  size: number;
  originalName: string;
};

/** A folder in an organization's drive; [parentId] is the folder it is in, null at the top. */
@Entity("drive_folders")
export class DriveFolder {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: "client_id", length: 36, select: false })
  clientId: string;

  @Column({ length: 255 })
  name: string;

  @Column({ name: "parent_id", type: "int", nullable: true })
  parentId: number | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}

/** A file kept in a folder (or at the top when [folderId] is null). */
@Entity("drive_files")
export class DriveFile {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: "client_id", length: 36, select: false })
  clientId: string;

  @Column({ name: "folder_id", type: "int", nullable: true })
  folderId: number | null;

  @Column({ length: 255 })
  name: string;

  @Column({ type: "json" })
  file: StoredFile;

  /** Small preview picture of a photo or video, if there is one. */
  @Column({ type: "json", nullable: true })
  thumb: StoredFile | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
