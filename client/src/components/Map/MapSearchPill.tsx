import { Search, X, AlertTriangle } from 'lucide-react'
import { useTranslation } from '../../i18n'
import type { MapPlaceSuggestion } from './useMapPlaceSearch'

interface Props {
  query: string
  onQueryChange: (query: string) => void
  suggestions: MapPlaceSuggestion[]
  loading?: boolean
  /** the last lookup failed — say so rather than showing an empty list */
  error?: boolean
  onSelect: (placeId: string) => void
  onClear: () => void
}

const frosted: React.CSSProperties = {
  background: 'var(--sidebar-bg)',
  backdropFilter: 'blur(20px) saturate(180%)',
  WebkitBackdropFilter: 'blur(20px) saturate(180%)',
  boxShadow: 'var(--sidebar-shadow, 0 4px 16px rgba(0,0,0,0.14))',
}

// Frosted search field that floats over the map, sibling of PoiCategoryPill. It
// only reports intent — the query, the pick, the abandon — so the page owns the
// state and nothing here can create a place by itself.
export default function MapSearchPill({ query, onQueryChange, suggestions, loading, error, onSelect, onClear }: Props) {
  const { t } = useTranslation()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: 288, pointerEvents: 'auto' }}>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '0 11px', height: 38, borderRadius: 999, ...frosted }}>
        <Search size={15} strokeWidth={2.2} className="text-content-muted" style={{ flexShrink: 0 }} />
        <input
          type="text"
          value={query}
          onChange={e => onQueryChange(e.target.value)}
          placeholder={t('map.search.placeholder')}
          aria-label={t('map.search.placeholder')}
          className="text-content"
          style={{
            flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent',
            fontSize: 13, fontFamily: 'inherit',
          }}
        />
        {loading && (
          <span
            role="status"
            aria-label={t('common.loading')}
            className="animate-spin"
            style={{
              width: 13, height: 13, borderRadius: 999, flexShrink: 0, display: 'inline-block',
              border: '2px solid', borderColor: 'var(--border-primary)', borderTopColor: 'var(--text-muted)',
            }}
          />
        )}
        {query && (
          <button
            type="button"
            onClick={onClear}
            aria-label={t('common.clear')}
            className="text-content-muted"
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              width: 22, height: 22, borderRadius: 999, border: 'none', cursor: 'pointer', background: 'transparent',
            }}
          >
            <X size={14} strokeWidth={2.4} />
          </button>
        )}
      </div>

      {error && (
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 7, padding: '9px 12px', borderRadius: 14,
            fontSize: 12.5, color: '#ef4444', ...frosted,
          }}
        >
          <AlertTriangle size={14} strokeWidth={2.4} style={{ flexShrink: 0 }} />
          {t('map.search.failed')}
        </div>
      )}

      {!error && suggestions.length > 0 && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 4, borderRadius: 14, maxHeight: 264, overflowY: 'auto', ...frosted }}>
          {suggestions.map(s => (
            <li key={s.placeId}>
              <button
                type="button"
                onClick={() => onSelect(s.placeId)}
                style={{
                  display: 'block', width: '100%', textAlign: 'left', padding: '7px 9px', borderRadius: 10,
                  border: 'none', cursor: 'pointer', background: 'transparent', fontFamily: 'inherit',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
              >
                <span className="text-content" style={{ display: 'block', fontSize: 13, fontWeight: 600 }}>{s.mainText}</span>
                {s.secondaryText && (
                  <span className="text-content-muted" style={{ display: 'block', fontSize: 11.5, marginTop: 1 }}>{s.secondaryText}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
