/**
 * ThumbnailService — the downscaled JPEG for a locally uploaded journey photo.
 *
 * Untested before the fold, because it lived outside the measured tree. The
 * cases below pin the three things that decide whether a gallery shows a
 * picture or a broken tile: the addon gate, the "source is gone" bail-out, and
 * the mtime check that avoids regenerating an up-to-date thumbnail.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const { isAddonEnabled } = vi.hoisted(() => ({ isAddonEnabled: vi.fn(() => true) }));

import fs from 'node:fs';
import path from 'node:path';
import { Jimp } from 'jimp';
import { ThumbnailService } from '../../../src/nest/memories/thumbnail.service';
import type { AddonsService } from '../../../src/nest/addons/addons.service';
import { makeStorageFixture } from '../../helpers/storage-fixture';

// Category-addressed since slice 4: originals + thumbs are ('journey', <name>)
// objects; the fixture's 'journey/' prefix reproduces the real layout, so the
// on-disk paths below look exactly like the old uploads-root ones.
const fx = makeStorageFixture('journey/');
const svc = new ThumbnailService({ isAddonEnabled } as unknown as AddonsService, fx.storage);
const root = fx.root;

/** A real 1200x900 JPEG — Jimp has to be able to decode it for the happy path. */
async function writeSourceImage(rel: string): Promise<void> {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const img = new Jimp({ width: 1200, height: 900, color: 0xff0000ff });
  await img.write(abs as `${string}.jpg`);
}

beforeEach(() => {
  vi.clearAllMocks();
  isAddonEnabled.mockReturnValue(true);
});

afterAll(() => {
  fx.cleanup();
});

describe('ensureLocalThumbnail', () => {
  it('THUMB-001: returns null when the journey addon is off, without touching the disk', async () => {
    isAddonEnabled.mockReturnValue(false);
    expect(await svc.ensureLocalThumbnail('anything.jpg')).toBeNull();
  });

  it('THUMB-002: returns null when the source object does not exist', async () => {
    expect(await svc.ensureLocalThumbnail('journey/missing.jpg')).toBeNull();
  });

  it('THUMB-002b: returns null for a path outside the journey category', async () => {
    expect(await svc.ensureLocalThumbnail('missing/nope.jpg')).toBeNull();
  });

  it('THUMB-003: downscales an oversized image and reports the resulting size', async () => {
    await writeSourceImage('journey/big.jpg');

    const result = await svc.ensureLocalThumbnail('journey/big.jpg');

    expect(result).not.toBeNull();
    expect(result!.thumbnailRelPath).toMatch(/^journey\/thumbs\/[0-9a-f]{16}\.jpg$/);
    // 1200x900 fits into an 800 box as 800x600.
    expect(Math.max(result!.width, result!.height)).toBeLessThanOrEqual(800);
    expect(fs.existsSync(path.join(root, result!.thumbnailRelPath))).toBe(true);
  });

  it('THUMB-004: the path is deterministic, so concurrent requests cannot race on two names', async () => {
    await writeSourceImage('journey/stable.jpg');

    const first = await svc.ensureLocalThumbnail('journey/stable.jpg');
    const second = await svc.ensureLocalThumbnail('journey/stable.jpg');

    expect(second!.thumbnailRelPath).toBe(first!.thumbnailRelPath);
  });

  it('THUMB-005: reuses an existing thumbnail that is newer than the source', async () => {
    await writeSourceImage('journey/cached.jpg');
    const first = await svc.ensureLocalThumbnail('journey/cached.jpg');
    const thumbAbs = path.join(root, first!.thumbnailRelPath);
    const mtimeBefore = fs.statSync(thumbAbs).mtimeMs;

    const second = await svc.ensureLocalThumbnail('journey/cached.jpg');

    expect(second).toEqual(first);
    expect(fs.statSync(thumbAbs).mtimeMs).toBe(mtimeBefore);
  });

  it('THUMB-006: regenerates when the source is newer than the thumbnail', async () => {
    await writeSourceImage('journey/changed.jpg');
    const first = await svc.ensureLocalThumbnail('journey/changed.jpg');
    const thumbAbs = path.join(root, first!.thumbnailRelPath);
    // Age the thumbnail past the source.
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(thumbAbs, old, old);

    const second = await svc.ensureLocalThumbnail('journey/changed.jpg');

    expect(second!.thumbnailRelPath).toBe(first!.thumbnailRelPath);
    expect(fs.statSync(thumbAbs).mtimeMs).toBeGreaterThan(old.getTime());
  });

  it('THUMB-007: returns null for a file Jimp cannot decode instead of throwing', async () => {
    const abs = path.join(root, 'journey/corrupt.jpg');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'not an image at all');

    expect(await svc.ensureLocalThumbnail('journey/corrupt.jpg')).toBeNull();
  });
});
