import { Body, Controller, Get, HttpCode, HttpException, Post, Put, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { redactStorageSecrets } from './storage-secrets';
import type { User } from '../../types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuditService } from '../audit/audit.service';
import { getClientIp } from '../audit/client-ip';
import { ManagedForbidden } from '../common/managed';
import { StorageAdminService } from './storage-admin.service';
import { StorageConfigDto, StorageTestRequestDto } from './storage-admin.dto';

/**
 * /api/admin/storage — the admin surface over the storage registry (spec:
 * docs/superpowers/specs/2026-08-19-storage-admin-config-design.md). Backends,
 * category assignment, and mirror composition are managed here; secrets are
 * stored encrypted and only ever rendered as the mask. Pipeline refusals are
 * operator-grade registry messages, surfaced verbatim in the 400 envelope.
 */
@Controller('api/admin/storage')
@UseGuards(JwtAuthGuard, AdminGuard)
@ManagedForbidden('storage backends and their credentials are hoster-level configuration')
export class StorageAdminController {
  constructor(
    private readonly service: StorageAdminService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  get() {
    return this.service.state();
  }

  @Put()
  update(@CurrentUser() user: User, @Body() body: StorageConfigDto, @Req() req: Request) {
    try {
      this.service.applyConfig(body);
    } catch (err) {
      throw new HttpException({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
    this.audit.writeAudit({
      userId: user.id,
      action: 'admin.storage_update',
      ip: getClientIp(req),
      details: redactStorageSecrets(body) as unknown as Record<string, unknown>,
    });
    // The defaults-tab contract: never echo the request — answer the fresh effective world.
    return this.service.state();
  }

  @Post('test')
  @HttpCode(200) // a probe answers 200 with per-target results, not a 201 resource
  async test(@CurrentUser() user: User, @Body() body: StorageTestRequestDto, @Req() req: Request) {
    let result;
    try {
      result = await this.service.testBackend(body.backend);
    } catch (err) {
      throw new HttpException({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
    // Audited because the probe writes and deletes an object; names only, never options.
    this.audit.writeAudit({
      userId: user.id,
      action: 'admin.storage_test',
      ip: getClientIp(req),
      details: {
        backend: body.backend.name,
        type: body.backend.type,
        ok: result.ok,
        targets: result.targets.map(({ name, ok }) => ({ name, ok })),
      },
    });
    return result;
  }
}
