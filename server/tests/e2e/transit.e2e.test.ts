/**
 * Transit proxy e2e — /api/transit/geocode + /api/transit/plan through the real
 * JwtAuthGuard against a temp SQLite db. The DI-native TransitService's provider
 * methods are stubbed via instance spies (no outbound HTTP); this focuses on
 * auth (401), param pass-through and error propagation (#1065).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import type { Server } from 'http';
import { Test } from '@nestjs/testing';
import { seedUser, sessionCookie } from './harness';

const { db } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3');
  const tmp = new Database(':memory:');
  tmp.exec('PRAGMA journal_mode = WAL');
  tmp.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE, role TEXT NOT NULL DEFAULT 'user', password_version INTEGER NOT NULL DEFAULT 0);`);
  // StorageRegistryService (behind StorageModule, now in this module chain) reads
  // this at onModuleInit.
  tmp.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);');
  return { db: tmp };
});
vi.mock('../../src/db/database', () => ({ db, closeDb: () => {}, reinitialize: () => {} }));

import { TransitModule } from '../../src/nest/transit/transit.module';
import { TransitService } from '../../src/nest/transit/transit.service';
import { DatabaseModule } from '../../src/nest/database/database.module';
import { RealtimeModule } from '../../src/nest/realtime/realtime.module';
import { TrekExceptionFilter } from '../../src/nest/common/trek-exception.filter';

describe('Transit proxy e2e (real auth guard + temp SQLite)', () => {
  let server: Server;
  let app: Awaited<ReturnType<typeof build>>;
  let geocodeSpy: ReturnType<typeof vi.spyOn>;
  let planSpy: ReturnType<typeof vi.spyOn>;

  async function build() {
    const moduleRef = await Test.createTestingModule({
      // DatabaseModule + RealtimeModule are @Global in the app graph;
      // TransitModule's DaysModule/ReservationsModule imports need them here.
      imports: [DatabaseModule, RealtimeModule, TransitModule],
    }).compile();
    const nest = moduleRef.createNestApplication();
    nest.use(cookieParser());
    nest.useGlobalFilters(new TrekExceptionFilter());
    await nest.init();
    return nest;
  }

  beforeAll(async () => {
    seedUser(db as never, { id: 1 });
    app = await build();
    server = app.getHttpServer();
    const transit = app.get(TransitService);
    geocodeSpy = vi.spyOn(transit, 'geocode') as ReturnType<typeof vi.spyOn>;
    planSpy = vi.spyOn(transit, 'plan') as ReturnType<typeof vi.spyOn>;
  });

  beforeEach(() => {
    geocodeSpy.mockReset();
    planSpy.mockReset();
  });

  afterAll(async () => { await app.close(); });

  it('401 without a session cookie', async () => {
    expect((await request(server).get('/api/transit/geocode?q=alexanderplatz')).status).toBe(401);
    expect((await request(server).get('/api/transit/providers')).status).toBe(401);
    expect((await request(server).get('/api/transit/plan?from=1,2&to=3,4')).status).toBe(401);
  });

  it('lists only the transit providers configured on this instance', async () => {
    db.prepare("DELETE FROM app_settings WHERE key IN ('transit_provider', 'navitime_api_key')").run();
    const transitousOnly = await request(server).get('/api/transit/providers').set('Cookie', sessionCookie(1));
    expect(transitousOnly.status).toBe(200);
    expect(transitousOnly.body).toEqual({ defaultProvider: 'transitous', providers: ['transitous'] });

    db.prepare("INSERT INTO app_settings (key, value) VALUES ('transit_provider', 'navitime'), ('navitime_api_key', 'rapid-key')").run();
    const both = await request(server).get('/api/transit/providers').set('Cookie', sessionCookie(1));
    expect(both.status).toBe(200);
    expect(both.body).toEqual({ defaultProvider: 'navitime', providers: ['transitous', 'navitime'] });
  });

  it('geocode passes q/lang/near through and returns the service result', async () => {
    geocodeSpy.mockResolvedValueOnce({ results: [{ name: 'Alexanderplatz' }] });
    const res = await request(server).get('/api/transit/geocode?q=alex&lang=de&near=52.5,13.4').set('Cookie', sessionCookie(1));
    expect(res.status).toBe(200);
    expect(res.body.results[0].name).toBe('Alexanderplatz');
    expect(geocodeSpy).toHaveBeenCalledWith('alex', 'de', '52.5,13.4');
  });

  it('plan passes all params through (arriveBy + maxTransfers coerced)', async () => {
    planSpy.mockResolvedValueOnce({ provider: 'navitime', itineraries: [], isTimetable: false });
    const res = await request(server)
      .get('/api/transit/plan?from=52.5,13.4&to=52.6,13.5&time=2026-07-13T09:00:00Z&arriveBy=true&modes=BUS&maxTransfers=2&provider=navitime')
      .set('Cookie', sessionCookie(1));
    expect(res.status).toBe(200);
    expect(planSpy).toHaveBeenCalledWith({
      from: '52.5,13.4', to: '52.6,13.5', time: '2026-07-13T09:00:00Z', arriveBy: true, modes: 'BUS', maxTransfers: 2,
    }, 'navitime');
  });

  it('service validation errors propagate with their status', async () => {
    const err = new Error('from must be "lat,lng"') as Error & { status: number };
    err.status = 400;
    planSpy.mockRejectedValueOnce(err);
    const res = await request(server).get('/api/transit/plan?from=bad&to=1,2').set('Cookie', sessionCookie(1));
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('lat,lng');
  });

  it('rejects an unknown provider before dispatching a plan', async () => {
    const res = await request(server)
      .get('/api/transit/plan?from=1,2&to=3,4&provider=google')
      .set('Cookie', sessionCookie(1));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'unsupported transit provider' });
    expect(planSpy).not.toHaveBeenCalled();
  });

  it('returns the actual provider and timetable status alongside the itineraries', async () => {
    planSpy.mockResolvedValueOnce({ provider: 'navitime', itineraries: [], isTimetable: false });
    const res = await request(server).get('/api/transit/plan?from=35.6,139.7&to=35.7,139.8').set('Cookie', sessionCookie(1));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ provider: 'navitime', itineraries: [], isTimetable: false });
  });

  it('a provider selected without its credential surfaces as 503', async () => {
    // The dispatch itself refuses (TRANSIT-SVC-018 covers that with the real
    // service); this pins that the controller relays the status rather than
    // flattening it into the generic 502.
    const err = new Error('The navitime transit provider is not configured.') as Error & { status: number };
    err.status = 503;
    planSpy.mockRejectedValueOnce(err);
    const res = await request(server).get('/api/transit/plan?from=1,2&to=3,4').set('Cookie', sessionCookie(1));
    expect(res.status).toBe(503);
    expect(res.body.error).toContain('not configured');
  });

  it('upstream failures surface as 502', async () => {
    const err = new Error('Transit provider error (HTTP 500)') as Error & { status: number };
    err.status = 502;
    planSpy.mockRejectedValueOnce(err);
    const res = await request(server).get('/api/transit/plan?from=1,2&to=3,4').set('Cookie', sessionCookie(1));
    expect(res.status).toBe(502);
  });
});
