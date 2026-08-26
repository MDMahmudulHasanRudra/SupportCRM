import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({ description: 'Username or email address', example: 'admin' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  identifier!: string;

  @ApiProperty({ description: 'Password', example: 'ChangeMe!123' })
  @IsString()
  @MinLength(1)
  // Upper bound guards against a megabyte-long string being fed to scrypt as a cheap DoS.
  @MaxLength(256)
  password!: string;
}

export class SessionUserDto {
  @ApiProperty() id!: string;
  @ApiProperty() username!: string;
  @ApiProperty() email!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: [String] }) roles!: string[];
  @ApiProperty({ type: [String] }) permissions!: string[];
  @ApiProperty() isSuperAdmin!: boolean;
}
