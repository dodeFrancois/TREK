import { useState } from 'react'
import { X, Plus, Clock, Globe, Phone, Star, ChevronDown, ChevronUp } from 'lucide-react'
import { useTranslation } from '../../i18n'
import type { MapPlacePreview } from './useMapPlaceSearch'

interface Props {
  place: MapPlacePreview
  photoUrl?: string | null
  /** false for a viewer without place_edit — the preview stays, the commit goes */
  canAdd?: boolean
  onAdd: (place: MapPlacePreview) => void
  onClose: () => void
}

const frosted: React.CSSProperties = {
  background: 'var(--sidebar-bg)',
  backdropFilter: 'blur(20px) saturate(180%)',
  WebkitBackdropFilter: 'blur(20px) saturate(180%)',
  boxShadow: 'var(--sidebar-shadow, 0 4px 16px rgba(0,0,0,0.14))',
}

// What a searched place looks like BEFORE it belongs to the trip: enough to judge
// it by, and two ways out — hand it to the add-place form, or drop it entirely.
// Nothing here writes anything.
export default function PlacePreviewCard({ place, photoUrl, canAdd = true, onAdd, onClose }: Props) {
  const { t } = useTranslation()
  const [hoursOpen, setHoursOpen] = useState(false)
  const hasHours = !!place.opening_hours && place.opening_hours.length > 0

  return (
    <div data-testid="place-preview-card" style={{ width: 288, borderRadius: 16, overflow: 'hidden', pointerEvents: 'auto', ...frosted }}>
      {photoUrl && (
        <img
          src={photoUrl}
          alt={place.name}
          style={{ display: 'block', width: '100%', height: 116, objectFit: 'cover' }}
        />
      )}

      <div style={{ padding: 12 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="text-content" style={{ fontSize: 14.5, fontWeight: 700, lineHeight: 1.25 }}>{place.name}</div>
            {place.address && (
              <div className="text-content-muted" style={{ fontSize: 12, marginTop: 3, lineHeight: 1.35 }}>{place.address}</div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="text-content-muted"
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              width: 24, height: 24, borderRadius: 999, border: 'none', cursor: 'pointer', background: 'transparent',
            }}
          >
            <X size={15} strokeWidth={2.4} />
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 9 }}>
          {place.open_now !== null && (
            <span style={{
              fontSize: 11.5, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
              color: place.open_now ? '#15803d' : '#b91c1c',
              background: place.open_now ? 'rgba(22,163,74,0.14)' : 'rgba(185,28,28,0.14)',
            }}>
              {place.open_now ? t('inspector.opened') : t('inspector.closed')}
            </span>
          )}
          {place.rating !== null && (
            <span className="text-content-muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 12 }}>
              <Star size={12} strokeWidth={2.4} />
              {place.rating}
              {place.rating_count !== null && ` (${place.rating_count})`}
            </span>
          )}
        </div>

        {(place.website || place.phone) && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 9 }}>
            {place.website && (
              <a
                href={place.website}
                target="_blank"
                rel="noreferrer noopener"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, textDecoration: 'none' }}
              >
                <Globe size={12.5} strokeWidth={2.2} style={{ flexShrink: 0 }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {place.website.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                </span>
              </a>
            )}
            {place.phone && (
              <a
                href={`tel:${place.phone.replace(/[^+\d]/g, '')}`}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, textDecoration: 'none' }}
              >
                <Phone size={12.5} strokeWidth={2.2} style={{ flexShrink: 0 }} />
                {place.phone}
              </a>
            )}
          </div>
        )}

        {hasHours && (
          <>
            <button
              type="button"
              onClick={() => setHoursOpen(o => !o)}
              aria-expanded={hoursOpen}
              className="text-content-muted"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 9, padding: 0,
                border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit',
              }}
            >
              <Clock size={12.5} strokeWidth={2.2} />
              {t('inspector.openingHours')}
              {hoursOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </button>
            {hoursOpen && (
              <ul className="text-content-muted" style={{ listStyle: 'none', margin: '6px 0 0', padding: 0, fontSize: 11.5, lineHeight: 1.7 }}>
                {place.opening_hours!.map(line => <li key={line}>{line}</li>)}
              </ul>
            )}
          </>
        )}

        {canAdd && (
          <button
            type="button"
            onClick={() => onAdd(place)}
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              width: '100%', marginTop: 12, padding: '9px 12px', borderRadius: 10,
              border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit',
              background: 'var(--accent-primary, #4F46E5)', color: '#fff',
            }}
          >
            <Plus size={14} strokeWidth={2.6} />
            {t('map.search.addToTrip')}
          </button>
        )}
      </div>
    </div>
  )
}
