/**
 * Le vocabulaire de NAVITIME Route (totalnavi) `/route_transit`, isolé ici : ce
 * fichier est le seul à toucher quand l'API bouge.
 *
 * Spec : https://api-sdk.navitime.co.jp/api/specs/api_guide/route_transit.html
 */

// ── Réponse ──────────────────────────────────────────────────────────────────
// Le sous-ensemble que TREK lit. Champs optionnels partout : on caste la réponse
// une fois côté mapper et on valide seulement ce dont on dépend vraiment.

export interface NavitimeResponse {
  unit?: { currency?: string };
  items?: NavitimeRoute[];
}

export interface NavitimeRoute {
  summary?: { move?: NavitimeSummaryMove };
  /** Alterne point, move, point, … : chaque `move` est encadré par ses deux points. */
  sections?: NavitimeSection[];
  /** Une FeatureCollection par itinéraire, seulement si `shape=true`. */
  shapes?: { features?: NavitimeShapeFeature[] };
}

export interface NavitimeSummaryMove {
  from_time?: string;
  to_time?: string;
  /** Nombre de correspondances tel que compté par NAVITIME. */
  transit_count?: number;
  reference_fare?: { lowest_total_ticket?: number; lowest_total_ic?: number };
}

export type NavitimeSection = NavitimePoint | NavitimeMove;

export interface NavitimePoint {
  type: 'point';
  name?: string;
  coord?: { lat?: number; lon?: number };
  track?: string;
}

export interface NavitimeMove {
  type: 'move';
  /** Clé de MOVE_MODES. */
  move?: string;
  from_time?: string;
  to_time?: string;
  /** Unité déclarée par `unit.distance`, en pratique le mètre. */
  distance?: number;
  line_name?: string;
  transport?: {
    name?: string;
    color?: string;
    company?: { name?: string };
    links?: Array<{
      destination?: { name?: string };
      /** Arrêts desservis, renvoyés grâce à `options=railway_calling_at`. */
      calling_at?: unknown[];
      /** NAVITIME l'envoie tantôt en booléen, tantôt en chaîne. */
      is_timetable?: boolean | string;
    }>;
  };
}

export interface NavitimeShapeFeature {
  geometry?: { type?: string; coordinates?: unknown };
  /** `ways` vaut 'walk' ou 'transport'. */
  properties?: { ways?: string };
}

// ── Modes ────────────────────────────────────────────────────────────────────

/**
 * Vocabulaire `move` de NAVITIME → mode TREK. Source unique : le mapper la lit
 * de gauche à droite pour étiqueter un leg, l'adapter de droite à gauche pour
 * construire `unuse`. Les clés sont aussi, à ALWAYS_USED près, les douze valeurs
 * que `unuse` accepte. Ajouter un `move` ici suffit ; l'oublier le rend à la
 * fois OTHER et non filtrable.
 */
export const MOVE_MODES = {
  walk: 'WALK',
  car: 'OTHER', // 車
  bicycle: 'OTHER', // 自転車
  unknown: 'OTHER', // 不明
  domestic_flight: 'AIRPLANE', // 航空路線
  ferry: 'FERRY', // フェリー
  superexpress_train: 'HIGHSPEED_RAIL', // 新幹線
  sleeper_ultraexpress: 'NIGHT_RAIL', // 寝台特急
  ultraexpress_train: 'RAIL', // 特急
  express_train: 'RAIL', // 急行
  rapid_train: 'RAIL', // 快速
  semiexpress_train: 'RAIL', // 有料列車
  local_train: 'RAIL', // 普通列車
  local_bus: 'BUS', // 路線バス
  shuttle_bus: 'COACH', // 長距離バス（空港連絡バス）
  highway_bus: 'COACH', // 高速バス
} as const;

export type NavitimeMoveKey = keyof typeof MOVE_MODES;

/** NAVITIME ne sait pas exclure ces déplacements : ils ne vont jamais dans `unuse`. */
const ALWAYS_USED = new Set<string>(['walk', 'car', 'bicycle', 'unknown']);

/**
 * Noms qu'une génération antérieure de l'API employait, gardés pour lire une
 * réponse de l'un ou l'autre vocabulaire. Jamais envoyés dans `unuse` : ils y
 * seraient refusés. À supprimer dès qu'une réponse réelle aura tranché.
 */
const LEGACY_MOVES: Record<string, NavitimeMoveKey> = {
  route_bus: 'local_bus',
  superexpress: 'superexpress_train',
  limited_express: 'ultraexpress_train',
  express: 'express_train',
  rapid: 'rapid_train',
  semiexpress: 'semiexpress_train',
};

/** Mode TREK d'une section `move`. */
export function moveMode(move: string | undefined): string {
  const key = move?.trim().toLowerCase() ?? '';
  return MOVE_MODES[(LEGACY_MOVES[key] ?? key) as NavitimeMoveKey] ?? 'OTHER';
}

/** Les `move` que `unuse` accepte, avec le mode TREK que chacun sert. */
export function excludableMoves(): Array<[move: string, mode: string]> {
  return Object.entries(MOVE_MODES).filter(([move]) => !ALWAYS_USED.has(move));
}
