# Admin: Storage

The **Storage** tab (Admin Panel → Storage) controls where TREK stores each
kind of content: which storage backends exist, which content category writes
to which backend, and whether writes are replicated to additional backends.
On managed/hosted instances this tab is hidden — storage is the operator's
concern.

## Backends

A backend is a named place bytes can live. Two exist out of the box:

| Backend | What it is |
|---------|------------|
| `uploads-local` | The local `uploads/` directory (the `/app/uploads` volume in Docker) |
| `backups-local` | The local `data/backups` directory |

You can **edit** a built-in to relocate its root directory, and **add**
backends of type:

- **Local** — a directory on a disk or mount reachable by the server.
- **S3** — any S3-compatible service (AWS S3, Cloudflare R2, Backblaze B2,
  Garage, MinIO/AIStor). Endpoint URL, bucket, credentials, and optionally
  region, key prefix, retries, and timeout. For self-hosted endpoints, use an
  IP address or `localhost` in the URL unless your server is configured for
  virtual-hosted bucket addressing.

If `TREK_PLACE_PHOTO_DIR` is set, a read-only `place-photos-local` backend
appears too — it is defined by that environment variable, not by this panel.

### Replication (Mirror targets)

Edit any backend and tick one or more **Mirror targets**: every write to that
backend is then also copied to each selected target. Removing all targets
turns replication off again.

- Writes go to the backend itself first (it stays the source of truth), then
  to each target in order. A slow or unreachable target slows every upload of
  every category on that backend — ideal for backups, worth weighing before
  replicating hot categories like trip documents.
- Replica failures **never fail the original request**. They are recorded and
  shown in the **Health** strip at the top of the tab, with the backend, the
  object, the operation, and how long ago it happened. An empty strip means
  every replicated write landed.
- Replication starts with the next write — objects that existed before you
  added a target are not copied to it.

### Test

Every backend row has a **Test** button: the server writes, checks, and
deletes a small probe object (`trek-probe/…`) on the backend — for a
replicated backend, on the backend itself and each target individually — and
reports per-target results. "Connection OK" means credentials, bucket, and
reachability all check out. Targets must be **saved** before Test can probe
them; a just-added, unsaved backend used as a target reports an error until
you save.

## Categories

Every kind of content TREK stores belongs to one of eight categories, each
assigned to exactly one backend:

| Category | Id | What it stores |
|----------|----|----------------|
| Trip documents | `files` | File attachments uploaded to trips — tickets, PDFs, booking confirmations, and files shared in trip chat |
| Journey photos | `journey` | Photos and thumbnails attached to journey entries |
| Cover images | `covers` | Trip and collection cover images, including covers fetched from Unsplash |
| Profile pictures | `avatars` | User account profile pictures |
| Place images | `places` | Images attached to places and collection places — uploaded or imported |
| Google photo cache | `photos-google` | Cached copies of Google Places photos — re-fetchable, safe to lose |
| TREK photo cache | `photos-trek` | Cached photos from the TREK photo service used by Memories — re-fetchable, safe to lose |
| Backups | `backups` | Server backup archives created by the Backup panel or schedule |

Reassigning a category changes where **new** objects go — existing objects do
not move and keep being served from wherever they already are. The panel
shows this warning inline when you change an assignment. Replicating the two
re-fetchable caches is possible but flagged as not recommended.

The legacy `/uploads/photos` directory written by older TREK versions is not
a category: its files are still served and included in backups, but nothing
writes there anymore and it cannot be reassigned.

## Secrets and encryption

Backend credentials (the S3 secret access key) are stored encrypted. Saving a
credentialed backend requires the `ENCRYPTION_KEY` environment variable to be
set explicitly — without it the panel shows a notice instead of the save
button. See [[Encryption Key Rotation|Encryption-Key-Rotation]] for changing
the key later. Saved secrets display as a masked placeholder; leaving the mask untouched
when editing keeps the stored value.

## Provisioning at first boot (seed file)

For scripted deployments, place a `storage-config.json` in the data directory
(in Docker: mount it at `/app/data/storage-config.json`). It is imported
exactly once — on the first boot that has no stored storage configuration —
then ignored (a log line says so). An invalid file aborts boot with the exact
validation error. Example and the compose mount line: see the
[README Storage section](https://github.com/liketrek/TREK#storage).

To reset storage configuration (or re-import a seed file): stop the server,
`sqlite3 data/travel.db "DELETE FROM app_settings WHERE key LIKE 'storage.%';"`,
start it again — it boots on the built-in defaults, or re-imports the seed
file if present.

**Restore chicken-and-egg:** backups include the storage configuration. If
your only backup lives on S3 and the credentials are inside it: start a fresh
instance, enter the S3 credentials here (or mount a seed file), then restore
from the Backup panel.

## Removed environment variables

Storage used to be configured through `TREK_S3_*` and `TREK_UPLOADS_DIR`.
These were **removed in v4** and a server started with any of them set
refuses to boot, naming each offending variable:

```
  - TREK_S3_ENDPOINT was removed — configure storage in the admin UI or data/storage-config.json.
```

Remove the variables and configure the equivalent here. `TREK_PLACE_PHOTO_DIR`
is unaffected.

## Related pages

- [[Backups|Backups]] — what a backup contains, restore procedure
- [[Environment Variables|Environment-Variables]]
- [[Encryption Key Rotation|Encryption-Key-Rotation]]
- [[Admin Panel Overview|Admin-Panel-Overview]]
- [[Troubleshooting|Troubleshooting]]
