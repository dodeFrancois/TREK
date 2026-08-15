import { Module } from '@nestjs/common';
import { AppConfigModule } from '../app-config/app-config.module';
import { StorageRegistryService } from './storage-registry.service';
import { StorageService } from './storage.service';

/**
 * The storage core (spec:
 * docs/superpowers/specs/2026-07-20-storage-backend-abstraction-design.md).
 * Consuming modules import this explicitly (repo convention — SchedulingModule
 * is deliberately not consumed via @Global either); AppConfigModule is listed
 * even though it is @Global so an e2e TestingModule built around one domain
 * still resolves RuntimeEnvService (the memories.module precedent).
 * DatabaseModule IS consumed via @Global, like every other domain.
 *
 * No controller: v1 has no HTTP surface — the registry's reload() is wired to
 * an admin route only when the admin UI lands (Deferred).
 */
@Module({
  imports: [AppConfigModule],
  providers: [StorageRegistryService, StorageService],
  exports: [StorageService],
})
export class StorageModule {}
