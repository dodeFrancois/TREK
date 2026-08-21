// FE-MAP-SEARCH-PILL-001 onwards
import { render, screen } from '../../../tests/helpers/render'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
import MapSearchPill from './MapSearchPill'

const suggestions = [
  { placeId: 'way/1', mainText: 'Sagrada Família', secondaryText: 'Barcelona, Spain' },
  { placeId: 'way/2', mainText: 'Park Güell', secondaryText: 'Barcelona, Spain' },
]

function setup(overrides: Partial<React.ComponentProps<typeof MapSearchPill>> = {}) {
  const props = {
    query: '',
    onQueryChange: vi.fn(),
    suggestions: [],
    onSelect: vi.fn(),
    onClear: vi.fn(),
    ...overrides,
  }
  render(<MapSearchPill {...props} />)
  return props
}

describe('MapSearchPill', () => {
  it('FE-MAP-SEARCH-PILL-001: clicking a suggestion asks for that place, not for a new place', async () => {
    const user = userEvent.setup()
    const props = setup({ query: 'sagrada', suggestions })

    await user.click(screen.getByText('Sagrada Família'))

    expect(props.onSelect).toHaveBeenCalledWith('way/1')
  })

  it('FE-MAP-SEARCH-PILL-002: typing reports the keystroke to the owner of the query', async () => {
    const user = userEvent.setup()
    // The field is controlled: it reports each keystroke and never keeps state of
    // its own, so the accumulated query stays the caller's business.
    const props = setup()

    await user.type(screen.getByRole('textbox'), 's')

    expect(props.onQueryChange).toHaveBeenCalledWith('s')
  })

  it('FE-MAP-SEARCH-PILL-003: the clear control abandons the search', async () => {
    const user = userEvent.setup()
    // With no suggestions open, the clear control is the pill's only button.
    const props = setup({ query: 'sagrada' })

    await user.click(screen.getByRole('button'))

    expect(props.onClear).toHaveBeenCalled()
  })

  it('FE-MAP-SEARCH-PILL-004: nothing to clear before anything is typed', () => {
    setup()

    expect(screen.queryByRole('button')).toBeNull()
  })

  it('FE-MAP-SEARCH-PILL-005: a failed lookup replaces the suggestions with the failure', () => {
    setup({ query: 'sagrada', suggestions, error: true })

    expect(screen.getByText(/unavailable/i)).toBeTruthy()
    // Showing a stale or empty list would read as "there is nothing there".
    expect(screen.queryByText('Sagrada Família')).toBeNull()
  })

  it('FE-MAP-SEARCH-PILL-006: a lookup in flight shows a busy indicator', () => {
    setup({ query: 'sagrada', loading: true })

    expect(screen.getByRole('status')).toBeTruthy()
  })
})
