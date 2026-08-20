import type { TranslationStrings } from '../types';

const storage: TranslationStrings = {
  // Field labels/help — these keys are pinned by STORAGE_BACKEND_TYPES in
  // @trek/shared (labelKey/helpKey); renaming one breaks the admin form.
  'storage.field.root': 'Root directory',
  'storage.help.root': 'Absolute path on the server where this backend stores its objects.',
  'storage.field.endpoint': 'Endpoint URL',
  'storage.help.endpoint':
    'Base URL of the S3-compatible service, e.g. https://s3.example.com or http://127.0.0.1:9000.',
  'storage.field.bucket': 'Bucket',
  'storage.field.accessKeyId': 'Access key ID',
  'storage.field.secretAccessKey': 'Secret access key',
  'storage.field.region': 'Region',
  'storage.help.region': 'Keep the default unless your provider requires a specific region.',
  'storage.field.keyPrefix': 'Key prefix',
  'storage.help.keyPrefix': 'Optional prefix added to every object key, e.g. trek/prod.',
  'storage.field.retries': 'Retries',
  'storage.field.timeoutMs': 'Timeout (ms)',
  'storage.field.primary': 'Primary backend',
  'storage.field.replicas': 'Replicas',

  // Panel chrome
  'storage.title': 'Storage',
  'storage.description': 'Where TREK keeps uploaded files, photos and backups. Nothing changes until you save.',
  'storage.loading': 'Loading…',
  'storage.saved': 'Storage configuration saved',
  'storage.save': 'Save changes',
  'storage.unsaved': 'Unsaved changes',

  // Backends list
  'storage.backends.title': 'Backends',
  'storage.backends.add': 'Add backend',
  'storage.backends.usedBy': 'Used by: {categories}',
  'storage.backends.unused': 'Not assigned to any category',
  'storage.backends.envReadOnly': 'Defined by an environment variable — read-only',
  'storage.source.built-in': 'Built-in',
  'storage.source.env': 'Environment',
  'storage.source.settings': 'Settings',
  'storage.type.local': 'Local',
  'storage.type.s3': 'S3',
  'storage.type.mirror': 'Mirror',
  'storage.actions.test': 'Test',
  'storage.actions.edit': 'Edit',
  'storage.actions.remove': 'Remove',

  // Test-connection results
  'storage.test.running': 'Testing…',
  'storage.test.ok': 'Connection OK',
  'storage.test.failed': 'Test failed',

  // Remove pre-check (friendly message; the server stays authoritative)
  'storage.remove.title': 'Remove backend',
  'storage.remove.body':
    'Remove {name} from the configuration? The server rejects the save if anything still depends on it.',
  'storage.remove.stillAssigned': 'Still assigned to: {categories}',
  'storage.remove.referencedBy': 'Referenced by mirror: {backends}',

  // Backend form
  'storage.form.addTitle': 'Add backend',
  'storage.form.editTitle': 'Edit backend',
  'storage.form.name': 'Name',
  'storage.form.type': 'Type',
  'storage.form.apply': 'Apply',
  'storage.form.cancel': 'Cancel',
  'storage.form.duplicateName': 'A backend named {name} already exists',
  'storage.form.encryptionBanner':
    'ENCRYPTION_KEY is not set on the server. Set it explicitly to save credentialed storage backends — saving is disabled while a plaintext secret is present.',

  // Category map
  'storage.categories.title': 'Categories',
  'storage.categories.default': 'default',
  'storage.categories.reassignWarning':
    'Existing objects do not move: new objects go to the newly assigned backend, old ones stay where they are.',
  'storage.category.files': 'Files',
  'storage.category.journey': 'Journey',
  'storage.category.covers': 'Trip covers',
  'storage.category.avatars': 'Avatars',
  'storage.category.places': 'Place images',
  'storage.category.photos': 'Photos',
  'storage.category.photos-google': 'Google photo cache',
  'storage.category.photos-trek': 'TREK photos',
  'storage.category.backups': 'Backups',

  // Health strip
  'storage.health.title': 'Health',
  'storage.health.allClear': 'No replica failures recorded.',
  'storage.health.seedFile':
    'A storage-config.json seed file is present but ignored — configuration rows already exist. Manage storage here.',
  'storage.health.failureLine': '{op} of {key} on {backend} failed: {error}',
};
export default storage;
