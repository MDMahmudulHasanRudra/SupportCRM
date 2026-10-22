import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { DraftDto, ReleaseDto, ReleaseUpdateDto, SavedReplyDto } from './workspace.dto';

@Injectable()
export class WorkspaceService {
  constructor(private readonly db: DataSource) {}

  async overview(userId: string) {
    const [summary] = await this.db.query(`SELECT
      COUNT(*) FILTER (WHERE status NOT IN ('RESOLVED','CLOSED'))::int AS open,
      COUNT(*) FILTER (WHERE "assignedToUserId"=$1 AND status NOT IN ('RESOLVED','CLOSED'))::int AS mine,
      COUNT(*) FILTER (WHERE "assignedToUserId" IS NULL AND "assignedToTeamId" IS NULL AND status NOT IN ('RESOLVED','CLOSED'))::int AS unassigned,
      COUNT(*) FILTER (WHERE status='WAITING_FOR_HUMAN')::int AS "waitingForHuman"
      FROM conversations`, [userId]);
    return summary;
  }
  async notifications(userId: string) {
    const items = await this.db.query('SELECT * FROM workspace_notifications WHERE "userId"=$1 ORDER BY "createdAt" DESC LIMIT 100', [userId]);
    const [count] = await this.db.query<Array<{ unread: number }>>('SELECT COUNT(*)::int AS unread FROM workspace_notifications WHERE "userId"=$1 AND "readAt" IS NULL', [userId]);
    return { items, unread: count.unread };
  }
  async readNotification(userId: string, id?: string) {
    await this.db.query(`UPDATE workspace_notifications SET "readAt"=COALESCE("readAt",now()) WHERE "userId"=$1${id ? ' AND id=$2' : ''}`, id ? [userId, id] : [userId]);
    return { success: true };
  }
  async replies(userId: string) {
    return { items: await this.db.query('SELECT * FROM saved_replies WHERE "userId"=$1 ORDER BY title LIMIT 200', [userId]) };
  }
  async saveReply(dto: SavedReplyDto, userId: string) {
    const [row] = await this.db.query<Array<{ id: string }>>('INSERT INTO saved_replies ("userId",title,body) VALUES ($1,$2,$3) RETURNING *', [userId, dto.title.trim(), dto.body]);
    return row;
  }
  async deleteReply(id: string, userId: string) {
    const rows = await this.db.query<Array<{ id: string }>>('WITH deleted AS (DELETE FROM saved_replies WHERE id=$1 AND "userId"=$2 RETURNING id) SELECT * FROM deleted', [id, userId]);
    if (!rows.length) throw new NotFoundException('Saved reply not found.');
    return { id };
  }
  async drafts(userId: string) {
    return { items: await this.db.query('SELECT "destinationKey",body,"updatedAt" FROM conversation_drafts WHERE "userId"=$1 ORDER BY "updatedAt" DESC LIMIT 500', [userId]) };
  }
  async draft(dto: DraftDto, userId: string) {
    if (!dto.body) {
      await this.db.query('DELETE FROM conversation_drafts WHERE "userId"=$1 AND "destinationKey"=$2', [userId, dto.destinationKey]);
    } else {
      await this.db.query(`INSERT INTO conversation_drafts ("userId","destinationKey",body) VALUES ($1,$2,$3)
        ON CONFLICT ("userId","destinationKey") DO UPDATE SET body=EXCLUDED.body,"updatedAt"=now()`, [userId, dto.destinationKey, dto.body]);
    }
    return { success: true };
  }
  async releases(manage: boolean) {
    return { items: await this.db.query(`SELECT * FROM workspace_releases ${manage ? '' : "WHERE status='PUBLISHED'"} ORDER BY "createdAt" DESC LIMIT 100`) };
  }
  async createRelease(dto: ReleaseDto, actorId: string) {
    try {
      const [row] = await this.db.query<Array<{ id: string }>>(`INSERT INTO workspace_releases (version,title,body,"createdById") VALUES ($1,$2,$3,$4) RETURNING *`, [dto.version.trim(), dto.title.trim(), dto.body, actorId]);
      return row;
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new ConflictException('A release with this version already exists.');
      throw error;
    }
  }
  async updateRelease(id: string, dto: ReleaseUpdateDto, actorId: string) {
    return this.db.transaction(async (tx) => {
      const [before] = await tx.query<Array<{ id: string; status: string }>>('SELECT * FROM workspace_releases WHERE id=$1 FOR UPDATE', [id]);
      if (!before) throw new NotFoundException('Release not found.');
      await tx.query('INSERT INTO workspace_release_versions ("releaseId",snapshot,"actorId") VALUES ($1,$2,$3)', [id, JSON.stringify(before), actorId]);
      const [row] = await tx.query<Array<{ id: string }>>(`WITH updated AS (UPDATE workspace_releases SET version=$2,title=$3,body=$4,status=$5::varchar,
        "publishedAt"=CASE WHEN $5::varchar='PUBLISHED' THEN COALESCE("publishedAt",now()) ELSE "publishedAt" END,"updatedAt"=now() WHERE id=$1 RETURNING *) SELECT * FROM updated`,
      [id, dto.version.trim(), dto.title.trim(), dto.body, dto.status]);
      if (before.status !== 'PUBLISHED' && dto.status === 'PUBLISHED') {
        await tx.query(`INSERT INTO workspace_notifications ("userId",title,body,href)
          SELECT id,$1,$2,'/changelog' FROM users WHERE "isActive"=true`, [`What's new: ${dto.version}`, dto.title]);
      }
      return row;
    }).catch((error: unknown) => {
      if ((error as { code?: string }).code === '23505') throw new ConflictException('A release with this version already exists.');
      throw error;
    });
  }
  async releaseHistory(id: string) {
    return { items: await this.db.query('SELECT * FROM workspace_release_versions WHERE "releaseId"=$1 ORDER BY "createdAt" DESC LIMIT 100', [id]) };
  }
  async restoreRelease(id: string, versionId: string, actorId: string) {
    return this.db.transaction(async (tx) => {
      const [current] = await tx.query<Array<{ id: string }>>('SELECT * FROM workspace_releases WHERE id=$1 FOR UPDATE', [id]);
      if (!current) throw new NotFoundException('Release not found.');
      const [version] = await tx.query<Array<{ snapshot: { version: string; title: string; body: string } }>>(
        'SELECT snapshot FROM workspace_release_versions WHERE id=$1 AND "releaseId"=$2', [versionId, id]);
      if (!version) throw new NotFoundException('Release version not found.');
      await tx.query('INSERT INTO workspace_release_versions ("releaseId",snapshot,"actorId") VALUES ($1,$2,$3)', [id, JSON.stringify(current), actorId]);
      const [row] = await tx.query<Array<{ id: string }>>(`WITH updated AS (UPDATE workspace_releases
        SET version=$2,title=$3,body=$4,status='DRAFT',"publishedAt"=NULL,"updatedAt"=now() WHERE id=$1 RETURNING *) SELECT * FROM updated`,
      [id, version.snapshot.version, version.snapshot.title, version.snapshot.body]);
      return row;
    }).catch((error: unknown) => {
      if ((error as { code?: string }).code === '23505') throw new ConflictException('Another release now uses this version. Edit its version before restoring.');
      throw error;
    });
  }
}
