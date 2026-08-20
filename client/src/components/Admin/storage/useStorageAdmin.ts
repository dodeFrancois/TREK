import { useCallback, useEffect, useState } from 'react'
import type { StorageAdminState, StorageBackend, StorageConfig, StorageTestResponse } from '@trek/shared'
import { adminApi } from '../../../api/client'
import { getApiErrorMessage } from '../../../types'
import { settingsDocumentOf } from './storageModel'

export type StorageTestResults = Record<string, StorageTestResponse | 'running'>

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

  return { state, draft, dirty, loading, loadError, saveError, saving, testResults, setDraft, save, test }
}
