import { BadRequestException } from '@nestjs/common';
export const SCHEDULE_FIELDS = ['scheduled_at', 'timezone', 'recurrence', 'weekdays', 'day_of_month', 'end_at', 'occurrence_limit'];
export interface ScheduleRule {
    recurrence: string;
    timezone: string;
    weekdays: number[] | null;
    dayOfMonth: number | null;
    endAt: Date | null;
    occurrenceLimit: number | null;
}
function parts(date: Date, timezone: string) { const result = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date).map(p => [p.type, p.value])); return { year: +result.year, month: +result.month, day: +result.day, hour: +result.hour, minute: +result.minute, second: +result.second }; }
function wallTime(year: number, month: number, day: number, hour: number, minute: number, second: number, timezone: string) { const wanted = Date.UTC(year, month - 1, day, hour, minute, second); let value = wanted; for (let i = 0; i < 4; i++) {
    const p = parts(new Date(value), timezone);
    const correction = wanted - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    if (!correction)
        break;
    value += correction;
} return new Date(value); }
/** Calendar recurrence uses the selected timezone, including local DST transitions. */
export function nextScheduleRun(after: Date, rule: ScheduleRule): Date | null {
    if (rule.recurrence === 'once')
        return null;
    const p = parts(after, rule.timezone);
    for (let step = 1; step <= 370; step++) {
        let day: Date;
        if (rule.recurrence === 'monthly') {
            const month = new Date(Date.UTC(p.year, p.month - 1 + step, 1));
            const last = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate();
            day = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), Math.min(rule.dayOfMonth!, last)));
        }
        else {
            day = new Date(Date.UTC(p.year, p.month - 1, p.day + step));
            if (rule.recurrence === 'weekly' && !rule.weekdays!.includes(day.getUTCDay()))
                continue;
        }
        const candidate = wallTime(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), p.hour, p.minute, p.second, rule.timezone);
        if (candidate > after)
            return rule.endAt && candidate > rule.endAt ? null : candidate;
    }
    return null;
}
export function scheduleRule(body: Record<string, unknown>, fallback?: string): ScheduleRule & {
    nextRunAt: Date;
} {
    const nextRunAt = new Date(String(body.scheduled_at ?? fallback ?? ''));
    if (!Number.isFinite(+nextRunAt) || +nextRunAt < Date.now() || +nextRunAt > Date.now() + 366 * 86400000)
        throw new BadRequestException('Choose a future schedule within one year.');
    const timezone = String(body.timezone ?? 'UTC');
    try {
        parts(nextRunAt, timezone);
    }
    catch {
        throw new BadRequestException('Choose a valid IANA timezone.');
    }
    const recurrence = String(body.recurrence ?? 'once');
    if (!['once', 'daily', 'weekly', 'monthly'].includes(recurrence))
        throw new BadRequestException('Invalid recurrence.');
    const weekdays = Array.isArray(body.weekdays) ? body.weekdays.map(Number) : null;
    const dayOfMonth = body.day_of_month === undefined ? null : Number(body.day_of_month);
    const occurrenceLimit = body.occurrence_limit === undefined ? null : Number(body.occurrence_limit);
    const endAt = body.end_at ? new Date(String(body.end_at)) : null;
    if (recurrence === 'weekly' && (!weekdays?.length || weekdays.some(d => !Number.isInteger(d) || d < 0 || d > 6)))
        throw new BadRequestException('Choose at least one weekday.');
    if (recurrence === 'monthly' && (!Number.isInteger(dayOfMonth) || dayOfMonth! < 1 || dayOfMonth! > 31))
        throw new BadRequestException('Choose a day from 1 to 31.');
    if (occurrenceLimit !== null && (!Number.isInteger(occurrenceLimit) || occurrenceLimit < 1 || occurrenceLimit > 10000))
        throw new BadRequestException('Occurrence limit must be from 1 to 10000.');
    if (endAt && (!Number.isFinite(+endAt) || endAt <= nextRunAt))
        throw new BadRequestException('The end time must be after the first send.');
    return { nextRunAt, recurrence, timezone, weekdays, dayOfMonth, endAt, occurrenceLimit };
}
