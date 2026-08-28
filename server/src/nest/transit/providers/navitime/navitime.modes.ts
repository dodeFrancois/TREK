/**
 * NAVITIME's `move` vocabulary mapped to TREK's leg modes.
 *
 * Read left to right by the mapper (label a leg) and right to left by the
 * request builder (build `unuse`). The keys are also, ALWAYS_USED aside, exactly
 * the values `unuse` accepts.
 *
 * The ordinary trains map onto REGIONAL_RAIL / LONG_DISTANCE rather than RAIL on
 * purpose: the client's "rail" chip is
 * 'HIGHSPEED_RAIL,LONG_DISTANCE,NIGHT_RAIL,REGIONAL_RAIL,SUBURBAN'
 * (TransitSearchPanel.tsx:44) and never emits RAIL, which in the MOTIS taxonomy
 * swallows SUBWAY. With RAIL as the target, unchecking any single chip would put
 * every train into `unuse` — unchecking "ferry" in Tokyo would drop the Yamanote
 * line. The displayed mode is unaffected: the client only tests `=== 'WALK'` and
 * uses the mode as the fallback label when `line` is null, and NAVITIME always
 * sends line_name on a transit move.
 *
 * Known limit, documented rather than worked around: the client's `subway`,
 * `tram` and `cable` chips have no NAVITIME key at all. Unchecking "subway"
 * does not remove the Tokyo Metro (it arrives as local_train), and selecting
 * only "tram" returns nothing. That is the granularity of the data, not a bug;
 * hiding those chips would mean exposing the provider to the client.
 */
export const MOVE_MODES: Record<string, string> = {
  walk: 'WALK',
  car: 'OTHER',
  bicycle: 'OTHER',
  unknown: 'OTHER',
  domestic_flight: 'AIRPLANE',
  ferry: 'FERRY',
  superexpress_train: 'HIGHSPEED_RAIL',
  sleeper_ultraexpress: 'NIGHT_RAIL',
  local_train: 'REGIONAL_RAIL',
  rapid_train: 'REGIONAL_RAIL',
  semiexpress_train: 'REGIONAL_RAIL',
  express_train: 'REGIONAL_RAIL',
  ultraexpress_train: 'LONG_DISTANCE',
  local_bus: 'BUS',
  shuttle_bus: 'COACH',
  highway_bus: 'COACH',
};

/** Never sent in `unuse`: walking is how a journey reaches its first stop. */
export const ALWAYS_USED: readonly string[] = ['walk', 'car', 'bicycle', 'unknown'];

/**
 * An earlier NAVITIME vocabulary, READ ONLY. These names would be rejected in
 * `unuse`, so they must never reach it. Their TREK targets are inferred by
 * alignment with the modern equivalents (`limited_express` = ultraexpress_train,
 * `express`/`rapid`/`semiexpress` = their `*_train` forms, `superexpress` =
 * superexpress_train, `route_bus` = local_bus); no captured response contains
 * them yet.
 */
export const LEGACY_MOVES: Record<string, string> = {
  route_bus: 'BUS',
  superexpress: 'HIGHSPEED_RAIL',
  limited_express: 'LONG_DISTANCE',
  express: 'REGIONAL_RAIL',
  rapid: 'REGIONAL_RAIL',
  semiexpress: 'REGIONAL_RAIL',
};

/** A leg's TREK mode. Unknown keys become OTHER — the schema wants ^[A-Z_]+$, never empty. */
export function navitimeMode(move: string | undefined): string {
  if (!move) return 'OTHER';
  return MOVE_MODES[move] ?? LEGACY_MOVES[move] ?? 'OTHER';
}

/**
 * The `unuse` keys for a TREK include-list. `modes` undefined means "no filter",
 * which is what the client sends when every chip is checked.
 */
export function unuseFor(modes: string | undefined): string[] {
  if (!modes) return [];
  const wanted = new Set(
    modes
      .split(',')
      .map((m) => m.trim().toUpperCase())
      .filter(Boolean),
  );
  if (wanted.size === 0) return [];
  return Object.keys(MOVE_MODES).filter((key) => !ALWAYS_USED.includes(key) && !wanted.has(MOVE_MODES[key]));
}
