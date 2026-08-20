import React, { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import {
  STORAGE_BACKEND_TYPES,
  STORAGE_BACKEND_TYPE_IDS,
  STORAGE_CATEGORIES,
  type StorageBackend,
  type StorageBackendFieldDef,
  type StorageBackendTypeId,
  type StorageCategory,
} from '@trek/shared'
import { useTranslation } from '../../../i18n'
import { useToast } from '../../../components/shared/Toast'
import { relativeTime } from '../../../utils/relativeTime'
import {
  CACHE_CATEGORIES,
  adoptedMirrorFor,
  effectiveCategoryMap,
  foldBackends,
  hasPlaintextSecret,
  primaryNameOf,
  removeBackend,
  removeBackendAndMirrors,
  renameBackendRefs,
  replicaOfPrimaries,
  setMirrorTargets,
  upsertBackend,
  type FoldedBackendRow,
} from '../../../components/Admin/storage/storageModel'
import { useStorageAdmin } from '../../../components/Admin/storage/useStorageAdmin'
import MToggle from '../../components/MToggle'
import MSetPickerSheet from '../settings/MSetPickerSheet'
import MConfirmSheet from '../settings/MConfirmSheet'
import { MSetSelectRow } from '../settings/MSettingsUi'
import { MAdminButton, MAdminCard, MAdminCardHead, MAdminField, MAdminInput, MAdminSecretInput } from './MAdminUi'

type FieldValues = Record<string, string | string[]>

function valuesOf(backend: StorageBackend | null): FieldValues {
  if (!backend) return {}
  const values: FieldValues = {}
  for (const [key, value] of Object.entries(backend.options)) {
    values[key] = Array.isArray(value) ? value : String(value)
  }
  return values
}

/** Same behavior contract as the desktop BackendForm, rendered on the M* primitives. */
function MBackendForm({
  initial,
  backendNames,
  encryptionReady,
  mirror,
  onCommit,
  onCancel,
}: {
  initial: StorageBackend | null
  backendNames: string[]
  encryptionReady: boolean
  mirror: { candidates: string[]; initialTargets: string[] }
  onCommit: (backend: StorageBackend, mirrorTargets: string[]) => void
  onCancel: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  const [type, setType] = useState<StorageBackendTypeId>(initial?.type ?? 'local')
  const [name, setName] = useState(initial?.name ?? '')
  const [values, setValues] = useState<FieldValues>(() => valuesOf(initial))
  const [targets, setTargets] = useState<string[]>(mirror.initialTargets)
  const [picker, setPicker] = useState<string | null>(null)

  const fields = STORAGE_BACKEND_TYPES[type].fields as readonly StorageBackendFieldDef[]
  const refOptions = backendNames.filter((candidate) => candidate !== name.trim())
  const setValue = (key: string, value: string | string[]) => setValues((prev) => ({ ...prev, [key]: value }))

  const filled = (field: StorageBackendFieldDef): boolean => {
    const value = values[field.key]
    if (field.kind === 'backend-ref-list') return Array.isArray(value) && value.length > 0
    return typeof value === 'string' && value.trim() !== ''
  }
  const duplicate = name.trim() !== (initial?.name ?? '') && backendNames.includes(name.trim())
  const blocked = hasPlaintextSecret({ type, options: values }) && !encryptionReady
  const canApply = name.trim() !== '' && !duplicate && fields.every((f) => !f.required || filled(f))

  const apply = () => {
    const options: Record<string, unknown> = {}
    for (const field of fields) {
      const value = values[field.key]
      if (field.kind === 'backend-ref-list') {
        options[field.key] = Array.isArray(value) ? value : []
        continue
      }
      const text = typeof value === 'string' ? value : ''
      if (text === '' && !field.required) continue
      options[field.key] = field.kind === 'number' ? Number(text) : text
    }
    onCommit({ name: name.trim(), type, options } as StorageBackend, targets)
  }

  return (
    <MAdminCard className="space-y-3">
      <MAdminCardHead title={initial ? t('storage.form.editTitle') : t('storage.form.addTitle')} />
      <MAdminField label={t('storage.form.name')}>
        <MAdminInput value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} autoComplete="off" />
      </MAdminField>
      {duplicate && (
        <p role="alert" className="font-geist text-[0.625rem] text-m-muted">
          {t('storage.form.duplicateName', { name: name.trim() })}
        </p>
      )}
      {initial === null && (
        <MAdminField label={t('storage.form.type')}>
          <MSetSelectRow
            label={t(`storage.type.${type}`)}
            trailing={<ChevronDown size={14} className="text-m-faint" />}
            onClick={() => setPicker('type')}
          />
          <MSetPickerSheet
            open={picker === 'type'}
            onClose={() => setPicker(null)}
            title={t('storage.form.type')}
            options={STORAGE_BACKEND_TYPE_IDS.filter((id) => id !== 'mirror').map((id) => ({
              value: id,
              label: t(`storage.type.${id}`),
            }))}
            value={type}
            onSelect={(next) => {
              setType(next as StorageBackendTypeId)
              setValues({})
            }}
          />
        </MAdminField>
      )}

      {fields.map((field) => {
        const value = values[field.key]
        if (field.kind === 'backend-ref') {
          const current = typeof value === 'string' ? value : ''
          return (
            <MAdminField key={field.key} label={t(field.labelKey)}>
              <MSetSelectRow
                label={current || t(field.labelKey)}
                trailing={<ChevronDown size={14} className="text-m-faint" />}
                onClick={() => setPicker(`field:${field.key}`)}
              />
              <MSetPickerSheet
                open={picker === `field:${field.key}`}
                onClose={() => setPicker(null)}
                title={t(field.labelKey)}
                options={refOptions.map((candidate) => ({ value: candidate, label: candidate }))}
                value={current}
                onSelect={(next) => setValue(field.key, next)}
              />
            </MAdminField>
          )
        }
        if (field.kind === 'backend-ref-list') {
          const selected = Array.isArray(value) ? value : []
          return (
            <MAdminField key={field.key} label={t(field.labelKey)}>
              <div className="space-y-2">
                {refOptions.map((candidate) => (
                  <div key={candidate} className="flex items-center justify-between gap-2">
                    <span className="text-[0.8125rem] font-semibold text-m-ink">{candidate}</span>
                    <MToggle
                      checked={selected.includes(candidate)}
                      ariaLabel={candidate}
                      onChange={(checked) =>
                        setValue(
                          field.key,
                          checked ? [...selected, candidate] : selected.filter((existing) => existing !== candidate),
                        )
                      }
                    />
                  </div>
                ))}
              </div>
            </MAdminField>
          )
        }
        const text = typeof value === 'string' ? value : ''
        const shared = {
          value: text,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => setValue(field.key, e.target.value),
          placeholder: field.defaultValue !== undefined ? String(field.defaultValue) : '',
          spellCheck: false,
          autoComplete: 'off',
        }
        return (
          <MAdminField key={field.key} label={t(field.labelKey)} hint={field.helpKey ? t(field.helpKey) : undefined}>
            {field.kind === 'secret' ? (
              <MAdminSecretInput {...shared} />
            ) : (
              <MAdminInput {...shared} type={field.kind === 'number' ? 'number' : 'text'} />
            )}
          </MAdminField>
        )
      })}

      <MAdminField label={t('storage.mirror.targets')} hint={t('storage.mirror.targetsHelp')}>
        <div className="space-y-2">
          {mirror.candidates
            .filter((candidate) => candidate !== name.trim())
            .map((candidate) => (
              <div key={candidate} className="flex items-center justify-between gap-2">
                <span className="text-[0.8125rem] font-semibold text-m-ink">{candidate}</span>
                <MToggle
                  checked={targets.includes(candidate)}
                  ariaLabel={candidate}
                  onChange={(checked) =>
                    setTargets(checked ? [...targets, candidate] : targets.filter((existing) => existing !== candidate))
                  }
                />
              </div>
            ))}
        </div>
        {targets.length > 0 && (
          <p role="note" className="mt-1 font-geist text-[0.625rem] leading-relaxed text-m-muted">
            {t('storage.mirror.latencyNote')}
          </p>
        )}
      </MAdminField>

      <div className="flex items-center gap-2">
        {blocked ? (
          <p role="alert" className="font-geist text-[0.625rem] leading-relaxed text-m-muted">
            {t('storage.form.encryptionBanner')}
          </p>
        ) : (
          <MAdminButton onClick={apply} disabled={!canApply}>
            {t('storage.form.apply')}
          </MAdminButton>
        )}
        <MAdminButton variant="ghost" onClick={onCancel}>
          {t('storage.form.cancel')}
        </MAdminButton>
      </div>
    </MAdminCard>
  )
}

export default function MAdminStoragePanel(): React.ReactElement {
  const { t, locale } = useTranslation()
  const toast = useToast()
  const admin = useStorageAdmin(t('common.error'))
  const [editing, setEditing] = useState<{
    initial: StorageBackend | null
    originalName: string | null
    mirror: { candidates: string[]; initialTargets: string[] }
  } | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<{ name: string; degenerate: boolean } | null>(null)
  const [categoryPicker, setCategoryPicker] = useState<StorageCategory | null>(null)

  if (admin.loading) {
    return (
      <MAdminCard>
        <p className="font-geist text-[0.75rem] italic text-m-faint">{t('storage.loading')}</p>
      </MAdminCard>
    )
  }
  if (!admin.state || !admin.draft) {
    return (
      <MAdminCard>
        <p role="alert" className="text-[0.8125rem] text-m-ink">{admin.loadError || t('common.error')}</p>
      </MAdminCard>
    )
  }
  const { state, draft } = admin

  const backendNames = [...new Set([...state.backends.map((b) => b.name), ...draft.backends.map((b) => b.name)])]
  const { rows, degenerate } = foldBackends(state, draft)
  const effective = effectiveCategoryMap(state, draft)

  const startEdit = (row: FoldedBackendRow) => {
    setEditing({
      initial: row.backend,
      originalName: row.name,
      mirror: {
        candidates: rows.filter((r) => r.name !== row.name).map((r) => r.name),
        initialTargets: row.mirrorTargets,
      },
    })
  }

  const commitBackend = (backend: StorageBackend, mirrorTargets: string[]) => {
    const renamedFrom = editing?.originalName && editing.originalName !== backend.name ? editing.originalName : null
    let next = draft
    if (renamedFrom) next = renameBackendRefs(removeBackend(next, renamedFrom), renamedFrom, backend.name)
    next = upsertBackend(next, backend)
    next = setMirrorTargets(state, next, backend.name, mirrorTargets)
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
    const target = adoptedMirrorFor(draft, primaryName)?.name ?? primaryName
    // The admin state's category record is exhaustive by schema contract.
    const stateEntry = state.categories[category]!
    const categories = { ...draft.categories }
    if (stateEntry.source === 'default' && target === stateEntry.backend) {
      delete categories[category]
    } else {
      categories[category] = target
    }
    admin.setDraft({ ...draft, categories })
  }

  const save = async () => {
    if (await admin.save()) toast.success(t('storage.saved'))
  }

  return (
    <div className="space-y-3">
      <MAdminCard>
        <MAdminCardHead title={t('storage.health.title')} />
        {state.health.replicaFailures.length === 0 ? (
          <p className="font-geist text-[0.75rem] text-m-faint">{t('storage.health.allClear')}</p>
        ) : (
          <div className="space-y-1">
            {state.health.replicaFailures.map((failure) => (
              <p key={`${failure.backend}-${failure.key}-${failure.at}`} className="text-[0.75rem] text-m-ink">
                {t('storage.health.failureLine', {
                  op: failure.op,
                  key: failure.key,
                  backend: failure.backend,
                  error: failure.error,
                })}{' '}
                <span className="text-m-faint">· {relativeTime(failure.at, locale)}</span>
              </p>
            ))}
          </div>
        )}
        {state.seedFilePresent && (
          <p className="mt-1 font-geist text-[0.625rem] text-m-muted">{t('storage.health.seedFile')}</p>
        )}
      </MAdminCard>

      <MAdminCard>
        <MAdminCardHead title={t('storage.backends.title')} hint={t('storage.description')} />
        <div className="space-y-2">
          {rows.map((row) => {
            const resultKey = row.mirrorName ?? row.name
            const result = admin.testResults[resultKey]
            // row.mirrorName only exists when foldBackends adopted a draft mirror
            // for this row, so the draft lookup below cannot miss.
            const testCandidate = row.mirrorName
              ? draft.backends.find((b) => b.name === row.mirrorName)!
              : row.backend
            return (
              <div
                key={row.name}
                data-testid={`m-storage-backend-${row.name}`}
                className="rounded-xl border border-[color:var(--m-rowbr)] bg-[color:var(--m-sheet)] p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[0.8125rem] font-bold text-m-ink">{row.name}</span>
                  <span className="rounded-full border border-[color:var(--m-rowbr)] px-2 py-[1px] font-geist text-[0.625rem] text-m-muted">
                    {t(`storage.type.${row.type}`)}
                  </span>
                  <span className="rounded-full border border-[color:var(--m-rowbr)] px-2 py-[1px] font-geist text-[0.625rem] text-m-muted">
                    {t(`storage.source.${row.source}`)}
                  </span>
                </div>
                <p className="mt-1 font-geist text-[0.625rem] text-m-muted">
                  {row.categories.length > 0
                    ? t('storage.backends.usedBy', { categories: row.categories.join(', ') })
                    : t('storage.backends.unused')}
                </p>
                {row.mirrorTargets.length > 0 && (
                  <p className="mt-1 font-geist text-[0.625rem] text-m-muted">
                    {t('storage.mirror.mirroredTo', { targets: row.mirrorTargets.join(', ') })}
                  </p>
                )}
                {row.replicaOf.length > 0 && (
                  <p className="mt-1 font-geist text-[0.625rem] text-m-muted">
                    {t('storage.mirror.replicaOf', { primaries: row.replicaOf.join(', ') })}
                  </p>
                )}
                {row.source === 'env' && (
                  <p className="mt-1 font-geist text-[0.625rem] text-m-muted">{t('storage.backends.envReadOnly')}</p>
                )}
                <div className="mt-2 flex gap-2">
                  <MAdminButton variant="ghost" onClick={() => admin.test(testCandidate)}>
                    {t('storage.actions.test')}
                  </MAdminButton>
                  {row.source !== 'env' && (
                    <MAdminButton variant="ghost" onClick={() => startEdit(row)}>
                      {t('storage.actions.edit')}
                    </MAdminButton>
                  )}
                  {row.source === 'settings' && (
                    <MAdminButton variant="danger" onClick={() => setConfirmRemove({ name: row.name, degenerate: false })}>
                      {t('storage.actions.remove')}
                    </MAdminButton>
                  )}
                </div>
                {result === 'running' ? (
                  <p className="mt-2 font-geist text-[0.625rem] text-m-muted">{t('storage.test.running')}</p>
                ) : (
                  result && (
                    <div className="mt-2 space-y-0.5">
                      <p className="text-[0.75rem] font-bold text-m-ink">
                        {result.ok ? t('storage.test.ok') : t('storage.test.failed')}
                      </p>
                      {result.targets.map((target) => (
                        <p key={target.name} className="font-geist text-[0.625rem] text-m-muted">
                          {target.ok ? '✓' : '✗'} {target.name}
                          {target.error ? ` — ${target.error}` : ''}
                        </p>
                      ))}
                    </div>
                  )
                )}
              </div>
            )
          })}

          {degenerate.map(({ backend, reason }) => {
            const result = admin.testResults[backend.name]
            const primary = backend.type === 'mirror' ? backend.options.primary : ''
            return (
              <div
                key={backend.name}
                data-testid={`m-storage-backend-${backend.name}`}
                className="rounded-xl border border-[color:var(--m-rowbr)] bg-[color:var(--m-sheet)] p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[0.8125rem] font-bold text-m-ink">{backend.name}</span>
                  <span className="rounded-full border border-[color:var(--m-rowbr)] px-2 py-[1px] font-geist text-[0.625rem] text-m-muted">
                    {t('storage.type.mirror')}
                  </span>
                </div>
                <p className="mt-1 font-geist text-[0.625rem] text-m-muted">
                  {t(`storage.mirror.degenerate.${reason}`, { primary })}
                </p>
                <div className="mt-2 flex gap-2">
                  <MAdminButton variant="ghost" onClick={() => admin.test(backend)}>
                    {t('storage.actions.test')}
                  </MAdminButton>
                  <MAdminButton variant="danger" onClick={() => setConfirmRemove({ name: backend.name, degenerate: true })}>
                    {t('storage.actions.remove')}
                  </MAdminButton>
                </div>
                {result === 'running' ? (
                  <p className="mt-2 font-geist text-[0.625rem] text-m-muted">{t('storage.test.running')}</p>
                ) : (
                  result && (
                    <div className="mt-2 space-y-0.5">
                      <p className="text-[0.75rem] font-bold text-m-ink">
                        {result.ok ? t('storage.test.ok') : t('storage.test.failed')}
                      </p>
                      {result.targets.map((target) => (
                        <p key={target.name} className="font-geist text-[0.625rem] text-m-muted">
                          {target.ok ? '✓' : '✗'} {target.name}
                          {target.error ? ` — ${target.error}` : ''}
                        </p>
                      ))}
                    </div>
                  )
                )}
              </div>
            )
          })}
        </div>
        {editing === null && (
          <div className="mt-3">
            <MAdminButton
              onClick={() =>
                setEditing({
                  initial: null,
                  originalName: null,
                  mirror: { candidates: rows.map((r) => r.name), initialTargets: [] },
                })
              }
            >
              {t('storage.backends.add')}
            </MAdminButton>
          </div>
        )}
      </MAdminCard>

      {editing !== null && (
        <MBackendForm
          initial={editing.initial}
          backendNames={backendNames}
          encryptionReady={state.encryptionReady}
          mirror={editing.mirror}
          onCommit={commitBackend}
          onCancel={() => setEditing(null)}
        />
      )}

      <MAdminCard>
        <MAdminCardHead title={t('storage.categories.title')} />
        <div className="space-y-2">
          {STORAGE_CATEGORIES.map((category) => {
            // The admin state's category record is exhaustive by schema contract.
            const stateEntry = state.categories[category]!
            const selectedPrimary = primaryNameOf(state, draft, effective[category])
            const changed = selectedPrimary !== primaryNameOf(state, draft, stateEntry.backend)
            const viaMirror = effective[category] !== selectedPrimary
            return (
              <MAdminField key={category} label={t(`storage.category.${category}`)}>
                <div data-testid={`m-storage-category-${category}`} className="contents">
                  <MSetSelectRow
                    label={
                      stateEntry.source === 'default' && selectedPrimary === stateEntry.backend
                        ? `${selectedPrimary} (${t('storage.categories.default')})`
                        : selectedPrimary
                    }
                    trailing={<ChevronDown size={14} className="text-m-faint" />}
                    onClick={() => setCategoryPicker(category)}
                  />
                </div>
                {changed && (
                  <p role="alert" className="mt-1 font-geist text-[0.625rem] text-m-muted">
                    {t('storage.categories.reassignWarning')}
                  </p>
                )}
                {viaMirror && CACHE_CATEGORIES.includes(category) && (
                  <p role="note" className="mt-1 font-geist text-[0.625rem] text-m-muted">
                    {t('storage.mirror.cacheWarning')}
                  </p>
                )}
              </MAdminField>
            )
          })}
        </div>
        <MSetPickerSheet
          open={categoryPicker !== null}
          onClose={() => setCategoryPicker(null)}
          title={categoryPicker ? t(`storage.category.${categoryPicker}`) : ''}
          options={rows.map((row) => ({ value: row.name, label: row.name }))}
          value={categoryPicker ? primaryNameOf(state, draft, effective[categoryPicker]) : ''}
          onSelect={(name) => {
            if (categoryPicker) setCategory(categoryPicker, name)
          }}
        />
      </MAdminCard>

      <div className="flex items-center gap-2">
        <MAdminButton onClick={save} disabled={!admin.dirty} busy={admin.saving}>
          {t('storage.save')}
        </MAdminButton>
        {admin.dirty && <span className="font-geist text-[0.625rem] text-m-muted">{t('storage.unsaved')}</span>}
      </div>
      {admin.saveError && (
        <p role="alert" className="text-[0.8125rem] text-m-ink">
          {admin.saveError}
        </p>
      )}

      <MConfirmSheet
        open={confirmRemove !== null}
        onClose={() => setConfirmRemove(null)}
        title={t('storage.remove.title')}
        message={confirmRemove ? removeMessage(confirmRemove.name, confirmRemove.degenerate) : ''}
        confirmLabel={t('storage.actions.remove')}
        cancelLabel={t('storage.form.cancel')}
        danger
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
      />
    </div>
  )
}
