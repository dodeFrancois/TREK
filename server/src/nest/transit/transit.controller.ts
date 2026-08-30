import { Controller, Get, HttpException, Query, Req, UseGuards } from '@nestjs/common';
import { transitProviderSchema, type TransitProvider } from '@trek/shared';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RateLimitService } from '../common/rate-limit.service';
import { TransitService } from './transit.service';

const RL_WINDOW = 15 * 60 * 1000;

/**
 * /api/transit — public transit routing (#1065).
 *
 * Planning goes to the provider the administrator selected by default, with an
 * optional per-request override among the configured providers.
 * Geocoding is always Transitous — the NAVITIME subscription exposes no
 * geocoding endpoint at all.
 *
 * JWT-guarded and rate-limited: the Transitous usage policy asks integrators to
 * keep expensive routing traffic reasonable, so planning gets a tighter bucket
 * than geocoding.
 */
@Controller('api/transit')
@UseGuards(JwtAuthGuard)
export class TransitController {
  constructor(
    private readonly rl: RateLimitService,
    private readonly transit: TransitService,
  ) {}

  private limit(bucket: string, req: Request, max: number): void {
    if (!this.rl.check(bucket, req.ip || 'unknown', max, RL_WINDOW, Date.now())) {
      throw new HttpException({ error: 'Too many requests. Please try again later.' }, 429);
    }
  }

  private rethrow(err: unknown): never {
    const status = (err as { status?: number }).status || 502;
    const message = err instanceof Error ? err.message : 'Transit provider error';
    throw new HttpException({ error: message }, status);
  }

  @Get('geocode')
  async geocode(
    @Query('q') q: string | undefined,
    @Query('lang') lang: string | undefined,
    @Query('near') near: string | undefined,
    @Req() req: Request,
  ) {
    this.limit('transit_geocode', req, 300);
    try {
      return await this.transit.geocode(q || '', lang, near);
    } catch (err) { this.rethrow(err); }
  }

  @Get('providers')
  providers() {
    return this.transit.providers();
  }

  @Get('plan')
  async plan(
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('time') time: string | undefined,
    @Query('arriveBy') arriveBy: string | undefined,
    @Query('modes') modes: string | undefined,
    @Query('maxTransfers') maxTransfers: string | undefined,
    @Query('provider') provider: string | undefined,
    @Req() req: Request,
  ) {
    this.limit('transit_plan', req, 60);
    try {
      let requestedProvider: TransitProvider | undefined;
      if (provider !== undefined) {
        const parsedProvider = transitProviderSchema.safeParse(provider);
        if (!parsedProvider.success) {
          throw Object.assign(new Error('unsupported transit provider'), { status: 400 });
        }
        requestedProvider = parsedProvider.data;
      }
      return await this.transit.plan({
        from: from || '',
        to: to || '',
        time,
        arriveBy: arriveBy === 'true' || arriveBy === '1',
        modes,
        maxTransfers: maxTransfers !== undefined && maxTransfers !== '' ? Number(maxTransfers) : undefined,
      }, requestedProvider);
    } catch (err) { this.rethrow(err); }
  }
}
