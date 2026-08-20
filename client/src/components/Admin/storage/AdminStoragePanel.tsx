import React, { useState } from 'react'
import { Activity, FolderTree, HardDrive } from 'lucide-react'
import { STORAGE_CATEGORIES, type StorageBackend, type StorageCategory, type StorageTestResponse } from '@trek/shared'
import { useTranslation } from '../../../i18n'
import { relativeTime } from '../../../utils/relativeTime'
import ConfirmDialog from '../../shared/ConfirmDialog'
import CustomSelect from '../../shared/CustomSelect'
import { useToast } from '../../shared/Toast'
import Section from '../../Settings/Section'
import BackendForm from './BackendForm'
import {
  asWireBackend,
  categoriesPointingAt,
  mirrorsReferencing,
  removeBackend,
  upsertBackend,
  type StateBackend,
} from './storageModel'
import { useStorageAdmin } from './useStorageAdmin'

interface Row {
  name: string
  type: StorageBackend['type']
  source: 'built-in' | 'env' | 'settings'
  backend: StorageBackend
  categories: readonly string[]
}

function TestResult({ result, failedLabel, okLabel }: {
  result: StorageTestResponse | undefined
  failedLabel: string
  okLabel: string
}): React.ReactElement | null {
  if (result === undefined) return null
  return (
    <div className="mt-2 space-y-0.5">
      <p className="text-xs font-semibold text-content">{result.ok ? okLabel : failedLabel}</p>
      {result.targets.map((target) => (
        <p key={target.name} className="text-xs text-content-faint">
          {target.ok ? '✓' : '✗'} {target.name}
          {target.error ? ` — ${target.error}` : ''}
        </p>
      ))}
    </div>
  )
}

export default function AdminStoragePanel(): React.ReactElement {
  const { t, locale } = useTranslation()
  const toast = useToast()
  const admin = useStorageAdmin(t('common.error'))
  const [editing, setEditing] = useState<{ initial: StorageBackend | null; originalName: string | null } | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)

  if (admin.loading) {
    return <p className="text-sm italic p-4 text-content-faint">{t('storage.loading')}</p>
  }
  if (!admin.state || !admin.draft) {
    return (
      <div role="alert" className="rounded-xl border p-4 text-sm border-edge bg-surface-card text-content">
        {admin.loadError || t('common.error')}
      </div>
    )
  }
  const { state, draft } = admin

  const draftNames = draft.backends.map((b) => b.name)
  const backendNames = [...new Set([...state.backends.map((b) => b.name), ...draftNames])]

  // The list shows the DRAFT world: built-ins/env from the state (unless a
  // draft row overrides the name), settings rows from the draft (unsaved
  // edits, additions and removals included).
  const stateByName = new Map(state.backends.map((b) => [b.name, b]))
  const rows: Row[] = []
  for (const b of state.backends) {
    if (draftNames.includes(b.name)) continue // the draft copy renders below
    if (b.source === 'settings') continue // removed from the draft, pending save
    rows.push({ name: b.name, type: b.type, source: b.source, backend: asWireBackend(b), categories: b.categories })
  }
  for (const b of draft.backends) {
    const inState = stateByName.get(b.name) as StateBackend | undefined
    rows.push({
      name: b.name,
      type: b.type,
      source: 'settings',
      backend: b,
      categories: inState?.categories ?? categoriesPointingAt(draft, b.name),
    })
  }

  const startEdit = (row: Row) => {
    // Editing a built-in creates a settings override row bearing its name —
    // the first-class relocation path (merge-by-name).
    setEditing({ initial: row.backend, originalName: row.name })
  }

  const commitBackend = (backend: StorageBackend) => {
    const renamedFrom =
      editing?.originalName && editing.originalName !== backend.name ? editing.originalName : null
    const base = renamedFrom ? removeBackend(draft, renamedFrom) : draft
    admin.setDraft(upsertBackend(base, backend))
    setEditing(null)
  }

  const removeMessage = (name: string): string => {
    const assigned = categoriesPointingAt(draft, name)
    const mirrors = mirrorsReferencing(draft, name)
    return [
      t('storage.remove.body', { name }),
      assigned.length > 0 ? t('storage.remove.stillAssigned', { categories: assigned.join(', ') }) : '',
      mirrors.length > 0 ? t('storage.remove.referencedBy', { backends: mirrors.join(', ') }) : '',
    ]
      .filter(Boolean)
      .join(' ')
  }

  const setCategory = (category: StorageCategory, backendName: string) => {
    const effective = state.categories[category]!
    // Exhaustive record: storageAdminStateSchema's `categories` maps all nine
    // STORAGE_CATEGORIES entries (server-enforced), so this index is total.
    const categories = { ...draft.categories }
    if (effective.source === 'default' && backendName === effective.backend) {
      delete categories[category] // back to the default → no longer settings-owned
    } else {
      categories[category] = backendName
    }
    admin.setDraft({ ...draft, categories })
  }

  const save = async () => {
    if (await admin.save()) toast.success(t('storage.saved'))
  }

  return (
    <div>
      <Section title={t('storage.health.title')} icon={Activity}>
        {state.health.replicaFailures.length === 0 ? (
          <p className="text-sm text-content-faint">{t('storage.health.allClear')}</p>
        ) : (
          <ul className="space-y-1">
            {state.health.replicaFailures.map((failure) => (
              <li key={`${failure.backend}-${failure.key}-${failure.at}`} className="text-sm text-content">
                {t('storage.health.failureLine', {
                  op: failure.op,
                  key: failure.key,
                  backend: failure.backend,
                  error: failure.error,
                })}
                <span className="text-content-faint"> · {relativeTime(failure.at, locale)}</span>
              </li>
            ))}
          </ul>
        )}
        {state.seedFilePresent && <p className="text-xs mt-2 text-content-faint">{t('storage.health.seedFile')}</p>}
      </Section>

      <Section title={t('storage.backends.title')} icon={HardDrive}>
        <p className="text-sm text-content-faint" style={{ marginTop: -8 }}>{t('storage.description')}</p>
        <div className="space-y-3">
          {rows.map((row) => (
            <div key={row.name} data-testid={`storage-backend-${row.name}`} className="rounded-xl border p-4 border-edge-secondary">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-semibold text-content">{row.name}</span>
                <span className="text-xs px-2 py-0.5 rounded-full border border-edge text-content-secondary">
                  {t(`storage.type.${row.type}`)}
                </span>
                <span className="text-xs px-2 py-0.5 rounded-full border border-edge text-content-faint">
                  {t(`storage.source.${row.source}`)}
                </span>
                <span className="flex-1" />
                <button className="text-xs underline text-content-secondary" style={{ background: 'none', border: 'none', cursor: 'pointer' }} onClick={() => admin.test(row.backend)}>
                  {t('storage.actions.test')}
                </button>
                {row.source !== 'env' && (
                  <button className="text-xs underline text-content-secondary" style={{ background: 'none', border: 'none', cursor: 'pointer' }} onClick={() => startEdit(row)}>
                    {t('storage.actions.edit')}
                  </button>
                )}
                {row.source === 'settings' && (
                  <button className="text-xs underline text-content-secondary" style={{ background: 'none', border: 'none', cursor: 'pointer' }} onClick={() => setConfirmRemove(row.name)}>
                    {t('storage.actions.remove')}
                  </button>
                )}
              </div>
              <p className="text-xs mt-1 text-content-faint">
                {row.categories.length > 0
                  ? t('storage.backends.usedBy', { categories: row.categories.join(', ') })
                  : t('storage.backends.unused')}
              </p>
              {row.source === 'env' && <p className="text-xs mt-1 text-content-faint">{t('storage.backends.envReadOnly')}</p>}
              {admin.testResults[row.name] === 'running' ? (
                <p className="text-xs mt-2 text-content-faint">{t('storage.test.running')}</p>
              ) : (
                <TestResult
                  result={admin.testResults[row.name] as StorageTestResponse | undefined}
                  okLabel={t('storage.test.ok')}
                  failedLabel={t('storage.test.failed')}
                />
              )}
            </div>
          ))}
        </div>

        {editing ? (
          <BackendForm
            initial={editing.initial}
            backendNames={backendNames}
            encryptionReady={state.encryptionReady}
            onCommit={commitBackend}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <button
            onClick={() => setEditing({ initial: null, originalName: null })}
            style={{
              padding: '8px 20px', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit',
              fontSize: 'calc(14px * var(--fs-scale-body, 1))', fontWeight: 500,
              border: '2px solid var(--border-primary)', background: 'var(--bg-card)', color: 'var(--text-primary)',
            }}
          >
            {t('storage.backends.add')}
          </button>
        )}
      </Section>

      <Section title={t('storage.categories.title')} icon={FolderTree}>
        <div className="space-y-4">
          {STORAGE_CATEGORIES.map((category) => {
            const effective = state.categories[category]!
            // Exhaustive record — see the setCategory comment above.
            const selected = draft.categories[category] ?? effective.backend
            const changed = selected !== effective.backend
            return (
              <div key={category} data-testid={`storage-category-${category}`}>
                <label className="block text-sm font-medium mb-1.5 text-content-secondary">
                  {t(`storage.category.${category}`)}
                </label>
                <CustomSelect
                  value={selected}
                  onChange={(value) => setCategory(category, String(value))}
                  options={backendNames.map((name) => ({
                    value: name,
                    label:
                      effective.source === 'default' && name === effective.backend
                        ? `${name} (${t('storage.categories.default')})`
                        : name,
                  }))}
                  size="sm"
                  style={{ maxWidth: 320 }}
                />
                {changed && (
                  <p role="alert" className="text-xs mt-1 text-content-faint">
                    {t('storage.categories.reassignWarning')}
                  </p>
                )}
              </div>
            )
          })}
        </div>
      </Section>

      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={!admin.dirty || admin.saving}
          style={{
            padding: '10px 20px', borderRadius: 10, cursor: admin.dirty && !admin.saving ? 'pointer' : 'default',
            fontFamily: 'inherit', fontSize: 'calc(14px * var(--fs-scale-body, 1))', fontWeight: 600,
            border: '2px solid var(--text-primary)', background: 'var(--bg-hover)', color: 'var(--text-primary)',
            opacity: admin.dirty && !admin.saving ? 1 : 0.5,
          }}
        >
          {t('storage.save')}
        </button>
        {admin.dirty && <span className="text-xs text-content-faint">{t('storage.unsaved')}</span>}
      </div>
      {admin.saveError && (
        <p role="alert" className="text-sm mt-2 text-content">
          {admin.saveError}
        </p>
      )}

      <ConfirmDialog
        isOpen={confirmRemove !== null}
        onClose={() => setConfirmRemove(null)}
        onConfirm={() => {
          if (confirmRemove) admin.setDraft(removeBackend(draft, confirmRemove))
          setConfirmRemove(null)
        }}
        title={t('storage.remove.title')}
        message={confirmRemove ? removeMessage(confirmRemove) : ''}
        confirmLabel={t('storage.remove.title')}
      />
    </div>
  )
}
