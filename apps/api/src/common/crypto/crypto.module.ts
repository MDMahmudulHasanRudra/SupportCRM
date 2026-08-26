import { Global, Module } from '@nestjs/common';
import { CryptoService } from './crypto.service';

/** Global: password hashing, token hashing and secret encryption are needed by many modules. */
@Global()
@Module({
  providers: [CryptoService],
  exports: [CryptoService],
})
export class CryptoModule {}
