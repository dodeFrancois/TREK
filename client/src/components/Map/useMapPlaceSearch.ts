import { useState, useEffect, useCallback, useRef } from 'react'
import { mapsApi } from '../../api/client'
import { isAbortError } from './abortError'
import type { Bbox } from './usePoiExplore'

/** One autocomplete suggestion, as the /api/maps/autocomplete contract returns it. */
export interface MapPlaceSuggestion {
  placeId: string
  mainText: string
  secondaryText: string
}

/**
 * Below two characters a query matches half the planet, so the provider call is
 * pure cost — the same threshold the place form's search already applies.
 */
const MIN_QUERY_LENGTH = 2

/**
 * A place the user is looking at but has NOT committed to. Flattened from the
 * provider-shaped `place` blob that /api/maps/details returns (Google and OSM
 * converge on these field names — see buildOsmDetails / the Google mapping in
 * server/src/services/mapsService.ts).
 */
export interface MapPlacePreview {
  placeId: string
  name: string
  address: string
  lat: number
  lng: number
  website: string | null
  phone: string | null
  opening_hours: string[] | null
  open_now: boolean | null
  rating: number | null
  rating_count: number | null
  source: string | null
  /**
   * The provider's own handle on this place, carried through so the created place
   * can be enriched later (ratings, photos, hours) by whichever provider found it.
   * Both branches of /api/maps/details set their own field — see the OSM and
   * Google mappings in server/src/services/mapsService.ts.
   */
  osm_id: string | null
  google_place_id: string | null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null
}

/**
 * Coordinates arrive as numbers from Google and as strings from Nominatim, and as
 * null when the provider has no point at all. `Number(null)` is 0 — a valid-looking
 * coordinate in the Gulf of Guinea — so null must be rejected before coercing.
 */
function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** Null when the provider gave no usable point — there'd be nothing to show. */
function toPreview(placeId: string, place: Record<string, unknown>): MapPlacePreview | null {
  const lat = num(place.lat)
  const lng = num(place.lng)
  if (lat === null || lng === null) return null
  return {
    placeId,
    name: str(place.name) || '',
    address: str(place.address) || '',
    lat,
    lng,
    website: str(place.website),
    phone: str(place.phone),
    opening_hours: Array.isArray(place.opening_hours) ? place.opening_hours.filter(l => typeof l === 'string') : null,
    open_now: typeof place.open_now === 'boolean' ? place.open_now : null,
    rating: typeof place.rating === 'number' ? place.rating : null,
    rating_count: typeof place.rating_count === 'number' ? place.rating_count : null,
    source: str(place.source),
    osm_id: str(place.osm_id),
    google_place_id: str(place.google_place_id),
  }
}

export interface UseMapPlaceSearchOptions {
  debounceMs?: number
  /** Interface language, so names, addresses and opening hours come back localized. */
  language?: string
  /** Read at call time so the bias always reflects where the user is looking now. */
  getViewportBounds?: () => Bbox | null
}

/**
 * State for the map's search-then-decide flow: type a query, pick one of the
 * suggestions, look at what came back, and only then decide. Nothing in here
 * writes to the trip — committing is the caller's job, via the add-place form.
 */
export function useMapPlaceSearch({ debounceMs = 300, getViewportBounds, language }: UseMapPlaceSearchOptions = {}) {
  const [query, setQuery] = useState('')
  const [suggestions, setSuggestions] = useState<MapPlaceSuggestion[]>([])
  const [preview, setPreview] = useState<MapPlacePreview | null>(null)
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(false)
  const [photoUrl, setPhotoUrl] = useState<string | null>(null)
  // One in-flight autocomplete at a time: a new keystroke cancels the previous
  // request rather than racing it, so a slow answer can't land on a newer query.
  const suggestAbortRef = useRef<AbortController | null>(null)
  // The callback identity may change on every render of the caller; keeping it in a
  // ref stops that from re-triggering the debounced search.
  const boundsRef = useRef(getViewportBounds)
  boundsRef.current = getViewportBounds
  // mapsApi.details takes no abort signal, so a superseded lookup can't be
  // cancelled — it is fenced out by generation instead.
  const selectGenRef = useRef(0)

  useEffect(() => {
    const q = query.trim()
    if (q.length < MIN_QUERY_LENGTH) {
      setSuggestions([])
      setError(false)
      setLoading(false)
      return
    }
    const timer = setTimeout(async () => {
      suggestAbortRef.current?.abort()
      const ctrl = new AbortController()
      suggestAbortRef.current = ctrl
      setError(false)
      setLoading(true)
      try {
        const bbox = boundsRef.current?.() ?? null
        const bias = bbox
          ? { low: { lat: bbox.south, lng: bbox.west }, high: { lat: bbox.north, lng: bbox.east } }
          : undefined
        const res = await mapsApi.autocomplete(q, language, bias, ctrl.signal)
        setSuggestions(res.suggestions)
      } catch (err) {
        // A superseded request was cancelled on purpose — leave the newer one's
        // state alone. A real failure must be visible, not read as "no results".
        if (isAbortError(err)) return
        setSuggestions([])
        setError(true)
      } finally {
        // Only the newest request owns the spinner; a superseded one must not
        // clear it, or the UI looks idle while a call is still running.
        if (suggestAbortRef.current === ctrl) {
          setLoading(false)
          suggestAbortRef.current = null
        }
      }
    }, debounceMs)
    return () => clearTimeout(timer)
  }, [query, debounceMs, language])

  /** Look a suggestion up in full, without creating anything. */
  const select = useCallback(async (placeId: string) => {
    const gen = ++selectGenRef.current
    setLoading(true)
    // Never let the previous place's photo sit above the new one's name.
    setPhotoUrl(null)
    try {
      const res = await mapsApi.details(placeId, language)
      if (gen !== selectGenRef.current) return   // a newer selection won
      if (!res.place) return
      const next = toPreview(placeId, res.place)
      if (!next) return
      setPreview(next)
      // The list has done its job; leaving it open would wedge it between the
      // field and the preview card.
      setSuggestions([])
      setLoading(false)   // the card can be shown; the photo only decorates it
      try {
        const photo = await mapsApi.placePhoto(placeId, next.lat, next.lng, next.name)
        if (gen === selectGenRef.current) setPhotoUrl(photo.photoUrl ?? null)
      } catch {
        // Plenty of places simply have no photo, and the provider may refuse the
        // lookup entirely. Neither is a reason to spoil a usable preview.
      }
    } catch {
      if (gen === selectGenRef.current) setError(true)
    } finally {
      if (gen === selectGenRef.current) setLoading(false)
    }
  }, [language])

  /** Leave no trace: the search closes and the preview marker goes with it. */
  const clear = useCallback(() => {
    setQuery('')
    setSuggestions([])
    setPreview(null)
    setError(false)
    setLoading(false)
    setPhotoUrl(null)
  }, [])

  return { query, setQuery, suggestions, preview, photoUrl, error, loading, select, clear }
}
