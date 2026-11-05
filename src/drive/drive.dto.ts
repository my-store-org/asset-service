import { ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from "class-validator";

export class ListDriveQuery {
  @ApiPropertyOptional({ description: "Folder to open; left out for the top." })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  folderId?: number;

  @ApiPropertyOptional({
    description: "Part of a name (ignoring case): matching folders and files from every folder, each with its path.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}

export class CreateFolderDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  /** Folder to make it in; null or left out for the top. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  parentId?: number | null;
}

export class UpdateFolderDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name?: string;

  /** Move into this folder; null for the top. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  parentId?: number | null;
}

export class NewDriveFileDto {
  /** A stored file of the caller (POST /assets). */
  @IsUUID("all")
  assetId: string;

  /** Its small preview picture, if the app made one. */
  @IsOptional()
  @IsUUID("all")
  thumbnailId?: string;

  /** Its name; the uploaded file's name when left out. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name?: string;
}

export class AddFilesDto {
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  folderId?: number | null;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => NewDriveFileDto)
  files: NewDriveFileDto[];
}

export class UpdateFileDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name?: string;

  /** Move into this folder; null for the top. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  folderId?: number | null;
}

/** Where a copy goes (null = the top). */
export class CopyToDto {
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  folderId?: number | null;
}

export class ImportFolderDto {
  @IsInt()
  id: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  parentId: number | null;

  @IsOptional()
  @IsDateString()
  createdAt?: string;
}

export class ImportFileDto {
  @IsInt()
  id: number;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  folderId: number | null;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @IsObject()
  file: { id: string; url: string; contentType: string; size: number; originalName: string };

  @IsOptional()
  @IsObject()
  thumb?: { id: string; url: string; contentType: string; size: number; originalName: string } | null;

  @IsOptional()
  @IsDateString()
  createdAt?: string;
}

/** An app's existing folders and files, moved in once with the same ids. */
export class ImportDto {
  @IsArray()
  @ArrayMaxSize(20000)
  @ValidateNested({ each: true })
  @Type(() => ImportFolderDto)
  folders: ImportFolderDto[];

  @IsArray()
  @ArrayMaxSize(100000)
  @ValidateNested({ each: true })
  @Type(() => ImportFileDto)
  files: ImportFileDto[];
}
