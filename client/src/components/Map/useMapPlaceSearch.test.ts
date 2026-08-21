import { describe, it, expect } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { server } from '../../../tests/helpers/msw/server'
import { useMapPlaceSearch } from './useMapPlaceSearch'

// FE-MAP-SEARCH-001 onwards — the map's search-then-decide flow.

describe('useMapPlaceSearch', () => {
  it('FE-MAP-SEARCH-001: a typed query exposes the provider suggestions', async () => {
    server.use(http.post('/api/maps/autocomplete', () => HttpResponse.json({
      suggestions: [{ placeId: 'way/123', mainText: 'Sagrada Família', secondaryText: 'Barcelona, Spain' }],
      source: 'openstreetmap',
    })))

    const { result } = renderHook(() => useMapPlaceSearch({ debounceMs: 0 }))
    act(() => { result.current.setQuery('sagrada') })

    await waitFor(() => expect(result.current.suggestions).toHaveLength(1))
    expect(result.current.suggestions[0].mainText).toBe('Sagrada Família')
  })

  it('FE-MAP-SEARCH-002: a one-character query is never sent to the provider', async () => {
    const inputs: string[] = []
    server.use(http.post('/api/maps/autocomplete', async ({ request }) => {
      const body = await request.json() as { input: string }
      inputs.push(body.input)
      return HttpResponse.json({ suggestions: [], source: 'openstreetmap' })
    }))

    const { result } = renderHook(() => useMapPlaceSearch({ debounceMs: 0 }))
    act(() => { result.current.setQuery('a') })
    // Let the (zero-delay) debounce timer fire: if the hook were going to call the
    // provider for a single character, the request would have landed by now.
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(inputs).toEqual([])
  })

  it('FE-MAP-SEARCH-003: selecting a suggestion exposes the place details as a preview', async () => {
    server.use(http.get('/api/maps/details/:placeId', () => HttpResponse.json({
      place: {
        name: 'Sagrada Família',
        address: 'Carrer de Mallorca 401, Barcelona',
        lat: 41.4036,
        lng: 2.1744,
        website: 'https://sagradafamilia.org',
        phone: '+34 932 08 04 14',
        opening_hours: ['Mon: 9:00 AM - 8:00 PM'],
        open_now: true,
        source: 'openstreetmap',
      },
    })))

    const { result } = renderHook(() => useMapPlaceSearch({ debounceMs: 0 }))
    await act(async () => { await result.current.select('way/123') })

    expect(result.current.preview).toMatchObject({
      placeId: 'way/123',
      name: 'Sagrada Família',
      lat: 41.4036,
      lng: 2.1744,
      website: 'https://sagradafamilia.org',
      open_now: true,
    })
  })

  it('FE-MAP-SEARCH-004: a result without usable coordinates is not previewed', async () => {
    server.use(http.get('/api/maps/details/:placeId', () => HttpResponse.json({
      place: { name: 'Nowhere', address: '', lat: null, lng: null },
    })))

    const { result } = renderHook(() => useMapPlaceSearch({ debounceMs: 0 }))
    await act(async () => { await result.current.select('way/999') })

    // A preview exists to be pointed at on the map — without coordinates there is
    // nothing to point at, and NaN would send the viewport into the void.
    expect(result.current.preview).toBeNull()
  })

  it('FE-MAP-SEARCH-005: clear drops the query, the suggestions and the preview', async () => {
    server.use(
      http.post('/api/maps/autocomplete', () => HttpResponse.json({
        suggestions: [{ placeId: 'way/1', mainText: 'Park Güell', secondaryText: 'Barcelona' }],
        source: 'openstreetmap',
      })),
      http.get('/api/maps/details/:placeId', () => HttpResponse.json({
        place: { name: 'Park Güell', address: 'Barcelona', lat: 41.4145, lng: 2.1527 },
      })),
    )

    const { result } = renderHook(() => useMapPlaceSearch({ debounceMs: 0 }))
    act(() => { result.current.setQuery('park') })
    await waitFor(() => expect(result.current.suggestions).toHaveLength(1))
    await act(async () => { await result.current.select('way/1') })
    expect(result.current.preview).not.toBeNull()

    act(() => { result.current.clear() })

    expect(result.current.query).toBe('')
    expect(result.current.suggestions).toEqual([])
    expect(result.current.preview).toBeNull()
  })

  it('FE-MAP-SEARCH-006: a superseded query never overwrites the newer suggestions', async () => {
    const seen: string[] = []
    let releaseSlow: () => void = () => {}
    const slowGate = new Promise<void>(resolve => { releaseSlow = resolve })

    server.use(http.post('/api/maps/autocomplete', async ({ request }) => {
      const { input } = await request.json() as { input: string }
      seen.push(input)
      if (input === 'par') {
        await slowGate
        return HttpResponse.json({
          suggestions: [{ placeId: 'stale', mainText: 'Stale', secondaryText: '' }],
          source: 'openstreetmap',
        })
      }
      return HttpResponse.json({
        suggestions: [{ placeId: 'fresh', mainText: 'Fresh', secondaryText: '' }],
        source: 'openstreetmap',
      })
    }))

    const { result } = renderHook(() => useMapPlaceSearch({ debounceMs: 0 }))

    act(() => { result.current.setQuery('par') })
    await waitFor(() => expect(seen).toContain('par'))   // slow request is in flight

    act(() => { result.current.setQuery('sagrada') })
    await waitFor(() => expect(result.current.suggestions[0]?.mainText).toBe('Fresh'))

    await act(async () => {
      releaseSlow()
      await new Promise(resolve => setTimeout(resolve, 20))
    })

    expect(result.current.suggestions[0]?.mainText).toBe('Fresh')
  })

  it('FE-MAP-SEARCH-007: the current viewport is sent as the provider location bias', async () => {
    let body: Record<string, unknown> | null = null
    server.use(http.post('/api/maps/autocomplete', async ({ request }) => {
      body = await request.json() as Record<string, unknown>
      return HttpResponse.json({ suggestions: [], source: 'openstreetmap' })
    }))

    const { result } = renderHook(() => useMapPlaceSearch({
      debounceMs: 0,
      getViewportBounds: () => ({ south: 41.3, west: 2.1, north: 41.5, east: 2.2 }),
    }))
    act(() => { result.current.setQuery('tapas') })

    await waitFor(() => expect(body).not.toBeNull())
    expect(body!.locationBias).toEqual({
      low: { lat: 41.3, lng: 2.1 },
      high: { lat: 41.5, lng: 2.2 },
    })
  })

  it('FE-MAP-SEARCH-008: a provider failure is surfaced as an error, not as an empty result', async () => {
    server.use(http.post('/api/maps/autocomplete', () => new HttpResponse(null, { status: 500 })))

    const { result } = renderHook(() => useMapPlaceSearch({ debounceMs: 0 }))
    act(() => { result.current.setQuery('sagrada') })

    // Otherwise the user reads "nothing here" and stops looking, when the truth is
    // that the geocoder is down and the search is worth retrying.
    await waitFor(() => expect(result.current.error).toBe(true))
    expect(result.current.suggestions).toEqual([])
  })

  it('FE-MAP-SEARCH-009: a burst of keystrokes collapses into a single provider call', async () => {
    const inputs: string[] = []
    server.use(http.post('/api/maps/autocomplete', async ({ request }) => {
      const { input } = await request.json() as { input: string }
      inputs.push(input)
      return HttpResponse.json({ suggestions: [], source: 'openstreetmap' })
    }))

    const { result } = renderHook(() => useMapPlaceSearch({ debounceMs: 50 }))
    act(() => { result.current.setQuery('s') })
    act(() => { result.current.setQuery('sa') })
    act(() => { result.current.setQuery('sag') })

    await waitFor(() => expect(inputs).toEqual(['sag']))
    // And nothing trails in afterwards.
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(inputs).toEqual(['sag'])
  })

  it('FE-MAP-SEARCH-010: the interface language is forwarded to the suggestion lookup', async () => {
    let body: Record<string, unknown> | null = null
    server.use(http.post('/api/maps/autocomplete', async ({ request }) => {
      body = await request.json() as Record<string, unknown>
      return HttpResponse.json({ suggestions: [], source: 'openstreetmap' })
    }))

    const { result } = renderHook(() => useMapPlaceSearch({ debounceMs: 0, language: 'fr' }))
    act(() => { result.current.setQuery('cathedrale') })

    await waitFor(() => expect(body).not.toBeNull())
    expect(body!.lang).toBe('fr')
  })

  it('FE-MAP-SEARCH-011: the interface language is forwarded to the details lookup', async () => {
    let lang: string | null = null
    server.use(http.get('/api/maps/details/:placeId', ({ request }) => {
      lang = new URL(request.url).searchParams.get('lang')
      return HttpResponse.json({ place: { name: 'Cathédrale', address: 'Barcelone', lat: 41.38, lng: 2.17 } })
    }))

    const { result } = renderHook(() => useMapPlaceSearch({ debounceMs: 0, language: 'fr' }))
    await act(async () => { await result.current.select('way/42') })

    expect(lang).toBe('fr')
  })

  it('FE-MAP-SEARCH-012: a lookup in flight is reported as loading', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    server.use(http.post('/api/maps/autocomplete', async () => {
      await gate
      return HttpResponse.json({ suggestions: [], source: 'openstreetmap' })
    }))

    const { result } = renderHook(() => useMapPlaceSearch({ debounceMs: 0 }))
    act(() => { result.current.setQuery('sagrada') })

    await waitFor(() => expect(result.current.loading).toBe(true))
    await act(async () => {
      release()
      await new Promise(resolve => setTimeout(resolve, 20))
    })
    expect(result.current.loading).toBe(false)
  })

  it('FE-MAP-SEARCH-013: a superseded details lookup never overwrites the newer preview', async () => {
    const seen: string[] = []
    let releaseSlow: () => void = () => {}
    const slowGate = new Promise<void>(resolve => { releaseSlow = resolve })

    server.use(http.get('/api/maps/details/:placeId', async ({ params }) => {
      const id = String(params.placeId)
      seen.push(id)
      if (id === 'slow') {
        await slowGate
        return HttpResponse.json({ place: { name: 'Stale', address: '', lat: 1, lng: 1 } })
      }
      return HttpResponse.json({ place: { name: 'Fresh', address: '', lat: 2, lng: 2 } })
    }))

    const { result } = renderHook(() => useMapPlaceSearch({ debounceMs: 0 }))

    let slowSelect: Promise<unknown> = Promise.resolve()
    act(() => { slowSelect = result.current.select('slow') })
    await waitFor(() => expect(seen).toContain('slow'))

    await act(async () => { await result.current.select('fresh') })
    expect(result.current.preview?.name).toBe('Fresh')

    await act(async () => {
      releaseSlow()
      await slowSelect
      await new Promise(resolve => setTimeout(resolve, 20))
    })

    expect(result.current.preview?.name).toBe('Fresh')
  })

  it('FE-MAP-SEARCH-014: selecting a place also looks up a photo of it', async () => {
    server.use(
      http.get('/api/maps/details/:placeId', () => HttpResponse.json({
        place: { name: 'Sagrada Família', address: 'Barcelona', lat: 41.4036, lng: 2.1744 },
      })),
      http.get('/api/maps/place-photo/:placeId', () => HttpResponse.json({
        photoUrl: 'https://example.test/sagrada.jpg', attribution: null,
      })),
    )

    const { result } = renderHook(() => useMapPlaceSearch({ debounceMs: 0 }))
    await act(async () => { await result.current.select('way/1') })

    await waitFor(() => expect(result.current.photoUrl).toBe('https://example.test/sagrada.jpg'))
  })

  it('FE-MAP-SEARCH-015: a missing photo never costs us the preview', async () => {
    server.use(
      http.get('/api/maps/details/:placeId', () => HttpResponse.json({
        place: { name: 'Sagrada Família', address: 'Barcelona', lat: 41.4036, lng: 2.1744 },
      })),
      http.get('/api/maps/place-photo/:placeId', () => new HttpResponse(null, { status: 500 })),
    )

    const { result } = renderHook(() => useMapPlaceSearch({ debounceMs: 0 }))
    await act(async () => { await result.current.select('way/1') })

    // The photo is decoration; the place, its address and its hours are the point.
    expect(result.current.preview?.name).toBe('Sagrada Família')
    expect(result.current.photoUrl).toBeNull()
    expect(result.current.error).toBe(false)
  })

  it('FE-MAP-SEARCH-016: a new selection never keeps the previous photo', async () => {
    server.use(
      http.get('/api/maps/details/:placeId', ({ params }) => HttpResponse.json({
        place: { name: String(params.placeId), address: '', lat: 1, lng: 1 },
      })),
      http.get('/api/maps/place-photo/:placeId', ({ params }) => HttpResponse.json({
        photoUrl: String(params.placeId) === 'first' ? 'https://example.test/first.jpg' : null,
      })),
    )

    const { result } = renderHook(() => useMapPlaceSearch({ debounceMs: 0 }))
    await act(async () => { await result.current.select('first') })
    await waitFor(() => expect(result.current.photoUrl).toBe('https://example.test/first.jpg'))

    await act(async () => { await result.current.select('second') })

    expect(result.current.preview?.name).toBe('second')
    expect(result.current.photoUrl).toBeNull()
  })

  it('FE-MAP-SEARCH-017: picking a suggestion closes the list it came from', async () => {
    server.use(
      http.post('/api/maps/autocomplete', () => HttpResponse.json({
        suggestions: [{ placeId: 'way/1', mainText: 'Sagrada Família', secondaryText: 'Barcelona' }],
        source: 'openstreetmap',
      })),
      http.get('/api/maps/details/:placeId', () => HttpResponse.json({
        place: { name: 'Sagrada Família', address: 'Barcelona', lat: 41.4036, lng: 2.1744 },
      })),
      http.get('/api/maps/place-photo/:placeId', () => HttpResponse.json({ photoUrl: null })),
    )

    const { result } = renderHook(() => useMapPlaceSearch({ debounceMs: 0 }))
    act(() => { result.current.setQuery('sagrada') })
    await waitFor(() => expect(result.current.suggestions).toHaveLength(1))

    await act(async () => { await result.current.select('way/1') })

    // Otherwise the dropdown stays open and sits between the field and the preview.
    expect(result.current.suggestions).toEqual([])
    expect(result.current.preview?.name).toBe('Sagrada Família')
  })

  it('FE-MAP-SEARCH-018: an OpenStreetMap preview carries its OSM id', async () => {
    server.use(
      http.get('/api/maps/details/:placeId', () => HttpResponse.json({
        place: {
          name: 'Sagrada Família', address: 'Barcelona', lat: 41.4036, lng: 2.1744,
          osm_id: 'way/123', source: 'openstreetmap',
        },
      })),
      http.get('/api/maps/place-photo/:placeId', () => HttpResponse.json({ photoUrl: null })),
    )

    const { result } = renderHook(() => useMapPlaceSearch({ debounceMs: 0 }))
    await act(async () => { await result.current.select('way/123') })

    expect(result.current.preview?.osm_id).toBe('way/123')
    expect(result.current.preview?.google_place_id).toBeNull()
  })

  it('FE-MAP-SEARCH-019: a Google preview carries its Google place id', async () => {
    server.use(
      http.get('/api/maps/details/:placeId', () => HttpResponse.json({
        place: {
          name: 'Sagrada Família', address: 'Barcelona', lat: 41.4036, lng: 2.1744,
          google_place_id: 'ChIJk_s92NyipBIRUMnDG8Kq2Js', source: 'google',
        },
      })),
      http.get('/api/maps/place-photo/:placeId', () => HttpResponse.json({ photoUrl: null })),
    )

    const { result } = renderHook(() => useMapPlaceSearch({ debounceMs: 0 }))
    await act(async () => { await result.current.select('ChIJk_s92NyipBIRUMnDG8Kq2Js') })

    // Without it the created place has no provider handle, so the inspector can
    // never enrich it with ratings, photos or hours later on.
    expect(result.current.preview?.google_place_id).toBe('ChIJk_s92NyipBIRUMnDG8Kq2Js')
    expect(result.current.preview?.osm_id).toBeNull()
  })
})
