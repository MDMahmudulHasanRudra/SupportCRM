import { IsDateString, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';

export class InvoiceDto {
  @IsUUID() customerId!: string;
  @IsString() @Matches(/\S/) @MaxLength(500) description!: string;
  @Matches(/^[A-Z]{3}$/) currency!: string;
  @IsInt() @Min(1) @Max(100000000000) amountMinor!: number;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) @IsDateString({ strict: true }) dueDate!: string;
}
export class PaymentDto {
  @IsUUID() invoiceId!: string;
  @IsInt() @Min(1) @Max(100000000000) amountMinor!: number;
  @IsString() @Matches(/\S/) @MaxLength(190) reference!: string;
  @IsUUID() idempotencyKey!: string;
}
export class ReasonDto { @IsString() @Matches(/\S/) @MaxLength(500) reason!: string; }
export class SubscriptionDto {
  @IsUUID() customerId!: string;
  @IsString() @Matches(/\S/) @MaxLength(160) name!: string;
  @IsIn(['TRIAL', 'ACTIVE']) status!: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) @IsDateString({ strict: true }) startsOn!: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) @IsDateString({ strict: true }) endsOn!: string;
}
export class SubscriptionActionDto {
  @IsIn(['RENEW', 'PAUSE', 'RESUME', 'CANCEL']) action!: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) @IsDateString({ strict: true }) endsOn?: string;
}
export class TeamDto {
  @IsString() @Matches(/\S/) @MaxLength(120) name!: string;
  @IsString() @MaxLength(500) description!: string;
}
export class MemberDto { @IsUUID() userId!: string; }
export class ShiftDto {
  @IsUUID() userId!: string;
  @IsDateString({ strict: true }) startsAt!: string;
  @IsDateString({ strict: true }) endsAt!: string;
  @IsString() @Matches(/\S/) @MaxLength(120) label!: string;
}
export class LeaveDto {
  @IsUUID() userId!: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) @IsDateString({ strict: true }) startsOn!: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) @IsDateString({ strict: true }) endsOn!: string;
  @IsString() @Matches(/\S/) @MaxLength(500) reason!: string;
}
export class LeaveReviewDto { @IsIn(['APPROVED', 'REJECTED']) status!: string; }
export class SavedReplyDto {
  @IsString() @Matches(/\S/) @MaxLength(120) title!: string;
  @IsString() @Matches(/\S/) @MaxLength(8000) body!: string;
}
export class DraftDto {
  @IsString() @IsNotEmpty() @MaxLength(400) destinationKey!: string;
  @IsString() @MaxLength(8000) body!: string;
}
export class ReleaseDto {
  @IsString() @Matches(/\S/) @MaxLength(40) version!: string;
  @IsString() @Matches(/\S/) @MaxLength(190) title!: string;
  @IsString() @Matches(/\S/) @MaxLength(20000) body!: string;
}
export class ReleaseUpdateDto extends ReleaseDto {
  @IsIn(['DRAFT', 'PUBLISHED', 'ARCHIVED']) status!: string;
}
export class ReleaseRestoreDto { @IsUUID() versionId!: string; }
