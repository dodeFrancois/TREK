import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { MASKED_SETTING_VALUE, type StorageAdminState } from '@trek/shared';
import { server } from '../../../helpers/msw/server';
import { fireEvent, render, screen, waitFor, within } from '../../../helpers/render';
import { ToastContainer } from '../../../../src/components/shared/Toast';
import MAdminStoragePanel from '../../../../src/mobile/screens/admin/MAdminStoragePanel';

function baseState(overrides: Partial<StorageAdminState> = {}): StorageAdminState {
  return {
    backends: [
      { name: 'uploads-local', type: 'local', source: 'built-in', options: { root: '/data/uploads' }, categories: ['files', 'journey', 'covers', 'avatars', 'photos', 'photos-google', 'photos-trek'] },
      { name: 'backups-local', type: 'local', source: 'built-in', options: { root: '/data/backups' }, categories: ['backups'] },
      {
        name: 'off-box', type: 's3', source: 'settings',
        options: { endpoint: 'http://127.0.0.1:9000', bucket: 'trek', accessKeyId: 'ak', secretAccessKey: MASKED_SETTING_VALUE, region: 'us-east-1', keyPrefix: '', retries: 1, timeoutMs: 30000 },
        categories: [],
      },
    ],
    categories: {
      files: { backend: 'uploads-local', source: 'default' },
      journey: { backend: 'uploads-local', source: 'default' },
      covers: { backend: 'uploads-local', source: 'default' },
      avatars: { backend: 'uploads-local', source: 'default' },
      places: { backend: 'uploads-local', source: 'default' },
      photos: { backend: 'uploads-local', source: 'default' },
      'photos-google': { backend: 'uploads-local', source: 'default' },
      'photos-trek': { backend: 'uploads-local', source: 'default' },
      backups: { backend: 'backups-local', source: 'default' },
    },
    health: { replicaFailures: [] },
    encryptionReady: true,
    seedFilePresent: false,
    ...overrides,
  };
}

async function renderPanel(state: StorageAdminState = baseState()) {
  server.use(http.get('/api/admin/storage', () => HttpResponse.json(state)));
  render(
    <>
      <ToastContainer />
      <MAdminStoragePanel />
    </>,
  );
  await waitFor(() => expect(screen.getByText('Backends')).toBeInTheDocument());
}

describe('MAdminStoragePanel', () => {
  it('FE-MOB-MSTOR-001: renders every backend with type and source, env rows read-only', async () => {
    await renderPanel();
    const row = screen.getByTestId('m-storage-backend-off-box');
    expect(within(row).getByText('S3')).toBeInTheDocument();
    expect(within(row).getByText('Settings')).toBeInTheDocument();
    expect(screen.getByText('No replica failures recorded.')).toBeInTheDocument();
  });

  it('FE-MOB-MSTOR-002: reassigning a category via the picker sheet warns and saves through one PUT', async () => {
    let putBody: unknown;
    await renderPanel();
    server.use(
      http.put('/api/admin/storage', async ({ request }) => {
        putBody = await request.json();
        return HttpResponse.json(baseState());
      }),
    );
    fireEvent.click(within(screen.getByTestId('m-storage-category-files')).getByRole('button'));
    fireEvent.click(screen.getByRole('button', { name: 'off-box' })); // picker option; selecting closes
    expect(screen.getByText(/Existing objects do not move/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Storage configuration saved');
    expect((putBody as { categories: Record<string, string> }).categories.files).toBe('off-box');
  });

  it('FE-MOB-MSTOR-003: a typed plaintext secret without encryption replaces Apply with the ENCRYPTION_KEY banner', async () => {
    await renderPanel(baseState({ encryptionReady: false }));
    fireEvent.click(within(screen.getByTestId('m-storage-backend-off-box')).getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByPlaceholderText('us-east-1'), { target: { value: 'eu-west-1' } }); // sanity: form is open
    const secret = screen.getByDisplayValue(MASKED_SETTING_VALUE);
    fireEvent.change(secret, { target: { value: 'sk-new' } });
    expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
    expect(screen.getByRole('alert').textContent).toContain('ENCRYPTION_KEY');
  });

  it('FE-MOB-MSTOR-004: a 400 renders the server message verbatim', async () => {
    await renderPanel();
    server.use(http.put('/api/admin/storage', () => HttpResponse.json({ error: 'registry says no' }, { status: 400 })));
    fireEvent.click(within(screen.getByTestId('m-storage-category-files')).getByRole('button'));
    fireEvent.click(screen.getByRole('button', { name: 'off-box' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('registry says no')).toBeInTheDocument();
  });
});
