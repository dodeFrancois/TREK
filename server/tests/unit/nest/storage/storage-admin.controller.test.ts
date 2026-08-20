import { describe, it, expect, vi } from 'vitest';
import { HttpException } from '@nestjs/common';
import type { Request } from 'express';
import type { User } from '../../../../src/types';
import { StorageAdminController } from '../../../../src/nest/storage/storage-admin.controller';
import type { StorageAdminService } from '../../../../src/nest/storage/storage-admin.service';
import type { AuditService } from '../../../../src/nest/audit/audit.service';
import type { StorageConfigDto } from '../../../../src/nest/storage/storage-admin.dto';
import { StorageModule } from '../../../../src/nest/storage/storage.module';
import { StorageBackendError } from '../../../../src/nest/storage/storage.types';
import { expectRegisteredController } from '../../../helpers/module-providers';

const user = { id: 1 } as User;
const req = { headers: {}, socket: { remoteAddress: '127.0.0.1' } } as unknown as Request;
const FRESH_STATE = { backends: [], categories: {}, health: { replicaFailures: [] }, encryptionReady: true, seedFilePresent: false };

function makeController(over: Partial<Record<keyof StorageAdminService, unknown>> = {}) {
  const writeAudit = vi.fn();
  const service = {
    state: vi.fn(() => FRESH_STATE),
    applyConfig: vi.fn(),
    ...over,
  } as unknown as StorageAdminService;
  const controller = new StorageAdminController(service, { writeAudit } as unknown as AuditService);
  return { controller, service, writeAudit };
}

const CONFIG = {
  backends: [
    {
      name: 'off-box',
      type: 's3' as const,
      options: {
        endpoint: 'http://127.0.0.1:9000',
        bucket: 'trek',
        accessKeyId: 'ak',
        secretAccessKey: 'sk-plain',
        region: 'us-east-1',
        keyPrefix: '',
        retries: 1,
        timeoutMs: 30000,
      },
    },
  ],
  categories: { backups: 'off-box' },
} as StorageConfigDto;

describe('StorageAdminController', () => {
  it('STORCTL-001 GET returns the service state untouched', () => {
    const { controller, service } = makeController();
    expect(controller.get()).toBe(FRESH_STATE);
    expect(service.state).toHaveBeenCalledTimes(1);
  });

  it('STORCTL-002 PUT applies, audits with secrets redacted, and answers the fresh state', () => {
    const { controller, service, writeAudit } = makeController();
    const result = controller.update(user, CONFIG, req);
    expect(service.applyConfig).toHaveBeenCalledWith(CONFIG);
    expect(result).toBe(FRESH_STATE); // never echoes the request
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 1, action: 'admin.storage_update' }),
    );
    const details = (writeAudit.mock.calls[0]![0] as { details: { backends: Array<{ options: Record<string, unknown> }> } }).details;
    expect(details.backends[0]!.options.secretAccessKey).toBe('***');
    expect(details.backends[0]!.options.accessKeyId).toBe('ak'); // names/shape survive redaction
  });

  it('STORCTL-003 PUT maps pipeline refusals to a 400 with the message verbatim, no audit', () => {
    const { controller, writeAudit } = makeController({
      applyConfig: vi.fn(() => {
        throw new StorageBackendError("category 'backups' maps to unknown backend 'nope'");
      }),
    });
    try {
      controller.update(user, CONFIG, req);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(400);
      expect((err as HttpException).getResponse()).toEqual({
        error: "category 'backups' maps to unknown backend 'nope'",
      });
    }
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('STORCTL-004 the controller is registered in StorageModule', () => {
    expectRegisteredController(StorageModule, StorageAdminController);
  });
});
