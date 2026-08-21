// FE-MAP-PREVIEW-001 onwards
import { render, screen } from '../../../tests/helpers/render'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
import PlacePreviewCard from './PlacePreviewCard'
import type { MapPlacePreview } from './useMapPlaceSearch'

const sagrada: MapPlacePreview = {
  placeId: 'way/1',
  name: 'Sagrada Família',
  address: 'Carrer de Mallorca 401, Barcelona',
  lat: 41.4036,
  lng: 2.1744,
  website: 'https://sagradafamilia.org',
  phone: '+34 932 08 04 14',
  opening_hours: ['Mon: 9:00 AM - 8:00 PM', 'Tue: 9:00 AM - 8:00 PM'],
  open_now: true,
  rating: 4.7,
  rating_count: 1200,
  source: 'openstreetmap',
  osm_id: 'way/1',
  google_place_id: null,
}

function setup(overrides: Partial<React.ComponentProps<typeof PlacePreviewCard>> = {}) {
  const props = {
    place: sagrada,
    onAdd: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
  render(<PlacePreviewCard {...props} />)
  return props
}

describe('PlacePreviewCard', () => {
  it('FE-MAP-PREVIEW-001: the place is identified by name and address', () => {
    setup()
    expect(screen.getByText('Sagrada Família')).toBeTruthy()
    expect(screen.getByText(/Carrer de Mallorca 401/)).toBeTruthy()
  })

  it('FE-MAP-PREVIEW-002: adding hands the previewed place back, nothing more', async () => {
    const user = userEvent.setup()
    const props = setup()

    await user.click(screen.getByRole('button', { name: /add to trip/i }))

    // The card decides nothing: it hands the place over and the caller opens the
    // pre-filled form, so the place still isn't created at this point.
    expect(props.onAdd).toHaveBeenCalledWith(sagrada)
  })

  it('FE-MAP-PREVIEW-003: dismissing the card asks for the preview to be dropped', async () => {
    const user = userEvent.setup()
    const props = setup()

    await user.click(screen.getByRole('button', { name: /dismiss|close/i }))

    expect(props.onClose).toHaveBeenCalled()
  })

  it('FE-MAP-PREVIEW-004: opening hours are listed when the provider supplied them', async () => {
    const user = userEvent.setup()
    setup()

    await user.click(screen.getByRole('button', { name: /opening hours/i }))

    expect(screen.getByText(/Mon: 9:00 AM - 8:00 PM/)).toBeTruthy()
  })

  it('FE-MAP-PREVIEW-005: no opening-hours control when the provider gave none', () => {
    setup({ place: { ...sagrada, opening_hours: null, open_now: null } })
    expect(screen.queryByRole('button', { name: /opening hours/i })).toBeNull()
  })

  it('FE-MAP-PREVIEW-006: an open-now badge shows when the provider knows', () => {
    setup()
    // Exact match: the card also says "Opening Hours", which a loose /open/i would hit.
    expect(screen.getByText('Open')).toBeTruthy()
  })

  it('FE-MAP-PREVIEW-007: a closed-now badge shows when the place is shut', () => {
    setup({ place: { ...sagrada, open_now: false } })
    expect(screen.getByText(/closed/i)).toBeTruthy()
  })

  it('FE-MAP-PREVIEW-008: the website and the phone are offered as links', () => {
    setup()
    expect(screen.getByRole('link', { name: /sagradafamilia\.org/i })).toHaveAttribute('href', 'https://sagradafamilia.org')
    expect(screen.getByRole('link', { name: /\+34 932 08 04 14/ })).toHaveAttribute('href', 'tel:+34932080414')
  })

  it('FE-MAP-PREVIEW-009: the rating is shown when the provider supplied one', () => {
    setup()
    expect(screen.getByText(/4\.7/)).toBeTruthy()
  })

  it('FE-MAP-PREVIEW-010: a viewer who cannot edit places gets no add button', () => {
    setup({ canAdd: false })
    expect(screen.queryByRole('button', { name: /add to trip/i })).toBeNull()
  })

  it('FE-MAP-PREVIEW-011: a photo is shown when one was found', () => {
    setup({ photoUrl: 'https://example.test/sagrada.jpg' })
    expect(screen.getByRole('img')).toHaveAttribute('src', 'https://example.test/sagrada.jpg')
  })
})
