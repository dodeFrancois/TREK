import {
  MASKED_SETTING_VALUE,
  storageSecretFields,
  type StorageAdminState,
  type StorageBackend,
  type StorageCategory,
  type StorageConfig,
} from '@trek/shared'

/** One entry of the effective world (GET state), as the panels render it. */
export type StateBackend = StorageAdminState['backends'][number]

/**
 * The settings-owned document the PUT carries: settings-sourced backends and
 * settings-sourced category assignments ONLY — built-ins and env backends are
 * never in the body unless the operator overrides one by name (in which case
 * the override already reports source 'settings').
 */
export function settingsDocumentOf(state: StorageAdminState): StorageConfig {
  return {
    backends: state.backends.filter((b) => b.source === 'settings').map(asWireBackend),
    categories: Object.fromEntries(
      Object.entries(state.categories)
        .filter(([, entry]) => entry.source === 'settings')
        .map(([category, entry]) => [category, entry.backend]),
    ) as StorageConfig['categories'],
  }
}

/**
 * State options are already schema-shaped (the wire contract guarantees it;
 * secret fields carry the mask, which the server unmasks by name on PUT/test) —
 * the cast re-attaches the discriminated-union type the loose state record dropped.
 */
export function asWireBackend(backend: Pick<StateBackend, 'name' | 'type' | 'options'>): StorageBackend {
  return { name: backend.name, type: backend.type, options: backend.options } as StorageBackend
}

/** Draft categories pointing at a backend name (the friendly remove pre-check). */
export function categoriesPointingAt(draft: StorageConfig, name: string): StorageCategory[] {
  return (Object.entries(draft.categories) as Array<[StorageCategory, string]>)
    .filter(([, backend]) => backend === name)
    .map(([category]) => category)
}

/** Draft mirrors referencing a backend name as primary or replica (remove pre-check). */
export function mirrorsReferencing(draft: StorageConfig, name: string): string[] {
  return draft.backends
    .filter((b) => b.type === 'mirror' && (b.options.primary === name || b.options.replicas.includes(name)))
    .map((b) => b.name)
}

/** True when a secret-kind field holds a non-empty value that is not the mask sentinel. */
export function hasPlaintextSecret(backend: { type: StorageBackend['type']; options: Record<string, unknown> }): boolean {
  return storageSecretFields(backend.type).some((field) => {
    const value = backend.options[field]
    return typeof value === 'string' && value !== '' && value !== MASKED_SETTING_VALUE
  })
}

/** Replace by name in place, or append. Never mutates. */
export function upsertBackend(draft: StorageConfig, backend: StorageBackend): StorageConfig {
  const exists = draft.backends.some((b) => b.name === backend.name)
  return {
    ...draft,
    backends: exists
      ? draft.backends.map((b) => (b.name === backend.name ? backend : b))
      : [...draft.backends, backend],
  }
}

export function removeBackend(draft: StorageConfig, name: string): StorageConfig {
  return { ...draft, backends: draft.backends.filter((b) => b.name !== name) }
}
