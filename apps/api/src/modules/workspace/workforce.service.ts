import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import type { LeaveDto, ShiftDto, TeamDto } from './workspace.dto';

@Injectable()
export class WorkforceService {
  constructor(private readonly db: DataSource) {}

  async overview() {
    const people = await this.people();
    const teams = await this.db.query(`SELECT t.*, COALESCE((SELECT json_agg(json_build_object('id',m.id,'userId',u.id,'name',u.name))
      FROM workforce_memberships m JOIN users u ON u.id=m."userId" WHERE m."teamId"=t.id AND m."leftAt" IS NULL),'[]') AS members
      FROM support_teams t ORDER BY t.name LIMIT 200`);
    const shifts = await this.db.query(`SELECT s.*, u.name AS "userName", EXISTS(SELECT 1 FROM workforce_leave l
      WHERE l."userId"=s."userId" AND l.status='APPROVED'
      AND s."startsAt" < (l."endsOn"+1)::timestamptz AND s."endsAt" > l."startsOn"::timestamptz) AS "onLeave"
      FROM workforce_shifts s JOIN users u ON u.id=s."userId"
      WHERE s."endsAt" > now()-interval '7 days' ORDER BY s."startsAt" LIMIT 200`);
    const leave = await this.db.query(`SELECT l.*,u.name AS "userName" FROM workforce_leave l
      JOIN users u ON u.id=l."userId" ORDER BY l."createdAt" DESC LIMIT 200`);
    return { people, teams, shifts, leave, limit: 200 };
  }
  async people() {
    return this.db.query<Array<{ id: string; name: string }>>('SELECT id, name FROM users WHERE "isActive"=true ORDER BY name LIMIT 500');
  }
  async team(dto: TeamDto) {
    try {
      const [row] = await this.db.query<Array<{ id: string }>>('INSERT INTO support_teams (key,name,description) VALUES ($1,$2,$3) RETURNING *', [`team-${randomUUID()}`, dto.name.trim(), dto.description]);
      return row;
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new ConflictException('A team with that name already exists.');
      throw error;
    }
  }
  async member(teamId: string, userId: string, remove: boolean) {
    return this.db.transaction(async (tx) => {
      const [team] = await tx.query<Array<{ id: string; isActive: boolean }>>('SELECT * FROM support_teams WHERE id=$1 FOR UPDATE', [teamId]);
      if (!team) throw new NotFoundException('Team not found.');
      if (!team.isActive && !remove) throw new ConflictException('This team is disabled.');
      const [user] = await tx.query<Array<{ id: string }>>('SELECT id FROM users WHERE id=$1 AND "isActive"=true', [userId]);
      if (!user && !remove) throw new NotFoundException('Active user not found.');
      if (remove) {
        await tx.query('UPDATE workforce_memberships SET "leftAt"=now() WHERE "teamId"=$1 AND "userId"=$2 AND "leftAt" IS NULL', [teamId, userId]);
      } else {
        await tx.query(`INSERT INTO workforce_memberships ("teamId","userId") VALUES ($1,$2) ON CONFLICT DO NOTHING`, [teamId, userId]);
      }
      return { id: teamId, userId, removed: remove };
    });
  }
  async disable(id: string) {
    const [row] = await this.db.query<Array<{ id: string }>>('WITH updated AS (UPDATE support_teams SET "isActive"=false WHERE id=$1 RETURNING id) SELECT * FROM updated', [id]);
    if (!row) throw new NotFoundException('Team not found.');
    return row;
  }
  async shift(dto: ShiftDto, actorId: string) {
    const start = new Date(dto.startsAt); const end = new Date(dto.endsAt);
    if (end <= start || end.getTime() - start.getTime() > 24 * 60 * 60 * 1000) {
      throw new BadRequestException('A shift must end after it starts and last at most 24 hours.');
    }
    return this.db.transaction(async (tx) => {
      const [user] = await tx.query<Array<{ id: string }>>('SELECT id FROM users WHERE id=$1 AND "isActive"=true FOR UPDATE', [dto.userId]);
      if (!user) throw new NotFoundException('Active user not found.');
      const overlap = await tx.query<Array<{ id: string }>>(`SELECT id FROM workforce_shifts
        WHERE "userId"=$1 AND "cancelledAt" IS NULL AND "startsAt" < $3 AND "endsAt" > $2 LIMIT 1`, [dto.userId, dto.startsAt, dto.endsAt]);
      if (overlap.length) throw new ConflictException('This person already has a shift during that time.');
      const [row] = await tx.query<Array<{ id: string }>>(`INSERT INTO workforce_shifts ("userId","startsAt","endsAt",label,"createdById")
        VALUES ($1,$2,$3,$4,$5) RETURNING *`, [dto.userId, dto.startsAt, dto.endsAt, dto.label.trim(), actorId]);
      return row;
    });
  }
  async leave(dto: LeaveDto) {
    if (dto.endsOn < dto.startsOn) throw new BadRequestException('End date must be on or after the start date.');
    const [user] = await this.db.query<Array<{ id: string }>>('SELECT id FROM users WHERE id=$1 AND "isActive"=true', [dto.userId]);
    if (!user) throw new NotFoundException('Active user not found.');
    const [row] = await this.db.query<Array<{ id: string }>>(`INSERT INTO workforce_leave ("userId","startsOn","endsOn",reason)
      VALUES ($1,$2,$3,$4) RETURNING *`, [dto.userId, dto.startsOn, dto.endsOn, dto.reason.trim()]);
    return row;
  }
  async updateShift(id: string, dto: ShiftDto, actorId: string) {
    const start = new Date(dto.startsAt); const end = new Date(dto.endsAt);
    if (start.getTime() <= Date.now() || end <= start || end.getTime() - start.getTime() > 86_400_000) {
      throw new BadRequestException('Choose a future shift lasting at most 24 hours.');
    }
    return this.db.transaction(async (tx) => {
      const [before] = await tx.query<Array<{ id: string; userId: string; startsAt: Date; cancelledAt: Date | null }>>('SELECT * FROM workforce_shifts WHERE id=$1 FOR UPDATE', [id]);
      if (!before) throw new NotFoundException('Shift not found.');
      if (before.cancelledAt || new Date(before.startsAt).getTime() <= Date.now()) throw new ConflictException('Only upcoming, active shifts can be edited.');
      if (before.userId !== dto.userId) throw new BadRequestException('Cancel this shift and create another to change its person.');
      const [user] = await tx.query<Array<{ id: string }>>('SELECT id FROM users WHERE id=$1 AND "isActive"=true FOR UPDATE', [dto.userId]);
      if (!user) throw new NotFoundException('Active user not found.');
      const overlap = await tx.query<Array<{ id: string }>>(`SELECT id FROM workforce_shifts WHERE "userId"=$1 AND id<>$4
        AND "cancelledAt" IS NULL AND "startsAt" < $3 AND "endsAt" > $2 LIMIT 1`, [dto.userId, dto.startsAt, dto.endsAt, id]);
      if (overlap.length) throw new ConflictException('This person already has a shift during that time.');
      const [after] = await tx.query<Array<{ id: string }>>(`WITH updated AS (UPDATE workforce_shifts SET "startsAt"=$2,"endsAt"=$3,label=$4 WHERE id=$1 RETURNING *) SELECT * FROM updated`,
        [id, dto.startsAt, dto.endsAt, dto.label.trim()]);
      await tx.query('INSERT INTO workforce_shift_events ("shiftId",action,"before","after","actorId") VALUES ($1,$2,$3,$4,$5)',
        [id, 'UPDATED', JSON.stringify(before), JSON.stringify(after), actorId]);
      return after;
    });
  }
  async cancelShift(id: string, reason: string, actorId: string) {
    return this.db.transaction(async (tx) => {
      const [before] = await tx.query<Array<{ id: string; endsAt: Date; cancelledAt: Date | null }>>('SELECT * FROM workforce_shifts WHERE id=$1 FOR UPDATE', [id]);
      if (!before) throw new NotFoundException('Shift not found.');
      if (before.cancelledAt || new Date(before.endsAt).getTime() <= Date.now()) throw new ConflictException('This shift is already cancelled or has ended.');
      const [after] = await tx.query<Array<{ id: string }>>(`WITH updated AS (UPDATE workforce_shifts
        SET "cancelledAt"=now(),"cancelledById"=$2,"cancellationReason"=$3 WHERE id=$1 RETURNING *) SELECT * FROM updated`, [id, actorId, reason.trim()]);
      await tx.query('INSERT INTO workforce_shift_events ("shiftId",action,"before","after","actorId") VALUES ($1,$2,$3,$4,$5)',
        [id, 'CANCELLED', JSON.stringify(before), JSON.stringify(after), actorId]);
      return after;
    });
  }
  async shiftHistory(id: string) {
    const [shift] = await this.db.query<Array<{ id: string }>>('SELECT id FROM workforce_shifts WHERE id=$1', [id]);
    if (!shift) throw new NotFoundException('Shift not found.');
    return { items: await this.db.query(`SELECT e.*,u.name AS "actorName" FROM workforce_shift_events e JOIN users u ON u.id=e."actorId"
      WHERE "shiftId"=$1 ORDER BY e."createdAt" DESC,e.id DESC LIMIT 100`, [id]) };
  }
  async review(id: string, status: string, actorId: string) {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.query<Array<{ id: string; userId: string }>>(`WITH updated AS (UPDATE workforce_leave SET status=$2,"reviewedById"=$3
        WHERE id=$1 AND status='PENDING' RETURNING *) SELECT * FROM updated`, [id, status, actorId]);
      if (!row) throw new ConflictException('Leave request was not found or has already been reviewed.');
      await tx.query(`INSERT INTO workspace_notifications ("userId",title,body,href) VALUES ($1,$2,$3,$4)`,
        [row.userId, `Leave ${status.toLowerCase()}`, 'Your leave request has been reviewed by a manager.', '/notifications']);
      return row;
    });
  }
}
