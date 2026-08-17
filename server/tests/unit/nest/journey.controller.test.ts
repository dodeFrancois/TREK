import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HttpException } from '@nestjs/common';
import type { Response } from 'express';

import { JourneyController } from '../../../src/nest/journey/journey.controller';
import { journeyThumbName } from '../../../src/nest/memories/thumbnail.service';
import { JourneyPublicController } from '../../../src/nest/journey/journey-public.controller';
import type { JourneyService } from '../../../src/nest/journey/journey.service';
import type { StorageService } from '../../../src/nest/storage/storage.service';
import type { User } from '../../../src/types';

const user = { id: 1, username: 'u', role: 'user', email: 'u@example.test' } as User;

function svc(o: Partial<JourneyService> = {}): JourneyService {
  return { journeyAddonEnabled: vi.fn().mockReturnValue(true), ...o } as unknown as JourneyService;
}

const storageExists = vi.fn();
const storageSendToResponse = vi.fn();
const storageStub = {
  put: vi.fn().mockResolvedValue(undefined),
  delete: vi.fn().mockResolvedValue(undefined),
  exists: storageExists,
  sendToResponse: storageSendToResponse,
} as unknown as StorageService;

function thrown(fn: () => unknown): { status: number; body: unknown } {
  try { fn(); } catch (err) {
    expect(err).toBeInstanceOf(HttpException);
    const e = err as HttpException;
    return { status: e.getStatus(), body: e.getResponse() };
  }
  throw new Error('expected throw');
}
async function thrownAsync(fn: () => Promise<unknown>): Promise<{ status: number; body: unknown }> {
  try { await fn(); } catch (err) {
    expect(err).toBeInstanceOf(HttpException);
    const e = err as HttpException;
    return { status: e.getStatus(), body: e.getResponse() };
  }
  throw new Error('expected throw');
}

beforeEach(() => vi.clearAllMocks());

describe('JourneyController', () => {
  it('GET / lists; POST / 400 without title, else creates', () => {
    expect(new JourneyController(svc({ listJourneys: vi.fn().mockReturnValue([{ id: 1 }]) } as Partial<JourneyService>), storageStub).list(user)).toEqual({ journeys: [{ id: 1 }] });
    expect(thrown(() => new JourneyController(svc(), storageStub).create(user, { title: '   ' }))).toEqual({ status: 400, body: { error: 'Title is required' } });
    const createJourney = vi.fn().mockReturnValue({ id: 9 });
    expect(new JourneyController(svc({ createJourney } as Partial<JourneyService>), storageStub).create(user, { title: ' Trip ', trip_ids: [1, '2'] })).toEqual({ id: 9 });
    expect(createJourney).toHaveBeenCalledWith(1, { title: 'Trip', subtitle: undefined, trip_ids: [1, 2] });
  });

  it('GET /suggestions + /available-trips', () => {
    expect(new JourneyController(svc({ getSuggestions: vi.fn().mockReturnValue([{ id: 1 }]) } as Partial<JourneyService>), storageStub).suggestions(user)).toEqual({ trips: [{ id: 1 }] });
    expect(new JourneyController(svc({ listUserTrips: vi.fn().mockReturnValue([{ id: 2 }]) } as Partial<JourneyService>), storageStub).availableTrips(user)).toEqual({ trips: [{ id: 2 }] });
  });

  it('PATCH/DELETE entries map 404', () => {
    expect(thrown(() => new JourneyController(svc({ updateEntry: vi.fn().mockReturnValue(null) } as Partial<JourneyService>), storageStub).updateEntry(user, '3', {}))).toEqual({ status: 404, body: { error: 'Entry not found' } });
    expect(new JourneyController(svc({ updateEntry: vi.fn().mockReturnValue({ id: 3 }) } as Partial<JourneyService>), storageStub).updateEntry(user, '3', { title: 'x' })).toEqual({ id: 3 });
    expect(thrown(() => new JourneyController(svc({ deleteEntry: vi.fn().mockReturnValue(false) } as Partial<JourneyService>), storageStub).deleteEntry(user, '3'))).toEqual({ status: 404, body: { error: 'Entry not found' } });
    expect(new JourneyController(svc({ deleteEntry: vi.fn().mockReturnValue(true) } as Partial<JourneyService>), storageStub).deleteEntry(user, '3')).toEqual({ success: true });
  });

  it('provider-photos: batch, single 400/403, success', () => {
    const batch = svc({ addProviderPhoto: vi.fn().mockReturnValue({ id: 1 }) } as Partial<JourneyService>);
    expect(new JourneyController(batch, storageStub).providerPhotos(user, '3', { provider: 'immich', asset_ids: ['a', 'b'] })).toEqual({ photos: [{ id: 1 }, { id: 1 }], added: 2 });
    expect(thrown(() => new JourneyController(svc(), storageStub).providerPhotos(user, '3', { provider: 'immich' }))).toEqual({ status: 400, body: { error: 'provider and asset_id required' } });
    expect(thrown(() => new JourneyController(svc({ addProviderPhoto: vi.fn().mockReturnValue(null) } as Partial<JourneyService>), storageStub).providerPhotos(user, '3', { provider: 'immich', asset_id: 'a' }))).toEqual({ status: 403, body: { error: 'Not allowed or duplicate' } });
  });

  it('link-photo: 400 without id (accepts legacy photo_id), 403, success', () => {
    expect(thrown(() => new JourneyController(svc(), storageStub).linkPhoto(user, '3', {}))).toEqual({ status: 400, body: { error: 'journey_photo_id required' } });
    const linkPhotoToEntry = vi.fn().mockReturnValue({ id: 5 });
    const c = new JourneyController(svc({ linkPhotoToEntry } as Partial<JourneyService>), storageStub);
    expect(c.linkPhoto(user, '3', { photo_id: 5 })).toEqual({ id: 5 });
    expect(linkPhotoToEntry).toHaveBeenCalledWith(3, 5, 1);
    // accepts the canonical journey_photo_id, 403 when the service refuses
    expect(thrown(() => new JourneyController(svc({ linkPhotoToEntry: vi.fn().mockReturnValue(null) } as Partial<JourneyService>), storageStub).linkPhoto(user, '3', { journey_photo_id: 9 }))).toEqual({ status: 403, body: { error: 'Not allowed' } });
  });

  it('unlink photo (204) maps 404; delete photo 404 then removes the object', async () => {
    expect(thrown(() => new JourneyController(svc({ unlinkPhotoFromEntry: vi.fn().mockReturnValue(false) } as Partial<JourneyService>), storageStub).unlinkPhoto(user, '3', '7'))).toEqual({ status: 404, body: { error: 'Not found or not allowed' } });
    expect(new JourneyController(svc({ unlinkPhotoFromEntry: vi.fn().mockReturnValue(true) } as Partial<JourneyService>), storageStub).unlinkPhoto(user, '3', '7')).toBeUndefined();
    expect(await thrownAsync(() => new JourneyController(svc({ deletePhoto: vi.fn().mockReturnValue(null) } as Partial<JourneyService>), storageStub).deletePhoto(user, '7'))).toEqual({ status: 404, body: { error: 'Photo not found' } });
    expect(await new JourneyController(svc({ deletePhoto: vi.fn().mockReturnValue({ id: 7, file_path: null }) } as Partial<JourneyService>), storageStub).deletePhoto(user, '7')).toEqual({ success: true });
  });

  it('gallery upload 400 no files / 403 not allowed, else commits + returns photos', async () => {
    expect(await thrownAsync(() => new JourneyController(svc(), storageStub).uploadGalleryPhotos(user, '3', undefined))).toEqual({ status: 400, body: { error: 'No files uploaded' } });
    expect(await thrownAsync(() => new JourneyController(svc({ uploadGalleryPhotos: vi.fn().mockReturnValue([]) } as Partial<JourneyService>), storageStub).uploadGalleryPhotos(user, '3', [{ filename: 'a.jpg' } as Express.Multer.File]))).toEqual({ status: 403, body: { error: 'Not allowed' } });
    expect(await new JourneyController(svc({ uploadGalleryPhotos: vi.fn().mockReturnValue([{ id: 1 }]) } as Partial<JourneyService>), storageStub).uploadGalleryPhotos(user, '3', [{ filename: 'a.jpg' } as Express.Multer.File])).toEqual({ photos: [{ id: 1 }] });
    expect(storageStub.put).toHaveBeenCalledWith('journey', 'a.jpg', { tmpPath: undefined });
  });

  it('gallery video: 400 no video, 403 not allowed, else stores the clip + poster (#823)', async () => {
    const files = { video: [{ filename: 'v.mp4' } as Express.Multer.File], poster: [{ filename: 'p.jpg' } as Express.Multer.File] };
    expect(await thrownAsync(() => new JourneyController(svc(), storageStub).uploadGalleryVideo(user, '3', {}, {}))).toEqual({ status: 400, body: { error: 'No video uploaded' } });
    // Not-allowed after commit → the final objects are deleted through storage
    // (the pre-commit unlink would miss them: file.path is already consumed).
    const withPaths = { video: [{ filename: 'v.mp4', path: '/nonexistent/v.mp4' } as Express.Multer.File], poster: [{ filename: 'p.jpg', path: '/nonexistent/p.jpg' } as Express.Multer.File] };
    expect(await thrownAsync(() => new JourneyController(svc({ uploadGalleryPhotos: vi.fn().mockReturnValue([]) } as Partial<JourneyService>), storageStub).uploadGalleryVideo(user, '3', withPaths, { duration_ms: 'abc' }))).toEqual({ status: 403, body: { error: 'Not allowed' } });
    expect(storageStub.delete).toHaveBeenCalledWith('journey', 'v.mp4');
    expect(storageStub.delete).toHaveBeenCalledWith('journey', 'p.jpg');
    const up = vi.fn().mockReturnValue([{ id: 7 }]);
    expect(await new JourneyController(svc({ uploadGalleryPhotos: up } as Partial<JourneyService>), storageStub).uploadGalleryVideo(user, '3', files, { duration_ms: '4200' })).toEqual({ photos: [{ id: 7 }] });
    expect(up).toHaveBeenCalledWith(3, 1, [{ path: 'journey/v.mp4', thumbnail: 'journey/p.jpg', mediaType: 'video', durationMs: 4200 }]);

    // No poster + no duration → thumbnail undefined, durationMs null.
    const up2 = vi.fn().mockReturnValue([{ id: 8 }]);
    await new JourneyController(svc({ uploadGalleryPhotos: up2 } as Partial<JourneyService>), storageStub).uploadGalleryVideo(user, '3', { video: [{ filename: 'v2.mp4' } as Express.Multer.File] }, {});
    expect(up2).toHaveBeenCalledWith(3, 1, [{ path: 'journey/v2.mp4', thumbnail: undefined, mediaType: 'video', durationMs: null }]);
  });

  it('provider-photos forwards per-asset media_types for gallery and entries (#823)', () => {
    const add = vi.fn().mockReturnValue({ id: 1 });
    new JourneyController(svc({ addProviderPhotoToGallery: add } as Partial<JourneyService>), storageStub).galleryProviderPhotos(user, '9', { provider: 'immich', asset_ids: ['a', 'b'], media_types: ['video', 'image'] });
    expect(add).toHaveBeenNthCalledWith(1, 9, 1, 'immich', 'a', undefined, undefined, 'video');
    expect(add).toHaveBeenNthCalledWith(2, 9, 1, 'immich', 'b', undefined, undefined, 'image');
    const addOne = vi.fn().mockReturnValue({ id: 2 });
    new JourneyController(svc({ addProviderPhotoToGallery: addOne } as Partial<JourneyService>), storageStub).galleryProviderPhotos(user, '9', { provider: 'immich', asset_id: 'c', media_type: 'video' });
    expect(addOne).toHaveBeenCalledWith(9, 1, 'immich', 'c', undefined, undefined, 'video');

    // Entry path mirrors the gallery path.
    const eAdd = vi.fn().mockReturnValue({ id: 3 });
    new JourneyController(svc({ addProviderPhoto: eAdd } as Partial<JourneyService>), storageStub).providerPhotos(user, '4', { provider: 'immich', asset_ids: ['x'], media_types: ['video'], caption: 'c' });
    expect(eAdd).toHaveBeenNthCalledWith(1, 4, 1, 'immich', 'x', 'c', undefined, 'video');
    const eOne = vi.fn().mockReturnValue({ id: 4 });
    new JourneyController(svc({ addProviderPhoto: eOne } as Partial<JourneyService>), storageStub).providerPhotos(user, '4', { provider: 'immich', asset_id: 'y', media_type: 'video' });
    expect(eOne).toHaveBeenCalledWith(4, 1, 'immich', 'y', undefined, undefined, 'video');
  });

  it('GET/PATCH/DELETE /:id map 404', () => {
    expect(thrown(() => new JourneyController(svc({ getJourneyFull: vi.fn().mockReturnValue(null) } as Partial<JourneyService>), storageStub).get(user, '9'))).toEqual({ status: 404, body: { error: 'Journey not found' } });
    expect(new JourneyController(svc({ getJourneyFull: vi.fn().mockReturnValue({ id: 9 }) } as Partial<JourneyService>), storageStub).get(user, '9')).toEqual({ id: 9 });
    expect(thrown(() => new JourneyController(svc({ updateJourney: vi.fn().mockReturnValue(null) } as Partial<JourneyService>), storageStub).update(user, '9', {}))).toEqual({ status: 404, body: { error: 'Journey not found' } });
    expect(thrown(() => new JourneyController(svc({ deleteJourney: vi.fn().mockReturnValue(false) } as Partial<JourneyService>), storageStub).remove(user, '9'))).toEqual({ status: 404, body: { error: 'Journey not found' } });
  });

  it('trips: POST 400 without trip_id / 403, DELETE 403', () => {
    expect(thrown(() => new JourneyController(svc(), storageStub).addTrip(user, '9', {}))).toEqual({ status: 400, body: { error: 'trip_id required' } });
    expect(thrown(() => new JourneyController(svc({ addTripToJourney: vi.fn().mockReturnValue(false) } as Partial<JourneyService>), storageStub).addTrip(user, '9', { trip_id: 2 }))).toEqual({ status: 403, body: { error: 'Not allowed' } });
    expect(new JourneyController(svc({ addTripToJourney: vi.fn().mockReturnValue(true) } as Partial<JourneyService>), storageStub).addTrip(user, '9', { trip_id: 2 })).toEqual({ success: true });
    expect(thrown(() => new JourneyController(svc({ removeTripFromJourney: vi.fn().mockReturnValue(false) } as Partial<JourneyService>), storageStub).removeTrip(user, '9', '2'))).toEqual({ status: 403, body: { error: 'Not allowed' } });
  });

  it('entries under journey: list 404, create 400/404, reorder 400/403', () => {
    expect(thrown(() => new JourneyController(svc({ listEntries: vi.fn().mockReturnValue(null) } as Partial<JourneyService>), storageStub).listEntries(user, '9'))).toEqual({ status: 404, body: { error: 'Journey not found' } });
    expect(new JourneyController(svc({ listEntries: vi.fn().mockReturnValue([{ id: 1 }]) } as Partial<JourneyService>), storageStub).listEntries(user, '9')).toEqual({ entries: [{ id: 1 }] });
    expect(thrown(() => new JourneyController(svc(), storageStub).createEntry(user, '9', {}))).toEqual({ status: 400, body: { error: 'entry_date is required' } });
    expect(thrown(() => new JourneyController(svc({ createEntry: vi.fn().mockReturnValue(null) } as Partial<JourneyService>), storageStub).createEntry(user, '9', { entry_date: '2026-01-01' }))).toEqual({ status: 404, body: { error: 'Journey not found' } });
    expect(thrown(() => new JourneyController(svc(), storageStub).reorderEntries(user, '9', { orderedIds: 'no' }))).toEqual({ status: 400, body: { error: 'orderedIds must be an array of numbers' } });
    expect(thrown(() => new JourneyController(svc({ reorderEntries: vi.fn().mockReturnValue(false) } as Partial<JourneyService>), storageStub).reorderEntries(user, '9', { orderedIds: [1, 2] }))).toEqual({ status: 403, body: { error: 'Not allowed' } });
  });

  it('contributors: add 400/403, update 403, remove 403', () => {
    expect(thrown(() => new JourneyController(svc(), storageStub).addContributor(user, '9', {}))).toEqual({ status: 400, body: { error: 'user_id required' } });
    expect(thrown(() => new JourneyController(svc({ addContributor: vi.fn().mockReturnValue(false) } as Partial<JourneyService>), storageStub).addContributor(user, '9', { user_id: 2 }))).toEqual({ status: 403, body: { error: 'Not allowed' } });
    expect(new JourneyController(svc({ addContributor: vi.fn().mockReturnValue(true) } as Partial<JourneyService>), storageStub).addContributor(user, '9', { user_id: 2 })).toEqual({ success: true });
    expect(thrown(() => new JourneyController(svc({ updateContributorRole: vi.fn().mockReturnValue(false) } as Partial<JourneyService>), storageStub).updateContributor(user, '9', '2', { role: 'editor' }))).toEqual({ status: 403, body: { error: 'Not allowed' } });
    expect(thrown(() => new JourneyController(svc({ removeContributor: vi.fn().mockReturnValue(false) } as Partial<JourneyService>), storageStub).removeContributor(user, '9', '2'))).toEqual({ status: 403, body: { error: 'Not allowed' } });
  });

  it('preferences 403, share-link get/set/delete', () => {
    expect(thrown(() => new JourneyController(svc({ updateJourneyPreferences: vi.fn().mockReturnValue(null) } as Partial<JourneyService>), storageStub).preferences(user, '9', {}))).toEqual({ status: 403, body: { error: 'Not allowed' } });
    expect(new JourneyController(svc({ getJourneyShareLink: vi.fn().mockReturnValue({ token: 'abc' }) } as Partial<JourneyService>), storageStub).getShareLink(user, '9')).toEqual({ link: { token: 'abc' } });
    expect(thrown(() => new JourneyController(svc({ createOrUpdateJourneyShareLink: vi.fn().mockReturnValue(null) } as Partial<JourneyService>), storageStub).setShareLink(user, '9', {}))).toEqual({ status: 403, body: { error: 'Not allowed' } });
    expect(new JourneyController(svc({ createOrUpdateJourneyShareLink: vi.fn().mockReturnValue({ token: 'abc' }) } as Partial<JourneyService>), storageStub).setShareLink(user, '9', { share_timeline: true })).toEqual({ token: 'abc' });
    expect(thrown(() => new JourneyController(svc({ deleteJourneyShareLink: vi.fn().mockReturnValue(false) } as Partial<JourneyService>), storageStub).deleteShareLink(user, '9'))).toEqual({ status: 403, body: { error: 'Not allowed' } });
  });

  it('entry photo upload mirrors to Immich only when opted in', async () => {
    const addPhoto = vi.fn().mockReturnValue({ id: 5 });
    const uploadToImmich = vi.fn().mockResolvedValue('immich-1');
    const setPhotoProvider = vi.fn();
    const s = svc({ addPhoto, immichAutoUploadEnabled: vi.fn().mockReturnValue(true), uploadToImmich, setPhotoProvider } as Partial<JourneyService>);
    const res = await new JourneyController(s, storageStub).uploadEntryPhotos(user, '3', [{ filename: 'a.jpg', originalname: 'a.jpg' } as Express.Multer.File], {});
    expect(setPhotoProvider).toHaveBeenCalledWith(5, 'immich', 'immich-1', 1);
    expect(res).toEqual({ photos: [{ id: 5, provider: 'immich', asset_id: 'immich-1', owner_id: 1 }] });

    const noOptIn = svc({ addPhoto: vi.fn().mockReturnValue({ id: 6 }), immichAutoUploadEnabled: vi.fn().mockReturnValue(false), uploadToImmich } as Partial<JourneyService>);
    await new JourneyController(noOptIn, storageStub).uploadEntryPhotos(user, '3', [{ filename: 'b.jpg', originalname: 'b.jpg' } as Express.Multer.File], {});
    expect(uploadToImmich).toHaveBeenCalledTimes(1); // only the opted-in upload above
  });

  it('entry photo upload: 400 no files, 403 when nothing added, swallows immich errors and empty ids', async () => {
    expect(await thrownAsync(() => new JourneyController(svc(), storageStub).uploadEntryPhotos(user, '3', undefined, {}))).toEqual({ status: 400, body: { error: 'No files uploaded' } });
    expect(await thrownAsync(() => new JourneyController(svc({ addPhoto: vi.fn().mockReturnValue(null) } as Partial<JourneyService>), storageStub).uploadEntryPhotos(user, '3', [{ filename: 'a.jpg', originalname: 'a.jpg' } as Express.Multer.File], {}))).toEqual({ status: 403, body: { error: 'Not allowed' } });

    // opted in but the immich upload throws → best-effort, the local photo still wins
    const setPhotoProvider = vi.fn();
    const blowsUp = svc({ addPhoto: vi.fn().mockReturnValue({ id: 8 }), immichAutoUploadEnabled: vi.fn().mockReturnValue(true), uploadToImmich: vi.fn().mockRejectedValue(new Error('immich down')), setPhotoProvider } as Partial<JourneyService>);
    expect(await new JourneyController(blowsUp, storageStub).uploadEntryPhotos(user, '3', [{ filename: 'a.jpg', originalname: 'a.jpg' } as Express.Multer.File], { caption: 'c' })).toEqual({ photos: [{ id: 8 }] });
    expect(setPhotoProvider).not.toHaveBeenCalled();

    // opted in but immich returns a falsy id → no provider stamping
    const noId = svc({ addPhoto: vi.fn().mockReturnValue({ id: 9 }), immichAutoUploadEnabled: vi.fn().mockReturnValue(true), uploadToImmich: vi.fn().mockResolvedValue(''), setPhotoProvider } as Partial<JourneyService>);
    expect(await new JourneyController(noId, storageStub).uploadEntryPhotos(user, '3', [{ filename: 'a.jpg', originalname: 'a.jpg' } as Express.Multer.File], {})).toEqual({ photos: [{ id: 9 }] });
  });

  it('provider-photos batch passes the passphrase through when present', () => {
    const addProviderPhoto = vi.fn().mockReturnValue({ id: 1 });
    new JourneyController(svc({ addProviderPhoto } as Partial<JourneyService>), storageStub).providerPhotos(user, '3', { provider: 'immich', asset_ids: ['a'], caption: 'cap', passphrase: 'secret' });
    expect(addProviderPhoto).toHaveBeenCalledWith(3, 1, 'immich', 'a', 'cap', 'secret', 'image');
    // single-photo success path
    expect(new JourneyController(svc({ addProviderPhoto: vi.fn().mockReturnValue({ id: 2 }) } as Partial<JourneyService>), storageStub).providerPhotos(user, '3', { provider: 'immich', asset_id: 'a' })).toEqual({ id: 2 });
  });

  it('PATCH photos: 404 then returns the updated photo', () => {
    expect(thrown(() => new JourneyController(svc({ updatePhoto: vi.fn().mockReturnValue(null) } as Partial<JourneyService>), storageStub).updatePhoto(user, '7', { caption: 'x' }))).toEqual({ status: 404, body: { error: 'Photo not found' } });
    expect(new JourneyController(svc({ updatePhoto: vi.fn().mockReturnValue({ id: 7 }) } as Partial<JourneyService>), storageStub).updatePhoto(user, '7', { caption: 'x' })).toEqual({ id: 7 });
  });

  it('DELETE photo removes the storage object when a path exists', async () => {
    expect(await new JourneyController(svc({ deletePhoto: vi.fn().mockReturnValue({ id: 7, file_path: 'journey/a.jpg' }) } as Partial<JourneyService>), storageStub).deletePhoto(user, '7')).toEqual({ success: true });
    expect(storageStub.delete).toHaveBeenCalledWith('journey', 'a.jpg');
    // ...and the derived thumb goes with it (spec fix #2).
    expect(storageStub.delete).toHaveBeenCalledWith('journey', journeyThumbName('journey/a.jpg'));
    // a vanished object is swallowed
    (storageStub.delete as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('ENOENT'));
    expect(await new JourneyController(svc({ deletePhoto: vi.fn().mockReturnValue({ id: 8, file_path: 'journey/b.jpg' }) } as Partial<JourneyService>), storageStub).deletePhoto(user, '8')).toEqual({ success: true });
    // a file_path outside the journey category never reaches storage
    (storageStub.delete as ReturnType<typeof vi.fn>).mockClear();
    expect(await new JourneyController(svc({ deletePhoto: vi.fn().mockReturnValue({ id: 9, file_path: 'elsewhere/x.jpg' }) } as Partial<JourneyService>), storageStub).deletePhoto(user, '9')).toEqual({ success: true });
    expect(storageStub.delete).not.toHaveBeenCalled();
  });

  it('gallery provider-photos: batch (with passphrase), single 400/403, success', () => {
    const addProviderPhotoToGallery = vi.fn().mockReturnValue({ id: 1 });
    const batch = new JourneyController(svc({ addProviderPhotoToGallery } as Partial<JourneyService>), storageStub);
    expect(batch.galleryProviderPhotos(user, '9', { provider: 'immich', asset_ids: ['a', 'b'], passphrase: 'pw' })).toEqual({ photos: [{ id: 1 }, { id: 1 }], added: 2 });
    expect(addProviderPhotoToGallery).toHaveBeenCalledWith(9, 1, 'immich', 'a', undefined, 'pw', 'image');
    expect(thrown(() => new JourneyController(svc(), storageStub).galleryProviderPhotos(user, '9', { provider: 'immich' }))).toEqual({ status: 400, body: { error: 'provider and asset_id required' } });
    expect(thrown(() => new JourneyController(svc({ addProviderPhotoToGallery: vi.fn().mockReturnValue(null) } as Partial<JourneyService>), storageStub).galleryProviderPhotos(user, '9', { provider: 'immich', asset_id: 'a' }))).toEqual({ status: 403, body: { error: 'Not allowed or duplicate' } });
    expect(new JourneyController(svc({ addProviderPhotoToGallery: vi.fn().mockReturnValue({ id: 3 }) } as Partial<JourneyService>), storageStub).galleryProviderPhotos(user, '9', { provider: 'immich', asset_id: 'a' })).toEqual({ id: 3 });
  });

  it('DELETE gallery photo: 404, then removes the object when present', async () => {
    expect(await thrownAsync(() => new JourneyController(svc({ deleteGalleryPhoto: vi.fn().mockReturnValue(null) } as Partial<JourneyService>), storageStub).deleteGalleryPhoto(user, '7'))).toEqual({ status: 404, body: { error: 'Photo not found or not allowed' } });
    // no file_path → nothing to delete, returns void
    expect(await new JourneyController(svc({ deleteGalleryPhoto: vi.fn().mockReturnValue({ id: 7, file_path: null }) } as Partial<JourneyService>), storageStub).deleteGalleryPhoto(user, '7')).toBeUndefined();
    await new JourneyController(svc({ deleteGalleryPhoto: vi.fn().mockReturnValue({ id: 8, file_path: 'journey/g.jpg' }) } as Partial<JourneyService>), storageStub).deleteGalleryPhoto(user, '8');
    expect(storageStub.delete).toHaveBeenCalledWith('journey', 'g.jpg');
    expect(storageStub.delete).toHaveBeenCalledWith('journey', journeyThumbName('journey/g.jpg'));
    (storageStub.delete as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('ENOENT'));
    expect(await new JourneyController(svc({ deleteGalleryPhoto: vi.fn().mockReturnValue({ id: 9, file_path: 'journey/h.jpg' }) } as Partial<JourneyService>), storageStub).deleteGalleryPhoto(user, '9')).toBeUndefined();
  });

  it('DELETE gallery video also reclaims its uploaded poster (spec fix #2 extension)', async () => {
    (storageStub.delete as ReturnType<typeof vi.fn>).mockClear();
    await new JourneyController(
      svc({ deleteGalleryPhoto: vi.fn().mockReturnValue({ id: 10, file_path: 'journey/clip.mp4', thumbnail_path: 'journey/poster.jpg' }) } as Partial<JourneyService>),
      storageStub,
    ).deleteGalleryPhoto(user, '10');
    expect(storageStub.delete).toHaveBeenCalledWith('journey', 'clip.mp4');
    expect(storageStub.delete).toHaveBeenCalledWith('journey', journeyThumbName('journey/clip.mp4'));
    expect(storageStub.delete).toHaveBeenCalledWith('journey', 'poster.jpg');
  });

  it('PATCH /:id returns the updated journey on success', () => {
    expect(new JourneyController(svc({ updateJourney: vi.fn().mockReturnValue({ id: 9 }) } as Partial<JourneyService>), storageStub).update(user, '9', { title: 'x' })).toEqual({ id: 9 });
  });

  it('cover upload: 400 without file, 404 when the journey is gone, else commits + returns the journey', async () => {
    expect(await thrownAsync(() => new JourneyController(svc(), storageStub).cover(user, '9', undefined))).toEqual({ status: 400, body: { error: 'No file uploaded' } });
    expect(await thrownAsync(() => new JourneyController(svc({ updateJourney: vi.fn().mockReturnValue(null) } as Partial<JourneyService>), storageStub).cover(user, '9', { filename: 'c.jpg' } as Express.Multer.File))).toEqual({ status: 404, body: { error: 'Journey not found' } });
    const updateJourney = vi.fn().mockReturnValue({ id: 9, cover_image: 'journey/c.jpg' });
    expect(await new JourneyController(svc({ updateJourney } as Partial<JourneyService>), storageStub).cover(user, '9', { filename: 'c.jpg' } as Express.Multer.File)).toEqual({ id: 9, cover_image: 'journey/c.jpg' });
    expect(storageStub.put).toHaveBeenCalledWith('journey', 'c.jpg', { tmpPath: undefined });
    expect(updateJourney).toHaveBeenCalledWith(9, 1, { cover_image: 'journey/c.jpg' });
  });

  it('DELETE /:id and trips/contributors success paths', () => {
    expect(new JourneyController(svc({ deleteJourney: vi.fn().mockReturnValue(true) } as Partial<JourneyService>), storageStub).remove(user, '9')).toEqual({ success: true });
    expect(new JourneyController(svc({ removeTripFromJourney: vi.fn().mockReturnValue(true) } as Partial<JourneyService>), storageStub).removeTrip(user, '9', '2')).toEqual({ success: true });
    expect(new JourneyController(svc({ updateContributorRole: vi.fn().mockReturnValue(true) } as Partial<JourneyService>), storageStub).updateContributor(user, '9', '2', { role: 'editor' })).toEqual({ success: true });
    expect(new JourneyController(svc({ removeContributor: vi.fn().mockReturnValue(true) } as Partial<JourneyService>), storageStub).removeContributor(user, '9', '2')).toEqual({ success: true });
  });

  it('addContributor defaults the role to viewer when omitted', () => {
    const addContributor = vi.fn().mockReturnValue(true);
    new JourneyController(svc({ addContributor } as Partial<JourneyService>), storageStub).addContributor(user, '9', { user_id: 2 });
    expect(addContributor).toHaveBeenCalledWith(9, 1, 2, 'viewer');
  });

  it('createEntry returns the entry when the journey exists', () => {
    expect(new JourneyController(svc({ createEntry: vi.fn().mockReturnValue({ id: 4 }) } as Partial<JourneyService>), storageStub).createEntry(user, '9', { entry_date: '2026-01-01' })).toEqual({ id: 4 });
  });

  it('reorderEntries succeeds for a numeric array', () => {
    expect(new JourneyController(svc({ reorderEntries: vi.fn().mockReturnValue(true) } as Partial<JourneyService>), storageStub).reorderEntries(user, '9', { orderedIds: [3, 1, 2] })).toEqual({ success: true });
  });

  it('preferences returns the result on success', () => {
    expect(new JourneyController(svc({ updateJourneyPreferences: vi.fn().mockReturnValue({ ok: true }) } as Partial<JourneyService>), storageStub).preferences(user, '9', { theme: 'dark' })).toEqual({ ok: true });
  });

  it('deleteShareLink returns success when removed', () => {
    expect(new JourneyController(svc({ deleteJourneyShareLink: vi.fn().mockReturnValue(true) } as Partial<JourneyService>), storageStub).deleteShareLink(user, '9')).toEqual({ success: true });
  });
});

describe('JourneyPublicController', () => {
  it('GET /:token 404 / json', () => {
    expect(thrown(() => new JourneyPublicController(svc({ getPublicJourney: vi.fn().mockReturnValue(null) } as Partial<JourneyService>), storageStub).get('tok'))).toEqual({ status: 404, body: { error: 'Not found' } });
    expect(new JourneyPublicController(svc({ getPublicJourney: vi.fn().mockReturnValue({ id: 1 }) } as Partial<JourneyService>), storageStub).get('tok')).toEqual({ id: 1 });
  });

  it('photo proxy 404 on invalid token, else streams', async () => {
    expect(await thrownAsync(() => new JourneyPublicController(svc({ validateShareTokenForPhoto: vi.fn().mockReturnValue(null) } as Partial<JourneyService>), storageStub).photo('tok', '7', 'thumbnail', {} as Response))).toEqual({ status: 404, body: { error: 'Not found' } });
    const streamPhoto = vi.fn().mockResolvedValue(undefined);
    const s = svc({ validateShareTokenForPhoto: vi.fn().mockReturnValue({ ownerId: 2 }), streamPhoto } as Partial<JourneyService>);
    await new JourneyPublicController(s, storageStub).photo('tok', '7', 'original', {} as Response);
    expect(streamPhoto).toHaveBeenCalledWith({}, 2, 7, 'original');
  });

  it('legacy photo proxy: 404 invalid token, immich path streams', async () => {
    expect(await thrownAsync(() => new JourneyPublicController(svc({ validateShareTokenForAsset: vi.fn().mockReturnValue(null) } as Partial<JourneyService>), storageStub).legacyPhoto('tok', 'immich', 'a1', '2', 'thumbnail', {} as Response))).toEqual({ status: 404, body: { error: 'Not found' } });
    // One call for every provider now, with the ids in a ref instead of in a
    // per-provider argument order.
    const streamProviderAsset = vi.fn().mockResolvedValue(undefined);
    const s = svc({ validateShareTokenForAsset: vi.fn().mockReturnValue({ ownerId: 5 }), streamProviderAsset } as Partial<JourneyService>);
    await new JourneyPublicController(s, storageStub).legacyPhoto('tok', 'immich', 'a1', '2', 'original', {} as Response);
    expect(streamProviderAsset).toHaveBeenCalledWith({}, 'immich', { userId: 5, ownerId: 5, assetId: 'a1' }, 'original');
  });

  it('photo proxy streams thumbnails too', async () => {
    const streamPhoto = vi.fn().mockResolvedValue(undefined);
    const s = svc({ validateShareTokenForPhoto: vi.fn().mockReturnValue({ ownerId: 3 }), streamPhoto } as Partial<JourneyService>);
    await new JourneyPublicController(s, storageStub).photo('tok', '7', 'thumbnail', {} as Response);
    expect(streamPhoto).toHaveBeenCalledWith({}, 3, 7, 'thumbnail');
  });

  it('legacy photo proxy: synology streams, and a failure becomes a 404 json', async () => {
    const streamProviderAsset = vi.fn().mockResolvedValue(undefined);
    const s = svc({ validateShareTokenForAsset: vi.fn().mockReturnValue({ ownerId: 5 }), streamProviderAsset } as Partial<JourneyService>);
    await new JourneyPublicController(s, storageStub).legacyPhoto('tok', 'synologyphotos', 'a1', '2', 'thumbnail', {} as Response);
    expect(streamProviderAsset).toHaveBeenCalledWith({}, 'synologyphotos', { userId: 5, ownerId: 5, assetId: 'a1' }, 'thumbnail');

    const status = vi.fn().mockReturnThis();
    const json = vi.fn();
    const res = { status, json } as unknown as Response;
    const failing = svc({ validateShareTokenForAsset: vi.fn().mockReturnValue({ ownerId: 0 }), streamProviderAsset: vi.fn().mockRejectedValue(new Error('no synology')) } as Partial<JourneyService>);
    await new JourneyPublicController(failing, storageStub).legacyPhoto('tok', 'synologyphotos', 'a1', '6', 'original', res);
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({ error: 'Provider not supported' });
  });

  it('legacy photo proxy: an unregistered provider 404s instead of being handed to synology', async () => {
    // The old if/else sent everything that was not immich to synology, which
    // 404'd from inside its own id parser. The registry can tell "no such
    // backend" apart from "that backend failed".
    const streamProviderAsset = vi.fn().mockReturnValue(null);
    const status = vi.fn().mockReturnThis();
    const json = vi.fn();
    const res = { status, json } as unknown as Response;
    const s = svc({ validateShareTokenForAsset: vi.fn().mockReturnValue({ ownerId: 5 }), streamProviderAsset } as Partial<JourneyService>);
    await new JourneyPublicController(s, storageStub).legacyPhoto('tok', 'photoprism', 'a1', '2', 'original', res);
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({ error: 'Provider not supported' });
  });

  it('legacy photo proxy: falls back to the path ownerId when the token has none', async () => {
    const streamProviderAsset = vi.fn().mockResolvedValue(undefined);
    const s = svc({ validateShareTokenForAsset: vi.fn().mockReturnValue({ ownerId: 0 }), streamProviderAsset } as Partial<JourneyService>);
    await new JourneyPublicController(s, storageStub).legacyPhoto('tok', 'immich', 'a1', '8', 'original', {} as Response);
    expect(streamProviderAsset).toHaveBeenCalledWith({}, 'immich', { userId: 8, ownerId: 8, assetId: 'a1' }, 'original');
  });

  it('legacy photo proxy: local provider 404s when the object does not exist', async () => {
    storageExists.mockResolvedValue(false);
    const s = svc({ validateShareTokenForAsset: vi.fn().mockReturnValue({ ownerId: 5 }) } as Partial<JourneyService>);
    expect(await thrownAsync(() => new JourneyPublicController(s, storageStub).legacyPhoto('tok', 'local', 'gone.jpg', '2', 'thumbnail', {} as Response))).toEqual({ status: 404, body: { error: 'Not found' } });
    expect(storageSendToResponse).not.toHaveBeenCalled();
  });

  it('legacy photo proxy: local provider serves through storage with the day cache header', async () => {
    storageExists.mockResolvedValue(true);
    storageSendToResponse.mockResolvedValue(undefined);
    const set = vi.fn();
    const res = { set } as unknown as Response;
    const s = svc({ validateShareTokenForAsset: vi.fn().mockReturnValue({ ownerId: 5 }) } as Partial<JourneyService>);
    await new JourneyPublicController(s, storageStub).legacyPhoto('tok', 'local', 'photo.jpg', '2', 'original', res);
    expect(storageExists).toHaveBeenCalledWith('journey', 'photo.jpg');
    expect(set).toHaveBeenCalledWith('Cache-Control', 'public, max-age=86400');
    expect(storageSendToResponse).toHaveBeenCalledWith('journey', 'photo.jpg', res);
  });

  it('legacy photo proxy: local provider cannot escape uploads/journey via a traversal asset id', async () => {
    storageExists.mockResolvedValue(true);
    storageSendToResponse.mockResolvedValue(undefined);
    const res = { set: vi.fn() } as unknown as Response;
    const s = svc({ validateShareTokenForAsset: vi.fn().mockReturnValue({ ownerId: 5 }) } as Partial<JourneyService>);

    // Express decodes %2F in a single path param to '/', so the handler sees this.
    await new JourneyPublicController(s, storageStub).legacyPhoto('tok', 'local', '../../files/secret.pdf', '2', 'original', res);

    // basename() collapses the traversal before the storage lookup, and central
    // key validation (storage-keys.ts) rejects anything that still carries a
    // path — the asset can never address the sibling files/ category.
    expect(storageExists).toHaveBeenCalledWith('journey', 'secret.pdf');
    expect(storageSendToResponse).toHaveBeenCalledWith('journey', 'secret.pdf', res);
  });

  it('legacy photo proxy: a bare traversal asset id reads as a miss, not a crash', async () => {
    // '..' survives basename(); storage.exists rejects it as an invalid key,
    // which the handler reads as a miss.
    storageExists.mockRejectedValue(new Error('invalid storage key: journey/..'));
    const s = svc({ validateShareTokenForAsset: vi.fn().mockReturnValue({ ownerId: 5 }) } as Partial<JourneyService>);
    expect(await thrownAsync(() => new JourneyPublicController(s, storageStub).legacyPhoto('tok', 'local', '..', '2', 'original', {} as Response))).toEqual({ status: 404, body: { error: 'Not found' } });
    expect(storageSendToResponse).not.toHaveBeenCalled();
  });
});
