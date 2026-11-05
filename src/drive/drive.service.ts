import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, IsNull, Repository } from "typeorm";
import { AssetsService } from "../assets/assets.service";
import type { Client } from "../clients/client.entity";
import type { AddFilesDto, CreateFolderDto, ImportDto, UpdateFileDto, UpdateFolderDto } from "./drive.dto";
import { DriveFile, DriveFolder, type StoredFile } from "./drive.entity";

/** How the drive tells the asset service a file is in use: "drive:<file id>". */
const driveRef = (id: number) => `drive:${id}`;
/** The stored files a drive file uses: the file and its preview. */
const storedIds = (f: Pick<DriveFile, "file" | "thumb">) => [f.file.id, ...(f.thumb ? [f.thumb.id] : [])];

/** As the endpoints return them (without the owner). */
const folderOut = ({ id, name, parentId, createdAt, updatedAt }: DriveFolder) => ({ id, name, parentId, createdAt, updatedAt });
const fileOut = ({ id, folderId, name, file, thumb, createdAt, updatedAt }: DriveFile) => ({
  id,
  folderId,
  name,
  file,
  thumb,
  createdAt,
  updatedAt,
});

/**
 * Each organization's own folders (nested to any depth) and the files kept in them. Only
 * that organization (its key) sees them. A file uses a stored file (and its preview): a
 * copy uses the same one, and it is deleted from storage once nothing uses it.
 */
@Injectable()
export class DriveService {
  private readonly logger = new Logger(DriveService.name);

  constructor(
    @InjectRepository(DriveFolder) private readonly folders: Repository<DriveFolder>,
    @InjectRepository(DriveFile) private readonly files: Repository<DriveFile>,
    private readonly assets: AssetsService,
  ) {}

  /**
   * One folder's contents (the top when [folderId] is left out): its sub-folders, each with
   * how many folders and files it holds, its files (newest first), and the path to it.
   */
  async list(c: Client, folderId?: number) {
    const folder = folderId == null ? null : await this.folder(c, folderId);
    const parent = folder ? folder.id : IsNull();
    const [folders, files, path] = await Promise.all([
      this.folders.find({ where: { clientId: c.id, parentId: parent }, order: { name: "ASC" } }),
      this.files.find({ where: { clientId: c.id, folderId: parent }, order: { createdAt: "DESC", id: "DESC" } }),
      folder ? this.pathTo(c, folder) : [],
    ]);
    const ids = folders.map((f) => f.id);
    const count = async (table: "drive_folders" | "drive_files", column: "parent_id" | "folder_id") =>
      ids.length
        ? new Map<number, number>(
            (
              (await this.folders.query(
                `SELECT ${column} AS id, COUNT(*) AS n FROM ${table} WHERE client_id = ? AND ${column} IN (?) GROUP BY ${column}`,
                [c.id, ids],
              )) as { id: number; n: string }[]
            ).map((r) => [Number(r.id), Number(r.n)]),
          )
        : new Map<number, number>();
    const [subfolders, inside] = await Promise.all([count("drive_folders", "parent_id"), count("drive_files", "folder_id")]);
    return {
      folder: folder ? folderOut(folder) : null,
      path,
      folders: folders.map((f) => ({
        ...folderOut(f),
        folderCount: subfolders.get(f.id) ?? 0,
        fileCount: inside.get(f.id) ?? 0,
      })),
      files: files.map(fileOut),
    };
  }

  /**
   * Folders and files anywhere whose name contains [q] (ignoring case), at most 50 of each,
   * each with the folders from the top down to where it is ([path]; empty at the top).
   */
  async search(c: Client, q: string) {
    const like = `%${q.trim().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    const [folders, files, all] = await Promise.all([
      this.folders
        .createQueryBuilder("f")
        .where("f.client_id = :c AND LOWER(f.name) LIKE LOWER(:like)", { c: c.id, like })
        .orderBy("f.name", "ASC")
        .take(50)
        .getMany(),
      this.files
        .createQueryBuilder("d")
        .where("d.client_id = :c AND LOWER(d.name) LIKE LOWER(:like)", { c: c.id, like })
        .orderBy("d.createdAt", "DESC")
        .take(50)
        .getMany(),
      this.folders.find({ where: { clientId: c.id }, select: { id: true, name: true, parentId: true } }),
    ]);
    const byId = new Map(all.map((f) => [f.id, f]));
    const pathOf = (id: number | null) => {
      const path: { id: number; name: string }[] = [];
      const seen = new Set<number>();
      for (let p = id; p != null && !seen.has(p); ) {
        seen.add(p);
        const f = byId.get(p);
        if (!f) break;
        path.unshift({ id: f.id, name: f.name });
        p = f.parentId;
      }
      return path;
    };
    return {
      folder: null,
      path: [],
      folders: folders.map((f) => ({ ...folderOut(f), path: pathOf(f.parentId) })),
      files: files.map((d) => ({ ...fileOut(d), path: pathOf(d.folderId) })),
    };
  }

  async createFolder(c: Client, { name, parentId }: CreateFolderDto) {
    if (parentId != null) await this.folder(c, parentId);
    await this.checkName(c, name, parentId ?? null);
    const saved = await this.folders.save(this.folders.create({ clientId: c.id, name: name.trim(), parentId: parentId ?? null }));
    return folderOut(saved);
  }

  /** Rename or move a folder. */
  async updateFolder(c: Client, id: number, { name, parentId }: UpdateFolderDto) {
    const folder = await this.folder(c, id);
    if (parentId !== undefined && parentId !== folder.parentId) {
      if (parentId != null) {
        const target = await this.folder(c, parentId);
        // A folder cannot go into itself or into one of its own sub-folders.
        if ((await this.pathTo(c, target)).some((p) => p.id === id)) {
          throw new BadRequestException("Cannot move a folder into itself or one of its sub-folders");
        }
      }
      folder.parentId = parentId;
    }
    if (name !== undefined) folder.name = name.trim();
    await this.checkName(c, folder.name, folder.parentId, folder.id);
    await this.folders.update({ id: folder.id, clientId: c.id }, { name: folder.name, parentId: folder.parentId });
    return folderOut(await this.folder(c, id));
  }

  /** Deletes a folder with everything inside it; stored files nothing else uses are deleted too. */
  async removeFolder(c: Client, id: number) {
    await this.folder(c, id);
    const ids = [id];
    for (let level = [id]; level.length; ) {
      level = (await this.folders.find({ where: { clientId: c.id, parentId: In(level) }, select: { id: true } })).map((f) => f.id);
      ids.push(...level);
    }
    const files = await this.files.find({ where: { clientId: c.id, folderId: In(ids) } });
    // The database removes the sub-folders and files with it (ON DELETE CASCADE).
    await this.folders.delete({ id, clientId: c.id });
    await this.forget(c, files);
    return { folders: ids.length, files: files.length };
  }

  /** Adds stored files (the caller's own) to a folder, named after the uploaded file. */
  async addFiles(c: Client, { folderId, files }: AddFilesDto) {
    if (folderId != null) await this.folder(c, folderId);
    const seen = new Set<string>();
    const unique = files.filter((w) => !seen.has(w.assetId) && seen.add(w.assetId));
    const stored = await Promise.all(
      unique.map(async (w) => ({
        name: w.name,
        file: await this.storedFile(c, w.assetId),
        // A preview that can't be found is left out rather than failing the upload.
        thumb: w.thumbnailId ? await this.storedFile(c, w.thumbnailId).catch(() => null) : null,
      })),
    );
    const saved = await this.files.save(
      stored.map((s) =>
        this.files.create({
          clientId: c.id,
          folderId: folderId ?? null,
          name: (s.name ?? s.file.originalName ?? "file").slice(0, 255) || "file",
          file: s.file,
          thumb: s.thumb,
        }),
      ),
    );
    await this.use(c, saved);
    return saved.map(fileOut);
  }

  /** Rename or move a file. */
  async updateFile(c: Client, id: number, { name, folderId }: UpdateFileDto) {
    const file = await this.file(c, id);
    if (folderId !== undefined) {
      if (folderId != null) await this.folder(c, folderId);
      file.folderId = folderId;
    }
    if (name !== undefined) file.name = name.trim();
    await this.files.update({ id, clientId: c.id }, { name: file.name, folderId: file.folderId });
    return fileOut(await this.file(c, id));
  }

  /** Deletes a file; its stored file too unless something else uses it. */
  async removeFile(c: Client, id: number) {
    const file = await this.file(c, id);
    await this.files.delete({ id, clientId: c.id });
    await this.forget(c, [file]);
  }

  /**
   * Copies a folder and everything inside it (at every level) into [parentId]. Copied
   * files use the same stored files, so storage is not doubled. A name already used there
   * gets "(ចម្លង)" added.
   */
  async copyFolder(c: Client, id: number, parentId: number | null) {
    const source = await this.folder(c, id);
    if (parentId != null) {
      const target = await this.folder(c, parentId);
      if ((await this.pathTo(c, target)).some((p) => p.id === id)) {
        throw new BadRequestException("Cannot copy a folder into itself or one of its sub-folders");
      }
    }
    const copied: DriveFile[] = [];
    const result = await this.folders.manager.transaction(async (m) => {
      const folders = m.getRepository(DriveFolder);
      const files = m.getRepository(DriveFile);
      const top = await folders.save(folders.create({ clientId: c.id, name: await this.freeName(c, source.name, parentId), parentId }));
      // Walk the tree level by level: old folder id -> its copy's id.
      let level = new Map([[source.id, top.id]]);
      let copiedFolders = 1;
      let copiedFiles = 0;
      while (level.size) {
        const next = new Map<number, number>();
        for (const [from, to] of level) {
          const inside = await files.find({ where: { clientId: c.id, folderId: from }, order: { id: "ASC" } });
          if (inside.length) {
            const made = await files.save(
              inside.map((d) => files.create({ clientId: c.id, folderId: to, name: d.name, file: d.file, thumb: d.thumb })),
            );
            copied.push(...made);
            copiedFiles += inside.length;
          }
          for (const sub of await folders.find({ where: { clientId: c.id, parentId: from }, order: { id: "ASC" } })) {
            const copy = await folders.save(folders.create({ clientId: c.id, name: sub.name, parentId: to }));
            next.set(sub.id, copy.id);
            copiedFolders++;
          }
        }
        level = next;
      }
      return { folder: folderOut(top), folders: copiedFolders, files: copiedFiles };
    });
    await this.use(c, copied);
    return result;
  }

  /** Copies a file into [folderId]; the copy uses the same stored file. */
  async copyFile(c: Client, id: number, folderId: number | null) {
    const file = await this.file(c, id);
    if (folderId != null) await this.folder(c, folderId);
    const copy = await this.files.save(
      this.files.create({
        clientId: c.id,
        folderId,
        // A copy in the same folder is told apart by its name.
        name: folderId === file.folderId ? `${file.name} (ចម្លង)`.slice(0, 255) : file.name,
        file: file.file,
        thumb: file.thumb,
      }),
    );
    await this.use(c, [copy]);
    return fileOut(copy);
  }

  /**
   * An app's existing folders and files, moved in once with the same ids (so links and
   * remembered folders still work). Safe to repeat: what is already here is skipped. An id
   * used by another organization is refused.
   */
  async import(c: Client, { folders, files }: ImportDto) {
    const folderIds = folders.map((f) => f.id);
    const fileIds = files.map((f) => f.id);
    const owners = async (table: "drive_folders" | "drive_files", ids: number[]) =>
      ids.length
        ? new Map(
            ((await this.folders.query(`SELECT id, client_id FROM ${table} WHERE id IN (?)`, [ids])) as { id: number; client_id: string }[]).map(
              (r) => [Number(r.id), r.client_id],
            ),
          )
        : new Map<number, string>();
    const [haveFolders, haveFiles] = await Promise.all([owners("drive_folders", folderIds), owners("drive_files", fileIds)]);
    const taken = [...haveFolders, ...haveFiles].filter(([, owner]) => owner !== c.id);
    if (taken.length) throw new ConflictException(`${taken.length} id(s) are already used by another app; nothing was imported`);

    // Parents before children, so each folder's parent exists when it is added.
    const byId = new Map(folders.map((f) => [f.id, f]));
    const ordered: typeof folders = [];
    const placed = new Set<number>(haveFolders.keys());
    const place = (f: (typeof folders)[number], trail = new Set<number>()) => {
      if (placed.has(f.id) || trail.has(f.id)) return;
      trail.add(f.id);
      const parent = f.parentId == null ? undefined : byId.get(f.parentId);
      if (parent) place(parent, trail);
      placed.add(f.id);
      ordered.push(f);
    };
    folders.forEach((f) => place(f));
    const newFiles = files.filter((f) => !haveFiles.has(f.id));

    await this.folders.manager.transaction(async (m) => {
      for (const f of ordered) {
        await m.query(`INSERT INTO drive_folders (id, client_id, parent_id, name, created_at) VALUES (?, ?, ?, ?, ?)`, [
          f.id,
          c.id,
          f.parentId ?? null,
          f.name,
          f.createdAt ? new Date(f.createdAt) : new Date(),
        ]);
      }
      for (const f of newFiles) {
        await m.query(`INSERT INTO drive_files (id, client_id, folder_id, name, file, thumb, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, [
          f.id,
          c.id,
          f.folderId ?? null,
          f.name,
          JSON.stringify(f.file),
          f.thumb ? JSON.stringify(f.thumb) : null,
          f.createdAt ? new Date(f.createdAt) : new Date(),
        ]);
      }
    });
    // Every imported file uses its stored files (added, never taken away).
    const all = await this.files.find({ where: { clientId: c.id, id: In(fileIds.length ? fileIds : [0]) } });
    const { missing } = await this.assets.setRefs(
      c,
      all.map((f) => ({ ref: driveRef(f.id), assetIds: storedIds(f) })),
      "add",
    );
    this.logger.log(`Imported ${ordered.length} folder(s) and ${newFiles.length} file(s) for ${c.name}`);
    return { folders: ordered.length, files: newFiles.length, skipped: folders.length - ordered.length + files.length - newFiles.length, missing: missing.length };
  }

  /** One of the caller's stored files, as a drive file keeps it. */
  private async storedFile(c: Client, assetId: string): Promise<StoredFile> {
    const a = await this.assets.findOne(assetId, c).catch(() => {
      throw new BadRequestException(`File ${assetId} is not one of your uploads`);
    });
    return { id: a.id, url: a.url, contentType: a.contentType, size: a.size, originalName: a.originalName };
  }

  private async folder(c: Client, id: number) {
    const folder = await this.folders.findOne({ where: { id, clientId: c.id } });
    if (!folder) throw new NotFoundException(`Folder ${id} not found`);
    return folder;
  }

  private async file(c: Client, id: number) {
    const file = await this.files.findOne({ where: { id, clientId: c.id } });
    if (!file) throw new NotFoundException(`Document ${id} not found`);
    return file;
  }

  /** The folders from the top down to [folder], itself included. */
  private async pathTo(c: Client, folder: DriveFolder) {
    const path = [{ id: folder.id, name: folder.name }];
    const seen = new Set([folder.id]);
    for (let p = folder.parentId; p != null && !seen.has(p); ) {
      seen.add(p);
      const up = await this.folders.findOne({ where: { id: p, clientId: c.id } });
      if (!up) break;
      path.unshift({ id: up.id, name: up.name });
      p = up.parentId;
    }
    return path;
  }

  /** [name], or "name (ចម្លង)", "name (ចម្លង 2)"… when a folder there already has it. */
  private async freeName(c: Client, name: string, parentId: number | null) {
    for (let n = 1; ; n++) {
      const candidate = n === 1 ? name : `${name} (ចម្លង${n > 2 ? ` ${n - 1}` : ""})`.slice(0, 255);
      try {
        await this.checkName(c, candidate, parentId);
        return candidate;
      } catch (err) {
        if (!(err instanceof ConflictException)) throw err;
      }
    }
  }

  /** Two folders in the same place may not share a name (ignoring case). */
  private async checkName(c: Client, name: string, parentId: number | null, except?: number) {
    const same = await this.folders
      .createQueryBuilder("f")
      .where("f.client_id = :c AND LOWER(f.name) = LOWER(:name)", { c: c.id, name: name.trim() })
      .andWhere(parentId == null ? "f.parent_id IS NULL" : "f.parent_id = :parentId", { parentId })
      .andWhere(except == null ? "1=1" : "f.id <> :except", { except })
      .getCount();
    if (same) throw new ConflictException(`A folder named "${name.trim()}" is already here`);
  }

  /** These files use their stored files (copies share them). */
  private async use(c: Client, files: DriveFile[]) {
    if (!files.length) return;
    await this.assets.setRefs(c, files.map((f) => ({ ref: driveRef(f.id), assetIds: storedIds(f) })), "set");
  }

  /** These files are gone: their stored files are deleted unless something else uses them. */
  private async forget(c: Client, files: DriveFile[]) {
    if (!files.length) return;
    await this.assets.setRefs(c, files.map((f) => ({ ref: driveRef(f.id), assetIds: [] })), "set");
  }
}
