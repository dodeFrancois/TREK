import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpException,
  Param,
  Patch,
  Post,
  Put,
  UploadedFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor, FileFieldsInterceptor } from '@nestjs/platform-express';
import type { Options } from 'multer';
import type { Request } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import type { User } from '../../types';
import { StorageService } from '../storage/storage.service';
import { journeyThumbName } from '../memories/thumbnail.service';
import { JourneyService } from './journey.service';
import { PhotoCaptureBackfillService } from '../memories/photo-capture-backfill.service';
import { AddonGuard } from '../addons/addon.guard';
import { RequireAddon } from '../addons/require-addon.decorator';
import { ADDON_IDS } from '../../addons';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import {
  JourneyAddTripDto, JourneyContributorAddDto, JourneyContributorUpdateDto, JourneyCreateDto,
  JourneyEntryCreateDto, JourneyEntryPhotoUploadDto, JourneyEntryUpdateDto, JourneyGalleryVideoDto,
  JourneyLinkPhotoDto, JourneyPhotoUpdateDto, JourneyPreferencesDto, JourneyProviderPhotosDto,
  JourneyReorderEntriesDto, JourneyShareLinkDto, JourneyUpdateDto,
} from './journey.dto';
import { isVideoMime, isVideoExtension, MAX_VIDEO_SIZE } from '../files/files.constants';
import { AllowedFileTypesService } from '../files/allowed-file-types.service';

/**
 * One filename hook for all four journey upload routes (consumed by
 * journey.module.ts's storage-upload factory). Field routing is exact: the
 * image routes only ever admit 'photos'/'cover' fields and the video route
 * only 'video'/'poster' — any other part dies in multer with
 * LIMIT_UNEXPECTED_FILE before this hook runs.
 */
export const journeyUploadFilename = (_req: Request, file: Express.Multer.File): string => {
  // The poster is ALWAYS stored as .jpg, never the client-supplied extension:
  // otherwise a poster declared image/* but named x.html / x.js would land on
  // disk with that extension and be served inline same-origin (stored XSS,
  // reachable via the public share proxy). The video extension is validated by
  // the fileFilter, so it is safe to keep.
  const ext =
    file.fieldname === 'poster' ? '.jpg'
    : file.fieldname === 'video' ? (path.extname(file.originalname).toLowerCase() || '.mp4')
    : (path.extname(file.originalname).toLowerCase() || '.jpg');
  return `${crypto.randomUUID()}${ext}`;
};

/**
 * Journey image upload filter, built from the container.
 *
 * Same reason as the trip-file factory: it reads the operator's
 * allowed-extension list at request time. The module's multer options carry NO
 * defParamCharset, unlike the trip-file ones; that difference is deliberate
 * and predates the move.
 */
export function journeyImageFileFilter(allowedTypes: AllowedFileTypesService): Options['fileFilter'] {
  return (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/') || file.mimetype.includes('svg')) {
      const err: Error & { statusCode?: number } = new Error('Only image files are allowed');
      err.statusCode = 400;
      return cb(err);
    }
    const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
    const allowed = allowedTypes.get().split(',').map((e) => e.trim().toLowerCase());
    if (!allowed.includes('*') && !allowed.includes(ext)) {
      const err: Error & { statusCode?: number } = new Error(`File type .${ext} is not allowed`);
      err.statusCode = 400;
      return cb(err);
    }
    cb(null, true);
  };
}

// Gallery video upload (#823): one video plus an optional client-captured poster
// image, written to the same uploads/journey store. Larger cap than images since
// phone clips are big; videos are stored as-is and streamed with HTTP Range.
// Passed inline on the video route; the storage engine (spool destination +
// journeyUploadFilename) is inherited from the module options via the
// interceptor's shallow merge.
const VIDEO_FILE_FILTER: Options['fileFilter'] = (_req, file, cb) => {
  const reject = (msg: string) => {
    const err: Error & { statusCode?: number } = new Error(msg);
    err.statusCode = 400;
    cb(err);
  };
  if (file.fieldname === 'poster') {
    if (!file.mimetype.startsWith('image/') || file.mimetype.includes('svg')) return reject('Poster must be an image');
    return cb(null, true);
  }
  // 'video' field
  const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
  if (!isVideoMime(file.mimetype)) return reject('Only video files are allowed');
  if (!isVideoExtension(ext)) return reject(`Video type .${ext} is not allowed`);
  cb(null, true);
};

/**
 * /api/journeys — cross-trip travel narrative (journeys, entries, photo gallery
 * + provider mirroring, contributors, preferences, share links).
 *
 * Byte-identical to the legacy Express route (server/src/routes/journey.ts):
 * the Journey-addon gate (404) runs before auth, the service owns access
 * control (null/false → 403/404), create routes answer 201 while cover/trips/
 * share-link/reorder/patch answer 200 and the two unlink/gallery-delete routes
 * answer 204. Static prefixes (/suggestions, /available-trips, /entries, /photos)
 * are declared before /:id so they win over the param.
 */
@Controller('api/journeys')
@UseGuards(AddonGuard, JwtAuthGuard)
@RequireAddon(ADDON_IDS.JOURNEY, 'Journey')
export class JourneyController {
  constructor(
    private readonly journey: JourneyService,
    private readonly storage: StorageService,
    private readonly captureBackfill: PhotoCaptureBackfillService,
  ) {}

  /**
   * Commit spooled multer files to their final uploads/journey location. On any
   * failure: best-effort removal of both spool leftovers and already-committed
   * names, then rethrow (500) — so a DB row never references a missing file.
   */
  private async commitJourneyUploads(files: Express.Multer.File[]): Promise<void> {
    try {
      for (const f of files) await this.storage.put('journey', f.filename, { tmpPath: f.path });
    } catch (err) {
      for (const f of files) {
        if (f.path) { try { fs.unlinkSync(f.path); } catch { /* best-effort */ } }
      }
      for (const f of files) {
        await this.storage.delete('journey', f.filename).catch(() => {});
      }
      throw err;
    }
  }

  // The add call carries only an asset id, so when and where the picture was taken
  // are fetched from the provider afterwards rather than trusted from the client
  // (#1614). Detached: a slow or unreachable provider must not hold up the add.
  private backfillCapture(photos: unknown[], userId: number): void {
    const ids = photos
      .map(p => (p as { photo_id?: number } | null)?.photo_id)
      .filter((id): id is number => typeof id === 'number');
    this.captureBackfill.schedule(ids, userId);
  }

  // ── Static prefix routes (before /:id) ──────────────────────────────────
  @Get()
  list(@CurrentUser() user: User) {
    return { journeys: this.journey.listJourneys(user.id) };
  }

  @Post()
  create(@CurrentUser() user: User, @Body() body: JourneyCreateDto) {
    if (!body.title || typeof body.title !== 'string' || !body.title.trim()) {
      throw new HttpException({ error: 'Title is required' }, 400);
    }
    return this.journey.createJourney(user.id, {
      // The guard three lines up proved both of these; the schema stays
      // permissive so that guard keeps answering, not the pipe.
      title: (body.title as string).trim(),
      subtitle: body.subtitle as string | undefined,
      trip_ids: Array.isArray(body.trip_ids) ? body.trip_ids.map(Number) : [],
    });
  }

  @Get('suggestions')
  suggestions(@CurrentUser() user: User) {
    return { trips: this.journey.getSuggestions(user.id) };
  }

  @Get('available-trips')
  availableTrips(@CurrentUser() user: User) {
    return { trips: this.journey.listUserTrips(user.id) };
  }

  // ── Entries (prefix /entries — before /:id) ─────────────────────────────
  @Patch('entries/:entryId')
  updateEntry(@CurrentUser() user: User, @Param('entryId') entryId: string, @Body() body: JourneyEntryUpdateDto, @Headers('x-socket-id') socketId?: string) {
    const result = this.journey.updateEntry(Number(entryId), user.id, body, socketId);
    if (!result) {
      throw new HttpException({ error: 'Entry not found' }, 404);
    }
    return result;
  }

  @Delete('entries/:entryId')
  deleteEntry(@CurrentUser() user: User, @Param('entryId') entryId: string, @Headers('x-socket-id') socketId?: string) {
    if (!this.journey.deleteEntry(Number(entryId), user.id, socketId)) {
      throw new HttpException({ error: 'Entry not found' }, 404);
    }
    return { success: true };
  }

  @Post('entries/:entryId/photos')
  @UseInterceptors(FilesInterceptor('photos'))
  async uploadEntryPhotos(@CurrentUser() user: User, @Param('entryId') entryId: string, @UploadedFiles() files: Express.Multer.File[] | undefined, @Body() body: JourneyEntryPhotoUploadDto) {
    if (!files?.length) {
      throw new HttpException({ error: 'No files uploaded' }, 400);
    }
    // Commit to final storage BEFORE the addPhoto loop: the Immich mirror below
    // reads each file at its final uploads/journey path.
    await this.commitJourneyUploads(files);
    const results: unknown[] = [];
    for (const file of files) {
      const relativePath = `journey/${file.filename}`;
      const photo = this.journey.addPhoto(Number(entryId), user.id, relativePath, undefined, body?.caption as string | undefined);
      if (!photo) continue;
      // Mirror to Immich only when the user explicitly opted in (#730).
      if (this.journey.immichAutoUploadEnabled(user.id)) {
        try {
          const immichId = await this.journey.uploadToImmich(user.id, relativePath, file.originalname);
          if (immichId) {
            this.journey.setPhotoProvider(photo.id, 'immich', immichId, user.id);
            Object.assign(photo, { provider: 'immich', asset_id: immichId, owner_id: user.id });
          }
        } catch {
          // best-effort mirror; the local photo is already saved
        }
      }
      results.push(photo);
    }
    if (!results.length) {
      throw new HttpException({ error: 'Not allowed' }, 403);
    }
    this.backfillCapture(results, user.id);
    return { photos: results };
  }

  @Post('entries/:entryId/provider-photos')
  providerPhotos(@CurrentUser() user: User, @Param('entryId') entryId: string, @Body() body: JourneyProviderPhotosDto) {
    const pp = body.passphrase && typeof body.passphrase === 'string' ? body.passphrase : undefined;
    if (Array.isArray(body.asset_ids) && body.provider) {
      const added: unknown[] = [];
      body.asset_ids.forEach((id, i) => {
        const mt = Array.isArray(body.media_types) && body.media_types[i] === 'video' ? 'video' : 'image';
        const photo = this.journey.addProviderPhoto(Number(entryId), user.id, String(body.provider), String(id), body.caption as string | undefined, pp, mt);
        if (photo) added.push(photo);
      });
      this.backfillCapture(added, user.id);
      return { photos: added, added: added.length };
    }
    if (!body.provider || !body.asset_id) {
      throw new HttpException({ error: 'provider and asset_id required' }, 400);
    }
    const photo = this.journey.addProviderPhoto(Number(entryId), user.id, String(body.provider), String(body.asset_id), body.caption as string | undefined, pp, body.media_type === 'video' ? 'video' : 'image');
    if (!photo) {
      throw new HttpException({ error: 'Not allowed or duplicate' }, 403);
    }
    this.backfillCapture([photo], user.id);
    return photo;
  }

  @Post('entries/:entryId/link-photo')
  linkPhoto(@CurrentUser() user: User, @Param('entryId') entryId: string, @Body() body: JourneyLinkPhotoDto) {
    const journeyPhotoId = body.journey_photo_id ?? body.photo_id;
    if (!journeyPhotoId) {
      throw new HttpException({ error: 'journey_photo_id required' }, 400);
    }
    const result = this.journey.linkPhotoToEntry(Number(entryId), Number(journeyPhotoId), user.id);
    if (!result) {
      throw new HttpException({ error: 'Not allowed' }, 403);
    }
    return result;
  }

  @Delete('entries/:entryId/photos/:journeyPhotoId')
  @HttpCode(204)
  unlinkPhoto(@CurrentUser() user: User, @Param('entryId') entryId: string, @Param('journeyPhotoId') journeyPhotoId: string): void {
    if (!this.journey.unlinkPhotoFromEntry(Number(entryId), Number(journeyPhotoId), user.id)) {
      throw new HttpException({ error: 'Not found or not allowed' }, 404);
    }
  }

  @Patch('photos/:photoId')
  updatePhoto(@CurrentUser() user: User, @Param('photoId') photoId: string, @Body() body: JourneyPhotoUpdateDto) {
    const result = this.journey.updatePhoto(Number(photoId), user.id, body);
    if (!result) {
      throw new HttpException({ error: 'Photo not found' }, 404);
    }
    return result;
  }

  @Delete('photos/:photoId')
  async deletePhoto(@CurrentUser() user: User, @Param('photoId') photoId: string) {
    const photo = this.journey.deletePhoto(Number(photoId), user.id);
    if (!photo) {
      throw new HttpException({ error: 'Photo not found' }, 404);
    }
    await this.deletePhotoObject(photo.file_path);
    await this.reclaimDerived(photo.file_path, photo.thumbnail_path);
    return { success: true };
  }

  /**
   * Best-effort removal of a deleted photo's bytes. file_path rows are the
   * uploads-relative 'journey/<file>' form every writer stores; anything else
   * (provider rows have null) has no local object.
   */
  private async deletePhotoObject(filePath: string | null | undefined): Promise<void> {
    if (!filePath) return;
    const name = filePath.startsWith('journey/') ? filePath.slice('journey/'.length) : null;
    if (!name) return;
    await this.storage.delete('journey', name).catch(() => { /* file already gone */ });
  }

  /**
   * Delete a photo's derived artifacts with it (spec In-scope fix #2): the
   * hash-named thumbnail derivable from file_path, and whatever
   * thumbnail_path recorded — a generated thumb (usually the same object) or
   * a video's uploaded poster. Both best-effort, both idempotent.
   */
  private async reclaimDerived(filePath: string | null | undefined, thumbnailPath: string | null | undefined): Promise<void> {
    if (filePath?.startsWith('journey/')) {
      await this.storage.delete('journey', journeyThumbName(filePath)).catch(() => { /* already gone */ });
    }
    if (thumbnailPath?.startsWith('journey/')) {
      await this.storage.delete('journey', thumbnailPath.slice('journey/'.length)).catch(() => { /* already gone */ });
    }
  }

  // ── Gallery (prefix /:id/gallery — before /:id) ─────────────────────────
  @Post(':id/gallery/photos')
  @UseInterceptors(FilesInterceptor('photos'))
  async uploadGalleryPhotos(@CurrentUser() user: User, @Param('id') id: string, @UploadedFiles() files: Express.Multer.File[] | undefined) {
    if (!files?.length) {
      throw new HttpException({ error: 'No files uploaded' }, 400);
    }
    await this.commitJourneyUploads(files);
    const filePaths = files.map((f) => ({ path: `journey/${f.filename}` }));
    const photos = this.journey.uploadGalleryPhotos(Number(id), user.id, filePaths);
    if (!photos.length) {
      throw new HttpException({ error: 'Not allowed' }, 403);
    }
    // An uploaded file carries its own EXIF; reading it is what puts the photo on
    // the map later. Detached, like the provider branch.
    this.backfillCapture(photos, user.id);
    return { photos };
  }

  @Post(':id/gallery/video')
  @UseInterceptors(FileFieldsInterceptor(
    [{ name: 'video', maxCount: 1 }, { name: 'poster', maxCount: 1 }],
    // Inherits the module's storage engine (spool + journeyUploadFilename) via
    // the interceptor's shallow options merge; overrides only cap and filter.
    { limits: { fileSize: MAX_VIDEO_SIZE }, fileFilter: VIDEO_FILE_FILTER },
  ))
  async uploadGalleryVideo(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @UploadedFiles() files: { video?: Express.Multer.File[]; poster?: Express.Multer.File[] } | undefined,
    @Body() body: JourneyGalleryVideoDto,
  ) {
    const video = files?.video?.[0];
    const poster = files?.poster?.[0];
    // multer already spooled both parts; clean them up on a pre-commit rejection
    // so a bad POST doesn't orphan a 500 MB clip (#823).
    const cleanup = () => {
      for (const f of [video, poster]) {
        if (f?.path) { try { fs.unlinkSync(f.path); } catch { /* best-effort */ } }
      }
    };
    if (!video) {
      cleanup();
      throw new HttpException({ error: 'No video uploaded' }, 400);
    }
    await this.commitJourneyUploads(poster ? [video, poster] : [video]);
    const durationMs = body?.duration_ms != null ? Number(body.duration_ms) : null;
    const photos = this.journey.uploadGalleryPhotos(Number(id), user.id, [{
      path: `journey/${video.filename}`,
      thumbnail: poster ? `journey/${poster.filename}` : undefined,
      mediaType: 'video',
      durationMs: durationMs != null && Number.isFinite(durationMs) ? durationMs : null,
    }]);
    if (!photos.length) {
      // The parts are already committed (file.path is consumed), so the
      // pre-commit unlink cleanup would silently orphan them — delete the
      // final objects instead. Same observable outcome as before: bytes gone.
      await this.storage.delete('journey', video.filename).catch(() => {});
      if (poster) await this.storage.delete('journey', poster.filename).catch(() => {});
      throw new HttpException({ error: 'Not allowed' }, 403);
    }
    return { photos };
  }

  @Post(':id/gallery/provider-photos')
  galleryProviderPhotos(@CurrentUser() user: User, @Param('id') id: string, @Body() body: JourneyProviderPhotosDto) {
    const pp = body.passphrase && typeof body.passphrase === 'string' ? body.passphrase : undefined;
    if (Array.isArray(body.asset_ids) && body.provider) {
      const added: unknown[] = [];
      body.asset_ids.forEach((aid, i) => {
        const mt = Array.isArray(body.media_types) && body.media_types[i] === 'video' ? 'video' : 'image';
        const photo = this.journey.addProviderPhotoToGallery(Number(id), user.id, String(body.provider), String(aid), undefined, pp, mt);
        if (photo) added.push(photo);
      });
      this.backfillCapture(added, user.id);
      return { photos: added, added: added.length };
    }
    if (!body.provider || !body.asset_id) {
      throw new HttpException({ error: 'provider and asset_id required' }, 400);
    }
    const photo = this.journey.addProviderPhotoToGallery(Number(id), user.id, String(body.provider), String(body.asset_id), undefined, pp, body.media_type === 'video' ? 'video' : 'image');
    if (!photo) {
      throw new HttpException({ error: 'Not allowed or duplicate' }, 403);
    }
    this.backfillCapture([photo], user.id);
    return photo;
  }

  @Delete(':id/gallery/:journeyPhotoId')
  @HttpCode(204)
  async deleteGalleryPhoto(@CurrentUser() user: User, @Param('journeyPhotoId') journeyPhotoId: string): Promise<void> {
    const photo = this.journey.deleteGalleryPhoto(Number(journeyPhotoId), user.id);
    if (!photo) {
      throw new HttpException({ error: 'Photo not found or not allowed' }, 404);
    }
    await this.deletePhotoObject(photo.file_path);
    await this.reclaimDerived(photo.file_path, photo.thumbnail_path);
  }

  // ── Journeys /:id ───────────────────────────────────────────────────────
  @Get(':id')
  get(@CurrentUser() user: User, @Param('id') id: string) {
    const data = this.journey.getJourneyFull(Number(id), user.id);
    if (!data) {
      throw new HttpException({ error: 'Journey not found' }, 404);
    }
    return data;
  }

  @Patch(':id')
  update(@CurrentUser() user: User, @Param('id') id: string, @Body() body: JourneyUpdateDto) {
    const result = this.journey.updateJourney(Number(id), user.id, body);
    if (!result) {
      throw new HttpException({ error: 'Journey not found' }, 404);
    }
    return result;
  }

  @Post(':id/cover')
  @HttpCode(200) // Express answers cover with res.json (200).
  @UseInterceptors(FileInterceptor('cover'))
  async cover(@CurrentUser() user: User, @Param('id') id: string, @UploadedFile() file: Express.Multer.File | undefined) {
    if (!file) {
      throw new HttpException({ error: 'No file uploaded' }, 400);
    }
    await this.commitJourneyUploads([file]);
    const result = this.journey.updateJourney(Number(id), user.id, { cover_image: `journey/${file.filename}` });
    if (!result) {
      throw new HttpException({ error: 'Journey not found' }, 404);
    }
    return result;
  }

  @Delete(':id')
  remove(@CurrentUser() user: User, @Param('id') id: string) {
    if (!this.journey.deleteJourney(Number(id), user.id)) {
      throw new HttpException({ error: 'Journey not found' }, 404);
    }
    return { success: true };
  }

  // ── Journey trips ───────────────────────────────────────────────────────
  @Post(':id/trips')
  @HttpCode(200) // Express answers with res.json (200).
  addTrip(@CurrentUser() user: User, @Param('id') id: string, @Body() body: JourneyAddTripDto) {
    if (!body.trip_id) {
      throw new HttpException({ error: 'trip_id required' }, 400);
    }
    if (!this.journey.addTripToJourney(Number(id), Number(body.trip_id), user.id)) {
      throw new HttpException({ error: 'Not allowed' }, 403);
    }
    return { success: true };
  }

  @Delete(':id/trips/:tripId')
  removeTrip(@CurrentUser() user: User, @Param('id') id: string, @Param('tripId') tripId: string) {
    if (!this.journey.removeTripFromJourney(Number(id), Number(tripId), user.id)) {
      throw new HttpException({ error: 'Not allowed' }, 403);
    }
    return { success: true };
  }

  // ── Entries under journey ───────────────────────────────────────────────
  @Get(':id/entries')
  listEntries(@CurrentUser() user: User, @Param('id') id: string) {
    const entries = this.journey.listEntries(Number(id), user.id);
    if (!entries) {
      throw new HttpException({ error: 'Journey not found' }, 404);
    }
    return { entries };
  }

  /**
   * The GPX tracks drawn on this journey's map (#1260). Read-only and derived: the
   * geometries belong to the trips the entries came from, so uploading a GPX in the
   * planner is all it takes for it to show up here.
   */
  @Get(':id/tracks')
  listTracks(@CurrentUser() user: User, @Param('id') id: string) {
    const tracks = this.journey.journeyTracks(Number(id), user.id);
    if (!tracks) {
      throw new HttpException({ error: 'Journey not found' }, 404);
    }
    return { tracks };
  }

  @Post(':id/entries')
  createEntry(@CurrentUser() user: User, @Param('id') id: string, @Body() body: JourneyEntryCreateDto, @Headers('x-socket-id') socketId?: string) {
    if (!body.entry_date) {
      throw new HttpException({ error: 'entry_date is required' }, 400);
    }
    const entry = this.journey.createEntry(Number(id), user.id, body, socketId);
    if (!entry) {
      throw new HttpException({ error: 'Journey not found' }, 404);
    }
    return entry;
  }

  @Put(':id/entries/reorder')
  reorderEntries(@CurrentUser() user: User, @Param('id') id: string, @Body() body: JourneyReorderEntriesDto, @Headers('x-socket-id') socketId?: string) {
    const orderedIds = body.orderedIds;
    if (!Array.isArray(orderedIds) || !orderedIds.every((v) => Number.isFinite(Number(v)))) {
      throw new HttpException({ error: 'orderedIds must be an array of numbers' }, 400);
    }
    if (!this.journey.reorderEntries(Number(id), user.id, orderedIds.map(Number), socketId)) {
      throw new HttpException({ error: 'Not allowed' }, 403);
    }
    return { success: true };
  }

  // ── Contributors ────────────────────────────────────────────────────────
  @Post(':id/contributors')
  addContributor(@CurrentUser() user: User, @Param('id') id: string, @Body() body: JourneyContributorAddDto) {
    if (!body.user_id) {
      throw new HttpException({ error: 'user_id required' }, 400);
    }
    if (!this.journey.addContributor(Number(id), user.id, Number(body.user_id), (body.role as 'editor' | 'viewer') || 'viewer')) {
      throw new HttpException({ error: 'Not allowed' }, 403);
    }
    return { success: true };
  }

  @Patch(':id/contributors/:userId')
  updateContributor(@CurrentUser() user: User, @Param('id') id: string, @Param('userId') userId: string, @Body() body: JourneyContributorUpdateDto) {
    if (!this.journey.updateContributorRole(Number(id), user.id, Number(userId), body.role as 'editor' | 'viewer')) {
      throw new HttpException({ error: 'Not allowed' }, 403);
    }
    return { success: true };
  }

  @Delete(':id/contributors/:userId')
  removeContributor(@CurrentUser() user: User, @Param('id') id: string, @Param('userId') userId: string) {
    if (!this.journey.removeContributor(Number(id), user.id, Number(userId))) {
      throw new HttpException({ error: 'Not allowed' }, 403);
    }
    return { success: true };
  }

  // ── User Preferences ────────────────────────────────────────────────────
  @Patch(':id/preferences')
  preferences(@CurrentUser() user: User, @Param('id') id: string, @Body() body: JourneyPreferencesDto) {
    const result = this.journey.updateJourneyPreferences(Number(id), user.id, body);
    if (!result) {
      throw new HttpException({ error: 'Not allowed' }, 403);
    }
    return result;
  }

  // ── Share Link ──────────────────────────────────────────────────────────
  @Get(':id/share-link')
  getShareLink(@CurrentUser() user: User, @Param('id') id: string) {
    return { link: this.journey.getJourneyShareLink(Number(id), user.id) };
  }

  @Post(':id/share-link')
  @HttpCode(200) // Express answers with res.json (200).
  setShareLink(@CurrentUser() user: User, @Param('id') id: string, @Body() body: JourneyShareLinkDto) {
    const result = this.journey.createOrUpdateJourneyShareLink(Number(id), user.id, {
      share_timeline: body.share_timeline as boolean | undefined,
      share_gallery: body.share_gallery as boolean | undefined,
      share_map: body.share_map as boolean | undefined,
    });
    if (!result) {
      throw new HttpException({ error: 'Not allowed' }, 403);
    }
    return result;
  }

  @Delete(':id/share-link')
  deleteShareLink(@CurrentUser() user: User, @Param('id') id: string) {
    if (!this.journey.deleteJourneyShareLink(Number(id), user.id)) {
      throw new HttpException({ error: 'Not allowed' }, 403);
    }
    return { success: true };
  }
}
