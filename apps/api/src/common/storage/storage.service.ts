import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import type { ReadStream } from 'node:fs';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppLogger } from '../logging/app-logger';

/**
 * Where uploaded files live.
 *
 * One interface, a local-disk driver today, and room for S3/MinIO later without any caller
 * changing (`PROJECT_SPEC.md` §126). Callers deal in opaque **storage refs**, never paths — a ref
 * is meaningless outside this service, which is what lets the backing store change.
 *
 * Two rules this enforces rather than documents (§179):
 *
 *  1. **The stored name is generated.** The uploader's filename is metadata, never a path
 *     component, so `../../etc/passwd` and `shell.php` are both just strings in a database column.
 *  2. **Nothing escapes the root.** Every resolved path is checked against the root before use, so
 *     even a ref that has been tampered with cannot read outside the upload directory.
 *
 * The root itself must sit outside anything the API serves. Nothing in this application serves
 * static files at all, and nothing should start.
 */

export interface StoredFile {
  /** Opaque handle. Persist this; never build a path from it yourself. */
  ref: string;
  sizeBytes: number;
  /** SHA-256 of the contents, for duplicate detection. */
  checksum: string;
}

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new AppLogger(StorageService.name);
  private root!: string;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    this.root = resolve(this.config.getOrThrow<string>('storage.localPath'));
    await mkdir(this.root, { recursive: true });
    this.logger.log('Storage ready', { driver: this.config.get('storage.driver') });
  }

  /**
   * Whether storage can actually be written to.
   *
   * Writes and deletes a probe file rather than checking that the directory exists. A mounted
   * volume that has gone read-only, or filled up, still has a directory — and a health check that
   * only stats a path reports HEALTHY right up until an upload fails.
   */
  async healthy(): Promise<boolean> {
    try {
      const probe = join(this.root, `.health-${process.pid}`);
      await writeFile(probe, 'ok');
      await rm(probe, { force: true });
      return true;
    } catch (error) {
      this.logger.warn('Storage is not writable', { error: (error as Error).message });
      return false;
    }
  }

  /**
   * Writes bytes and returns a ref.
   *
   * The ref is `<yyyy>/<mm>/<random>.<ext>` — dated so a directory never grows unbounded, random so
   * two uploads of the same filename cannot collide or overwrite each other. The extension is taken
   * from the *validated* filename purely so the file is recognisable on disk during debugging;
   * nothing reads it back.
   */
  async put(bytes: Buffer, originalFilename: string): Promise<StoredFile> {
    const now = new Date();
    const dir = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const extension = extname(originalFilename).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 12);
    const ref = `${dir}/${randomBytes(16).toString('hex')}${extension}`;

    const target = this.pathFor(ref);
    await mkdir(join(this.root, dir), { recursive: true });
    await writeFile(target, bytes, { mode: 0o640 });

    return {
      ref,
      sizeBytes: bytes.byteLength,
      checksum: createHash('sha256').update(bytes).digest('hex'),
    };
  }

  /** Streams a stored file. Callers must have already checked the requester may have it. */
  read(ref: string): ReadStream {
    return createReadStream(this.pathFor(ref));
  }

  async exists(ref: string): Promise<boolean> {
    try {
      await stat(this.pathFor(ref));
      return true;
    } catch {
      return false;
    }
  }

  /** Removes a stored file. A missing file is not an error — deletion is meant to be idempotent. */
  async delete(ref: string): Promise<void> {
    await rm(this.pathFor(ref), { force: true });
  }

  /**
   * Resolves a ref to an absolute path, refusing anything outside the root.
   *
   * The containment check is the important line. A ref reaches here from a database column, and a
   * database column is only as trustworthy as everything that has ever written to it.
   */
  private pathFor(ref: string): string {
    const target = resolve(this.root, ref);
    if (target !== this.root && !target.startsWith(this.root + sep)) {
      throw new Error('Storage reference resolves outside the storage root');
    }
    return target;
  }
}
