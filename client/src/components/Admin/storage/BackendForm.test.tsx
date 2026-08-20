import { describe, expect, it, vi } from 'vitest';
import { MASKED_SETTING_VALUE, type StorageBackend } from '@trek/shared';
import { fireEvent, render, screen } from '../../../../tests/helpers/render';
import BackendForm from './BackendForm';

const NAMES = ['uploads-local', 'backups-local', 'off-box'];

type FormProps = Parameters<typeof BackendForm>[0];

function renderForm(overrides: Partial<FormProps> = {}) {
  const onCommit = vi.fn();
  const onCancel = vi.fn();
  render(
    <BackendForm
      initial={null}
      backendNames={NAMES}
      encryptionReady
      onCommit={onCommit}
      onCancel={onCancel}
      {...overrides}
    />,
  );
  return { onCommit, onCancel };
}

const S3_INITIAL: StorageBackend = {
  name: 'off-box',
  type: 's3',
  options: {
    endpoint: 'http://127.0.0.1:9000', bucket: 'trek', accessKeyId: 'ak',
    secretAccessKey: MASKED_SETTING_VALUE, region: 'us-east-1', keyPrefix: '', retries: 1, timeoutMs: 30000,
  },
};

describe('BackendForm', () => {
  it('FE-ADMIN-STORF-001: local renders the root path field from the registry', () => {
    renderForm();
    expect(screen.getByLabelText(/Root directory/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Bucket/)).not.toBeInTheDocument();
  });

  it('FE-ADMIN-STORF-002: s3 renders every field by kind — password secret, number inputs, defaultValue placeholders', () => {
    renderForm({ initial: S3_INITIAL });
    expect(screen.getByLabelText(/Endpoint URL/)).toHaveAttribute('type', 'text');
    expect(screen.getByLabelText(/Secret access key/)).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText(/Region/)).toHaveAttribute('placeholder', 'us-east-1');
    expect(screen.getByLabelText(/Retries/)).toHaveAttribute('type', 'number');
    expect(screen.getByLabelText(/Retries/)).toHaveAttribute('placeholder', '1');
    expect(screen.getByLabelText(/Timeout \(ms\)/)).toHaveAttribute('placeholder', '30000');
  });

  it('FE-ADMIN-STORF-003: mirror renders the composer — primary select and replica checkboxes over the other backends', () => {
    renderForm({
      initial: { name: 'mir', type: 'mirror', options: { primary: 'uploads-local', replicas: ['off-box'] } },
    });
    // The composer is just the two ref kinds rendering: a select and checkboxes.
    expect(screen.getByText(/Primary backend/)).toBeInTheDocument();
    const replicas = screen.getAllByRole('checkbox');
    // Own name excluded: uploads-local, backups-local, off-box minus 'mir' (not in NAMES anyway) → 3
    expect(replicas).toHaveLength(3);
    expect(screen.getByRole('checkbox', { name: 'off-box' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'backups-local' })).not.toBeChecked();
  });

  it('FE-ADMIN-STORF-004: the mask echoes back through commit untouched (no-op by contract)', () => {
    const { onCommit } = renderForm({ initial: S3_INITIAL });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'off-box',
        type: 's3',
        options: expect.objectContaining({ secretAccessKey: MASKED_SETTING_VALUE, retries: 1, timeoutMs: 30000 }),
      }),
    );
  });

  it('FE-ADMIN-STORF-005: a typed plaintext secret with encryption not ready replaces Apply with the ENCRYPTION_KEY banner', () => {
    renderForm({ initial: S3_INITIAL, encryptionReady: false });
    // The untouched mask is fine — Apply still offered.
    expect(screen.getByRole('button', { name: 'Apply' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Secret access key/), { target: { value: 'sk-new' } });
    expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
    expect(screen.getByRole('alert').textContent).toContain('ENCRYPTION_KEY');
  });

  it('FE-ADMIN-STORF-006: Apply stays disabled until name and every required field are filled', () => {
    const { onCommit } = renderForm();
    const apply = screen.getByRole('button', { name: 'Apply' });
    expect(apply).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'nas' } });
    expect(apply).toBeDisabled(); // root still empty
    fireEvent.change(screen.getByLabelText(/Root directory/), { target: { value: '/mnt/nas' } });
    expect(apply).toBeEnabled();
    fireEvent.click(apply);
    expect(onCommit).toHaveBeenCalledWith({ name: 'nas', type: 'local', options: { root: '/mnt/nas' } });
  });

  it('FE-ADMIN-STORF-007: a duplicate name on a NEW backend warns and blocks Apply', () => {
    renderForm();
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'off-box' } });
    fireEvent.change(screen.getByLabelText(/Root directory/), { target: { value: '/x' } });
    expect(screen.getByText(/A backend named off-box already exists/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
  });

  it('FE-ADMIN-STORF-008: empty optional fields are omitted so the shared schema defaults apply', () => {
    const { onCommit } = renderForm();
    // Switch to s3 via the type select (CustomSelect renders options into a portal).
    fireEvent.click(screen.getByText('Local'));
    fireEvent.click(screen.getByText('S3'));
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'fresh' } });
    fireEvent.change(screen.getByLabelText(/Endpoint URL/), { target: { value: 'http://127.0.0.1:9000' } });
    fireEvent.change(screen.getByLabelText(/Bucket/), { target: { value: 'trek' } });
    fireEvent.change(screen.getByLabelText(/Access key ID/), { target: { value: 'ak' } });
    fireEvent.change(screen.getByLabelText(/Secret access key/), { target: { value: 'sk' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    const committed = onCommit.mock.calls[0]![0] as StorageBackend;
    expect(committed.options).toEqual({
      endpoint: 'http://127.0.0.1:9000', bucket: 'trek', accessKeyId: 'ak', secretAccessKey: 'sk',
    });
    expect(committed.options).not.toHaveProperty('region');
  });

  it('FE-ADMIN-STORF-009: renaming onto another existing backend warns and blocks Apply', () => {
    renderForm({ initial: S3_INITIAL });
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'uploads-local' } });
    expect(screen.getByText(/A backend named uploads-local already exists/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    // Keeping the original name stays allowed.
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'off-box' } });
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();
  });
});
