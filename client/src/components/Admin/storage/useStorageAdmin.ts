import { useCallback, useEffect, useRef, useState } from 'react'
import type { StorageAdminState, StorageBackend, StorageConfig, StorageTestResponse } from '@trek/shared'
import { adminApi } from '../../../api/client'
import { getApiErrorMessage } from '../../../types'
import { settingsDocumentOf } from './storageModel'

export type StorageTestResults = Record<string, StorageTestResponse | 'running'>

/** 50ms under vitest so poll tests run on real timers (MSW + fake timers don't mix). */
export const BACKFILL_POLL_MS = import.meta.env.MODE === 'test' ? 50 : 5000

export interface StorageAdmin {
  state: StorageAdminState | null
  /** The settings-owned document (the PUT body), with local edits layered in. */
  draft: StorageConfig | null
  dirty: boolean
  loading: boolean
  loadError: string | null
  /** Server 400s land here VERBATIM — long registry messages outlive a toast. */
  saveError: string | null
  saving: boolean
  testResults: StorageTestResults
  setDraft: (next: StorageConfig) => void
  save: () => Promise<boolean>
  test: (backend: StorageBackend) => Promise<void>
  /** null on success; the verbatim server error otherwise. */
  startBackfill: (mirrorName: string) => Promise<string | null>
  cancelBackfill: (mirrorName: string) => Promise<string | null>
  refreshStats: () => Promise<string | null>
}

/**
 * Shared by the desktop and phone storage panels (DefaultUserSettingsTab
 * model: self-contained, adminApi directly, deliberately no offline core —
 * hoster-level config is online-only).
 */
export function useStorageAdmin(genericError: string): StorageAdmin {
  const [state, setState] = useState<StorageAdminState | null>(null)
  const [draft, setDraftState] = useState<StorageConfig | null>(null)
  const [dirty, setDirty] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [testResults, setTestResults] = useState<StorageTestResults>({})

  // Read imperatively from the poll effect/refreshState so a stale closure
  // never re-derives the draft out from under an in-flight edit.
  const dirtyRef = useRef(dirty)
  useEffect(() => {
    dirtyRef.current = dirty
  }, [dirty])

  const applyState = useCallback((next: StorageAdminState) => {
    setState(next)
    setDraftState(settingsDocumentOf(next))
    setDirty(false)
    setSaveError(null)
  }, [])

  useEffect(() => {
    let cancelled = false
    adminApi
      .getStorage()
      .then((data) => {
        if (!cancelled) applyState(data)
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(getApiErrorMessage(err, genericError))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [applyState, genericError])

  const setDraft = useCallback((next: StorageConfig) => {
    setDraftState(next)
    setDirty(true)
  }, [])

  const save = useCallback(async (): Promise<boolean> => {
    if (!draft) return false
    setSaving(true)
    setSaveError(null)
    try {
      // The response is the fresh effective world, never the request echo.
      applyState(await adminApi.updateStorage(draft))
      return true
    } catch (err: unknown) {
      setSaveError(getApiErrorMessage(err, genericError))
      return false
    } finally {
      setSaving(false)
    }
  }, [draft, applyState, genericError])

  const test = useCallback(
    async (backend: StorageBackend): Promise<void> => {
      setTestResults((prev) => ({ ...prev, [backend.name]: 'running' }))
      try {
        const result = await adminApi.testStorageBackend(backend)
        setTestResults((prev) => ({ ...prev, [backend.name]: result }))
      } catch (err: unknown) {
        const error = getApiErrorMessage(err, genericError)
        setTestResults((prev) => ({
          ...prev,
          [backend.name]: { ok: false, targets: [{ name: backend.name, ok: false, error }] },
        }))
      }
    },
    [genericError],
  )

  // Poll-safe refresh: replaces `state` unconditionally, but only re-derives
  // `draft` when the operator has no unsaved edits in flight — never touches
  // `dirty`/`saveError`, so a running poll cannot clobber a dirty draft or
  // mask a pending save error.
  const refreshState = useCallback(async (): Promise<void> => {
    const next = await adminApi.getStorage()
    setState(next)
    if (!dirtyRef.current) setDraftState(settingsDocumentOf(next))
  }, [])

  // While any backfill is running, poll GET state so progress/counts advance
  // without the operator refreshing the page.
  useEffect(() => {
    if (!state?.backfills.some((b) => b.status === 'running')) return
    const iv = setInterval(() => {
      // A transient poll failure is retried on the next tick — it must never
      // surface as a toast or interrupt the operator's in-progress edit.
      void refreshState().catch(() => {})
    }, BACKFILL_POLL_MS)
    return () => clearInterval(iv)
  }, [state, refreshState])

  const startBackfill = useCallback(
    async (mirrorName: string): Promise<string | null> => {
      try {
        await adminApi.startStorageBackfill(mirrorName)
        void refreshState()
        return null
      } catch (err: unknown) {
        return getApiErrorMessage(err, genericError)
      }
    },
    [refreshState, genericError],
  )

  const cancelBackfill = useCallback(
    async (mirrorName: string): Promise<string | null> => {
      try {
        await adminApi.cancelStorageBackfill(mirrorName)
        void refreshState()
        return null
      } catch (err: unknown) {
        return getApiErrorMessage(err, genericError)
      }
    },
    [refreshState, genericError],
  )

  const refreshStats = useCallback(async (): Promise<string | null> => {
    try {
      const usage = await adminApi.refreshStorageStats()
      setState((prev) => (prev ? { ...prev, usage } : prev))
      return null
    } catch (err: unknown) {
      return getApiErrorMessage(err, genericError)
    }
  }, [genericError])

  return {
    state,
    draft,
    dirty,
    loading,
    loadError,
    saveError,
    saving,
    testResults,
    setDraft,
    save,
    test,
    startBackfill,
    cancelBackfill,
    refreshStats,
  }
}
