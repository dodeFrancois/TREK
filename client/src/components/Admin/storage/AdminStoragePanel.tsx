import React, { useState } from 'react'
import { Activity, FolderTree, HardDrive } from 'lucide-react'
import { STORAGE_CATEGORIES, type StorageBackend, type StorageCategory, type StorageTestResponse } from '@trek/shared'
import { useTranslation } from '../../../i18n'
import { relativeTime } from '../../../utils/relativeTime'
import ConfirmDialog from '../../shared/ConfirmDialog'
import CustomSelect from '../../shared/CustomSelect'
import { useToast } from '../../shared/Toast'
import Section from '../../Settings/Section'
import BackendForm, { type BackendFormMirrorProps } from './BackendForm'
import {
  CACHE_CATEGORIES,
  adoptedMirrorFor,
  effectiveCategoryMap,
  foldBackends,
  primaryNameOf,
  removeBackend,
  removeBackendAndMirrors,
  renameBackendRefs,
  replicaOfPrimaries,
  setMirrorTargets,
  upsertBackend,
  type FoldedBackendRow,
} from './storageModel'
import { useStorageAdmin } from './useStorageAdmin'

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

const LINK_BUTTON_STYLE: React.CSSProperties = { background: 'none', border: 'none', cursor: 'pointer' }

export default function AdminStoragePanel(): React.ReactElement {
  const { t, locale } = useTranslation()
  const toast = useToast()
  const admin = useStorageAdmin(t('common.error'))
  const [editing, setEditing] = useState<{
    initial: StorageBackend | null
    originalName: string | null
    mirror: BackendFormMirrorProps
  } | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<{ name: string; degenerate: boolean } | null>(null)

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

  // Duplicate pre-check needs EVERY wire name (hidden mirror names included);
  // mirror-target candidates are the visible primaries only.
  const backendNames = [...new Set([...state.backends.map((b) => b.name), ...draft.backends.map((b) => b.name)])]
  const { rows, degenerate } = foldBackends(state, draft)
  const effective = effectiveCategoryMap(state, draft)

  const startEdit = (row: FoldedBackendRow) => {
    // Editing a built-in creates a settings override row bearing its name —
    // the first-class relocation path (merge-by-name).
    setEditing({
      initial: row.backend,
      originalName: row.name,
      mirror: {
        candidates: rows.filter((r) => r.name !== row.name).map((r) => r.name),
        initialTargets: row.mirrorTargets,
      },
    })
  }

  const commitBackend = (backend: StorageBackend, mirrorTargets?: string[]) => {
    const renamedFrom =
      editing?.originalName && editing.originalName !== backend.name ? editing.originalName : null
    let next = draft
    if (renamedFrom) next = renameBackendRefs(removeBackend(next, renamedFrom), renamedFrom, backend.name)
    next = upsertBackend(next, backend)
    if (mirrorTargets !== undefined) next = setMirrorTargets(state, next, backend.name, mirrorTargets)
    admin.setDraft(next)
    setEditing(null)
  }

  const removeMessage = (name: string, isDegenerate: boolean): string => {
    const row = rows.find((r) => r.name === name)
    const assigned = isDegenerate
      ? degenerate.find((d) => d.backend.name === name)?.categories ?? []
      : row?.categories ?? []
    const usedAsReplicaBy = isDegenerate ? [] : replicaOfPrimaries(draft, name)
    return [
      t('storage.remove.body', { name }),
      assigned.length > 0 ? t('storage.remove.stillAssigned', { categories: assigned.join(', ') }) : '',
      usedAsReplicaBy.length > 0 ? t('storage.remove.usedAsReplicaBy', { primaries: usedAsReplicaBy.join(', ') }) : '',
    ]
      .filter(Boolean)
      .join(' ')
  }

  const setCategory = (category: StorageCategory, primaryName: string) => {
    // Picking a mirrored primary routes through its adopted mirror silently.
    const target = adoptedMirrorFor(draft, primaryName)?.name ?? primaryName
    // The admin state's category record is exhaustive by schema contract.
    const stateEntry = state.categories[category]!
    const categories = { ...draft.categories }
    if (stateEntry.source === 'default' && target === stateEntry.backend) {
      delete categories[category] // back to the default → no longer settings-owned
    } else {
      categories[category] = target
    }
    admin.setDraft({ ...draft, categories })
  }

  const save = async () => {
    if (await admin.save()) toast.success(t('storage.saved'))
  }

  const testResultFor = (key: string): StorageTestResponse | 'running' | undefined => admin.testResults[key]

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
          {rows.map((row) => {
            const resultKey = row.mirrorName ?? row.name
            const result = testResultFor(resultKey)
            // row.mirrorName only exists when foldBackends adopted a draft mirror
            // for this row, so the draft lookup below cannot miss.
            const testCandidate = row.mirrorName
              ? draft.backends.find((b) => b.name === row.mirrorName)!
              : row.backend
            return (
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
                  <button className="text-xs underline text-content-secondary" style={LINK_BUTTON_STYLE} onClick={() => admin.test(testCandidate)}>
                    {t('storage.actions.test')}
                  </button>
                  {row.source !== 'env' && (
                    <button className="text-xs underline text-content-secondary" style={LINK_BUTTON_STYLE} onClick={() => startEdit(row)}>
                      {t('storage.actions.edit')}
                    </button>
                  )}
                  {row.source === 'settings' && (
                    <button className="text-xs underline text-content-secondary" style={LINK_BUTTON_STYLE} onClick={() => setConfirmRemove({ name: row.name, degenerate: false })}>
                      {t('storage.actions.remove')}
                    </button>
                  )}
                </div>
                <p className="text-xs mt-1 text-content-faint">
                  {row.categories.length > 0
                    ? t('storage.backends.usedBy', { categories: row.categories.join(', ') })
                    : t('storage.backends.unused')}
                </p>
                {row.mirrorTargets.length > 0 && (
                  <p className="text-xs mt-1 text-content-faint">
                    {t('storage.mirror.mirroredTo', { targets: row.mirrorTargets.join(', ') })}
                  </p>
                )}
                {row.replicaOf.length > 0 && (
                  <p className="text-xs mt-1 text-content-faint">
                    {t('storage.mirror.replicaOf', { primaries: row.replicaOf.join(', ') })}
                  </p>
                )}
                {row.source === 'env' && <p className="text-xs mt-1 text-content-faint">{t('storage.backends.envReadOnly')}</p>}
                {result === 'running' ? (
                  <p className="text-xs mt-2 text-content-faint">{t('storage.test.running')}</p>
                ) : (
                  <TestResult
                    result={result as StorageTestResponse | undefined}
                    okLabel={t('storage.test.ok')}
                    failedLabel={t('storage.test.failed')}
                  />
                )}
              </div>
            )
          })}

          {degenerate.map(({ backend, reason }) => {
            const result = testResultFor(backend.name)
            const primary = backend.type === 'mirror' ? backend.options.primary : ''
            return (
              <div key={backend.name} data-testid={`storage-backend-${backend.name}`} className="rounded-xl border p-4 border-edge-secondary">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-content">{backend.name}</span>
                  <span className="text-xs px-2 py-0.5 rounded-full border border-edge text-content-secondary">
                    {t('storage.type.mirror')}
                  </span>
                  <span className="flex-1" />
                  <button className="text-xs underline text-content-secondary" style={LINK_BUTTON_STYLE} onClick={() => admin.test(backend)}>
                    {t('storage.actions.test')}
                  </button>
                  <button className="text-xs underline text-content-secondary" style={LINK_BUTTON_STYLE} onClick={() => setConfirmRemove({ name: backend.name, degenerate: true })}>
                    {t('storage.actions.remove')}
                  </button>
                </div>
                <p className="text-xs mt-1 text-content-faint">{t(`storage.mirror.degenerate.${reason}`, { primary })}</p>
                {result === 'running' ? (
                  <p className="text-xs mt-2 text-content-faint">{t('storage.test.running')}</p>
                ) : (
                  <TestResult
                    result={result as StorageTestResponse | undefined}
                    okLabel={t('storage.test.ok')}
                    failedLabel={t('storage.test.failed')}
                  />
                )}
              </div>
            )
          })}
        </div>

        {editing ? (
          <BackendForm
            initial={editing.initial}
            backendNames={backendNames}
            encryptionReady={state.encryptionReady}
            mirror={editing.mirror}
            onCommit={commitBackend}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <button
            onClick={() =>
              setEditing({
                initial: null,
                originalName: null,
                mirror: { candidates: rows.map((r) => r.name), initialTargets: [] },
              })
            }
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
            // The admin state's category record is exhaustive by schema contract.
            const stateEntry = state.categories[category]!
            const selectedPrimary = primaryNameOf(state, draft, effective[category])
            const changed = selectedPrimary !== primaryNameOf(state, draft, stateEntry.backend)
            const viaMirror = effective[category] !== selectedPrimary
            return (
              <div key={category} data-testid={`storage-category-${category}`}>
                <label className="block text-sm font-medium mb-1.5 text-content-secondary">
                  {t(`storage.category.${category}`)}
                </label>
                <CustomSelect
                  value={selectedPrimary}
                  onChange={(value) => setCategory(category, String(value))}
                  options={rows.map((row) => ({
                    value: row.name,
                    label:
                      stateEntry.source === 'default' && row.name === stateEntry.backend
                        ? `${row.name} (${t('storage.categories.default')})`
                        : row.name,
                  }))}
                  size="sm"
                  style={{ maxWidth: 320 }}
                />
                {changed && (
                  <p role="alert" className="text-xs mt-1 text-content-faint">
                    {t('storage.categories.reassignWarning')}
                  </p>
                )}
                {viaMirror && CACHE_CATEGORIES.includes(category) && (
                  <p role="note" className="text-xs mt-1 text-content-faint">
                    {t('storage.mirror.cacheWarning')}
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
          if (confirmRemove) {
            admin.setDraft(
              confirmRemove.degenerate
                ? removeBackend(draft, confirmRemove.name)
                : removeBackendAndMirrors(state, draft, confirmRemove.name),
            )
          }
          setConfirmRemove(null)
        }}
        title={t('storage.remove.title')}
        message={confirmRemove ? removeMessage(confirmRemove.name, confirmRemove.degenerate) : ''}
        confirmLabel={t('storage.remove.title')}
      />
    </div>
  )
}
