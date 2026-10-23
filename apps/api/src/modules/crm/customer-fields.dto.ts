import { Transform, Type } from 'class-transformer';
import { IsArray, IsEmail, IsEnum, IsIn, IsInt, IsISO31661Alpha2, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { CustomerStatus } from './entities/customer.entity';

const clean = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() || null : value;
export class CustomerFieldsDto {
  @IsOptional() @Transform(clean) @IsString() @MaxLength(32) primaryPhone?: string | null;
  @IsOptional() @Transform(clean) @IsEmail() @MaxLength(255) email?: string | null;
  @IsOptional() @Transform(clean) @IsString() @MaxLength(190) company?: string | null;
  @IsOptional() @Transform(clean) @IsISO31661Alpha2() country?: string | null;
  @IsOptional() @Transform(clean) @IsString() @MaxLength(160) serviceName?: string | null;
  @IsOptional() @IsUUID() accountOwnerId?: string | null;
}
export class CreateCustomerDto extends CustomerFieldsDto {
  @IsString() @Matches(/\S/) @MaxLength(190) displayName!: string;
  @IsOptional() @Transform(clean) @Matches(/^[A-Z0-9][A-Z0-9_-]{1,39}$/) code?: string | null;
  @IsOptional() @IsEnum(CustomerStatus) status?: CustomerStatus;
}
export class UpdateCustomerDto extends CustomerFieldsDto {
  @ValidateIf((_o, v) => v !== undefined) @IsString() @Matches(/\S/) @MaxLength(190) displayName?: string;
  @ValidateIf((_o, v) => v !== undefined) @IsEnum(CustomerStatus) status?: CustomerStatus;
}
export class ListCustomersDto {
  @IsOptional() @IsString() @MaxLength(120) search?: string;
  @IsOptional() @IsEnum(CustomerStatus) status?: CustomerStatus;
  @IsOptional() @IsISO31661Alpha2() country?: string;
  @IsOptional() @IsUUID() accountOwnerId?: string;
  @IsOptional() @IsIn(['true']) unassigned?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) tagKeys?: string[];
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}
