# NAVITIME comme provider de transport public — conception

Date : 2026-08-28 · Branche : `feat/navitime-provider` (depuis `main`, v4.0.0)

## 1. Objet

Ajouter NAVITIME comme provider de recherche d'itinéraires de transport public, en
alternative à Transitous, sélectionnable par l'administrateur.

C'est un **port**, pas une résolution de conflits. Une implémentation existe sur une
branche non rebasable : elle a éclaté le transit dans `server/src/services/transit/`,
là où v4.0.0 l'a éclaté dans `server/src/nest/transit/` et a supprimé tout
`server/src/services/`. Un rebase produirait du code orphelin dans un répertoire mort.
La branche de référence n'a pas été consultée.

## 2. Architecture de départ (v4.0.0)

```
server/src/nest/transit/
  transit.service.ts            281 l.  @Injectable, Transitous/MOTIS en dur : geocode(), plan()
  transit.helpers.ts             99 l.  SCHEDULED_TRANSIT_MODES, types, deriveTransitStats()
  transit.controller.ts          70 l.  @Controller('api/transit'), GET geocode + plan
  transit.mcp.ts                255 l.  outils MCP search_transit_stops / routes / create_journey
  transit.module.ts              23 l.
  transit-itinerary.helpers.ts  313 l.  schémas zod, validation d'itinéraire, MAX_GEOMETRY_CHARS
```

`transit.service.ts` mêle aujourd'hui le cache, la validation de coordonnées,
`MAX_RESPONSE_BYTES`, `safeColor`, `mapStop` et l'appel MOTIS.

## 3. Décisions de conception

### 3.1 NAVITIME est un provider de `plan` uniquement

L'abonnement RapidAPI n'expose que `/route_transit`, `/shape_transit`, `/fare_table`,
`/fare_comparison`. **Aucun géocodage.** `GET /api/transit/geocode` reste donc servi par
Transitous en toutes circonstances — le sélecteur de gares du client
(`TransitSearchPanel.tsx:126`) ne connaît pas le provider.

### 3.2 Le seam : une interface, deux `@Injectable`

```ts
// providers/transit-planner.ts
export type TransitProvider = 'transitous' | 'navitime';

export interface TransitPlanner {
  /** La valeur stockée dans app_settings.transit_provider. */
  readonly id: TransitProvider;
  /** Refuser plutôt que dégrader : le service échoue si le provider n'est pas configuré. */
  isConfigured(): boolean;
  plan(query: PlanQuery): Promise<TransitPlanResult>;
}
```

Chaque membre a un appelant réel : `id` sert à la clé de cache et au `provider` des
métadonnées de réservation ; `isConfigured()` porte l'échec fermé sans que
`TransitService` sache lequel des deux réclame une clé ; `plan()` est le dispatch.

Le dispatch, exhaustif par typecheck :

```ts
private readonly planners: Record<TransitProvider, TransitPlanner>;

constructor(
  private readonly db: DatabaseService,
  transitous: TransitousPlanner,
  navitime: NavitimePlanner,
) {
  this.planners = { transitous, navitime };
}
```

Ajouter un troisième provider = une valeur dans l'union, un paramètre au constructeur,
une clé dans le littéral, une entrée dans `transit.module.ts`. Les quatre sont signalés
par le compilateur.

`plan()` devient : valider (`isCoord`, modes, `maxTransfers`) → résoudre le provider →
**503 si `isConfigured()` est faux**, jamais de repli silencieux → clé de cache
`${provider}:…` → `planners[provider].plan(q)` → cacher.

`TransitService` gagne un constructeur avec `DatabaseService` (il n'injecte rien
aujourd'hui). `DatabaseModule` est `@Global()`, `transit.module.ts` n'a pas besoin de
l'importer.

### 3.3 Arborescence cible

```
server/src/nest/transit/
  transit.service.ts               validation + cache + geocode + dispatch      (~150 l.)
  transit.settings.ts              readTransitProvider(db), readNavitimeApiKey(db)
  transit.http.ts                  fetchJson : timeout 8 s, garde 5 Mo, 429/502
  transit.helpers.ts               + safeColor, + POLYLINE_PRECISION
  providers/
    transit-planner.ts             l'interface + TransitProvider + TransitPlanResult
    transitous.planner.ts          le mapping MOTIS déménage ici tel quel       (~130 l.)
    navitime/
      navitime.planner.ts          @Injectable : clé, requête, fetch, colle      (~50 l.)
      navitime.request.ts          construction des paramètres                   (~70 l.)
      navitime.mapper.ts           sections → TransitLeg[]           — pur      (~150 l.)
      navitime.geometry.ts         shapes → polyline par leg         — pur      (~120 l.)
      navitime.modes.ts            MOVE_MODES / ALWAYS_USED                     (~40 l.)
```

`NavitimePlanner` **ne contient aucun algorithme** : le mapper et la géométrie sont des
fonctions pures sur le JSON brut, sans classe, sans DI, sans réseau. C'est ce qui permet
de les exécuter directement sur les captures réelles.

`transit.http.ts` est la seule chose factorisée entre les deux providers : c'est le
contrat d'erreur (`status` 429/502) sur lequel `transit.controller.ts` s'appuie déjà.

### 3.4 Configuration administrateur

**Le provider** → `app_settings.transit_provider`, via le mécanisme générique existant :
`ADMIN_SETTINGS_KEYS` (`server/src/nest/auth/auth.helpers.ts:32`) + `PUT /auth/app-settings`.
On hérite du contrôle `role === 'admin'`, de l'audit `settings.app_update` et du câblage
d'`AdminSettingsTab`. La liste est une liste de permissions d'écriture, pas une liste
d'auth (`allowed_file_types`, `notify_trip_reminder` y figurent déjà).

La lecture reste dans le domaine transit (`transit.settings.ts`), comme
`webauthn-config.service.ts` lit ses propres lignes. **Défensive** : `'navitime'` sur
correspondance exacte, `'transitous'` dans tous les autres cas — valeur inconnue, ligne
absente, install antérieur.

**La clé** → **stockage identique** aux clés Google Maps et Unsplash : ligne `app_settings`
nommée `navitime_api_key`, chiffrée par `apiKeyCrypto`, relue par `readInstanceApiKey`.
**Aucune variable d'environnement**, ni pour la clé ni pour le provider : les deux sont
des réglages d'instance que l'administrateur écrit depuis l'interface. Il n'y a donc
qu'une seule source pour chacun, et rien à réconcilier entre l'env et la base.

**Sans niveau par utilisateur.** Ce niveau existe pour maps/unsplash pour une raison
historique que le commentaire du fichier nomme : `PUT /me/api-keys` a toujours accepté
une clé personnelle. NAVITIME n'a pas ce passé, et le lui donner coûterait une colonne
`users.navitime_api_key` et une migration.

**Écrite par la route admin, pas par `PUT /auth/me/api-keys`.** Cette dernière n'est pas
gardée admin (la classe ne porte que `JwtAuthGuard` ; un `isAdmin` interne décide de la
recopie vers `app_settings`), et y greffer NAVITIME demanderait d'étendre quatre tuples
codés en dur dans `user-profile.service.ts` plus `getSettings`. La clé rejoint donc
`ADMIN_SETTINGS_KEYS` aux côtés de `smtp_pass`, `admin_webhook_url` et
`admin_ntfy_token`, qui y sont déjà chiffrés à l'écriture, protégés par le ré-écho du
masque `••••••••` et masqués à la lecture. Conséquences : la route est gardée admin par
le même contrôle que le provider, les deux réglages partent dans **une seule** requête,
et la clé est masquée en réponse au lieu d'être rendue en clair.

`INSTANCE_API_KEY_NAMES` n'est **pas** touchée : sa docstring dit « instance names whose
per-user column is still honoured as a last resort », ce qui exclut NAVITIME par
définition. Seuls le type `InstanceApiKeyName` s'élargit et `USER_ROW_SQL` passe en
`Partial<Record<…>>`, pour que `readInstanceApiKey` accepte le nouveau nom.

**Un piège à ne pas manquer** : `updateAppSettings` écrit `debugDetails[k] = body[k]`
pour chaque clé changée, en n'exceptant que `smtp_pass`. Sans ajout, la clé NAVITIME
partirait en clair dans l'audit.

## 4. La requête NAVITIME

```
GET https://navitime-route-totalnavi.p.rapidapi.com/route_transit
en-têtes : x-rapidapi-key, x-rapidapi-host
start=<lat,lon>   goal=<lat,lon>        (q.from / q.to, déjà validés par isCoord)
limit=8                                  (aligné sur numItineraries=8 de MOTIS)
shape=true
shape_color=railway_line
options=railway_calling_at
start_time=YYYY-MM-DDTHH:MM:00           (ou goal_time quand arriveBy)
unuse=<clés séparées par des POINTS>
```

- `options` n'accepte sur `/route_transit` que `railway_calling_at`, `bus_commuter_pass`,
  `congestion`, `co2`, `revision_info`. `transport_shape` n'existe que sur `/shape_transit`.
- **`unuse` est séparé par des points**, pas des virgules (« ピリオド区切り »). C'est le bug
  jamais corrigé sur la branche de référence.
- L'heure est une heure locale nue, prise au fuseau du point concerné : `resolveTimeZone`
  sur le départ (ou l'arrivée quand `arriveBy`), puis `localParts`, qui rend `HH:MM` —
  d'où le `:00` ajouté. `q.time` absent ⇒ paramètre omis, NAVITIME prend l'heure
  courante, comme MOTIS aujourd'hui.
- `maxTransfers` n'existe pas sur `/route_transit`. `summary.move.transit_count` porte la
  réponse : **filtre post-mapping** plutôt qu'un paramètre ignoré en silence.

## 5. Table des modes

`MOVE_MODES` est lue de gauche à droite par le mapper (étiqueter un leg) et de droite à
gauche par le constructeur de requête (construire `unuse`). Les clés sont aussi, à
`ALWAYS_USED` près, les valeurs que `unuse` accepte.

Il n'y a **pas** de table d'un vocabulaire antérieur : les noms `route_bus`,
`superexpress`, `limited_express`, `express`, `rapid`, `semiexpress` n'apparaissent nulle
part dans la documentation NAVITIME et venaient d'une lecture approximative de la version
japonaise. Aucune capture ne les contient. Une clé inconnue tombe sur `'OTHER'`.

```
walk                  → WALK              local_train        → REGIONAL_RAIL
car / bicycle         → OTHER             rapid_train        → REGIONAL_RAIL
unknown               → OTHER             semiexpress_train  → REGIONAL_RAIL
domestic_flight       → AIRPLANE          express_train      → REGIONAL_RAIL
ferry                 → FERRY             ultraexpress_train → LONG_DISTANCE
superexpress_train    → HIGHSPEED_RAIL    local_bus          → BUS
sleeper_ultraexpress  → NIGHT_RAIL        shuttle_bus        → COACH
                                          highway_bus        → COACH
```

`ALWAYS_USED` = `walk`, `car`, `bicycle`, `unknown` — jamais envoyés dans `unuse`.

Clé absente de la table ⇒ `'OTHER'` (le schéma exige `^[A-Z_]+$`, jamais vide).

### Pourquoi les trains ordinaires ne vont pas sur `RAIL`

Le client n'émet **jamais** `RAIL` : la puce « rail » vaut
`HIGHSPEED_RAIL,LONG_DISTANCE,NIGHT_RAIL,REGIONAL_RAIL,SUBURBAN`
(`TransitSearchPanel.tsx:44`), `RAIL` en étant délibérément exclu parce que dans la
taxonomie MOTIS il embarque `SUBWAY`.

Avec `local_train → RAIL`, dès que l'utilisateur décoche une seule puce, `RAIL` n'est pas
dans l'ensemble demandé et les cinq clés de train partent dans `unuse` : **décocher
« ferry » à Tokyo supprimerait la Yamanote.** Seul le cas « tout coché » y échappe, le
client n'envoyant alors aucun `modes` (`TransitSearchPanel.tsx:380`).

Le coût d'affichage du déplacement est nul : `leg.mode` ne sert côté client qu'au test
`=== 'WALK'` (`transitDisplay.tsx:69`) et au libellé de repli `leg.line || leg.mode`
(`transitDisplay.tsx:82`, `DayPlanSidebarTransportDetailModal.tsx:180`). NAVITIME envoie
toujours `line_name` sur un move transit. Aucun `switch` sur les modes nulle part.

`domestic_flight → AIRPLANE` reste tel quel et se fait donc exclure sur toute sélection
partielle — exactement ce que MOTIS fait aussi, comportement identique entre providers.

### Limite assumée

Les puces `subway`, `tram` et `cable` n'ont aucune clé NAVITIME. Décocher « métro » ne
retire pas le Tokyo Metro (il arrive en `local_train`) et ne cocher que « tram » ne rend
rien. Limite de granularité de la donnée. Documentée, non masquée : masquer les puces
demanderait d'exposer le provider au client via `app-config`.

## 6. Le mapper

```ts
export interface NavitimeMapped {
  itinerary: TransitItinerary;   // legs sans géométrie
  /** Index des legs qui sont une correspondance (`next_transit` sur le move précédent). */
  transferLegs: Set<number>;
}
export function mapNavitimeItinerary(item: unknown): NavitimeMapped | null;
```

`transferLegs` existe parce que c'est la **seule** information dont la géométrie a besoin
et que `TransitLeg` ne porte pas : le mode donne marche/transit, `intermediateStops`
donne le décompte, `from`/`to` donnent les coordonnées du connecteur.

`sections` alterne `point`, `move`, `point`, … : chaque `move` est un leg borné par ses
deux voisins.

| `TransitLeg` | source NAVITIME |
|---|---|
| `mode` | `MOVE_MODES[move]`, sinon `'OTHER'` |
| `from` / `to` | les sections `point` voisines du `move` |
| `…name` | `point.name`, mais `start`/`goal` → **`'START'` / `'END'`** |
| `…lat` / `…lng` | `point.coord.lat` / `point.coord.lon` |
| `…time` | `move.from_time` / `move.to_time` (ISO avec décalage) |
| `…scheduledTime` | `null` — NAVITIME n'a pas la notion |
| `…track` | `point.track` |
| `duration` | `to_time − from_time` en secondes, pas `time` (qui dépend de `unit.time`) |
| `distance` | `move.distance`, déjà en mètres |
| `line` | `move.line_name`, **`null` sur une marche** (NAVITIME y met `徒歩`) |
| `headsign` | `transport.links[0].destination.name` |
| `agency` | `transport.company.name` |
| `lineColor` | `safeColor(transport.color)` |
| `lineTextColor` | `null` |
| `intermediateStops` | `transport.calling_at?.length ?? 0` |

Niveau itinéraire : `startTime` / `endTime` = `summary.move.from_time` / `to_time`, puis
`deriveTransitStats(start, end, legs, summary.move.transit_count)`.

`'START'` / `'END'` plutôt que `start` / `goal` : c'est la convention MOTIS, déjà traitée
par `cleanTransitItineraryNames` côté serveur **et** par `cleanStop` côté client
(`TransitSearchPanel.tsx:384`). En la réutilisant, rien à modifier en aval.

**`calling_at` est porté par `transport`, pas par un `link`.** Une clé absente vaut zéro
gare intermédiaire — ce n'est pas un report sur le leg suivant (vérifié §10).

## 7. La géométrie

`shapes` est **une FeatureCollection par itinéraire**, jamais une par leg, et il n'existe
**aucune clé de jointure** : `properties.section` et `properties.route_no` sont constants
sur toutes les features d'un itinéraire. Ce qui se recoupe, c'est l'ordre et un décompte :

> NAVITIME émet exactement **une feature transport par inter-gare**, donc
> `calling_at.length + 1` features pour un leg transit.

Une correspondance n'a **aucune** feature. Son motif dans `sections` :

```
move transit (next_transit: true) → point → move walk (distance: 0, line_name 徒歩（地下鉄）)
→ point → move transit
```

Son tracé n'est pas récupérable (pas d'endpoint piéton dans l'abonnement) : il est
**fabriqué**, une LineString à deux points entre les `coord` des deux `point`.

### L'algorithme

Deux listes parcourues de front, un curseur, **aucun calcul de distance et aucune lecture
de couleur** :

```
curseur = 0
pour chaque leg, dans l'ordre :
    correspondance  → ne consomme rien
    marche          → consomme la série `ways == 'walk'` consécutive qui commence au
                      curseur (série vide ⇒ échec)
    transit         → consomme exactement intermediateStops + 1 features, toutes
                      `ways == 'transport'` (sinon échec ; moins de features restantes
                      que demandé ⇒ échec)

curseur != nombre de features ⇒ échec

# seulement ici, une fois toutes les vérifications passées :
pour chaque correspondance → segment droit entre les `coord` de ses deux points
```

```ts
export function attachNavitimeGeometry(mapped: NavitimeMapped, features: NavitimeShapeFeature[]): {
  itinerary: TransitItinerary;
  /** Non nul quand l'itinéraire sort sans géométrie — motif à journaliser. */
  fallback: string | null;
};
```

La fonction reste pure ; le motif remonte et c'est `NavitimePlanner` qui journalise.

### Le tout-ou-rien est obligatoire, et global

Un échec rend l'itinéraire **entier** sans géométrie. Vérifié dans v4.0.0 :
`reservationsMapbox.ts:304` et `ReservationOverlay.tsx:232` ne tracent leurs arcs droits
de secours que si **aucune** leg n'a de géométrie, et `transitGeometry.ts:57` saute les
legs dont `geometry` est nul. Une géométrie partielle produit donc exactement le trou
qu'on cherche à éviter.

**Corollaire** : les connecteurs de correspondance sont posés **après** les vérifications.
Sinon ce seul leg tracé désactiverait le repli pour tous les autres.

### Le log

Le garde-fou va là, pas à la construction de la requête : c'est le seul endroit qui
détecte réellement que `options=railway_calling_at` a cessé d'être honoré. Sans lui, la
régression est muette — tout tombe en lignes droites sans une trace.

### Trois pistes écartées

1. **Comparer des coordonnées pour l'égalité.** C'était le bug d'origine : NAVITIME répète
   le point de jonction avec un arrondi différent (`139.701875` / `139.70188`, soit 0,45 m,
   et jusqu'à 2,45 m). On **concatène brut** — un point quasi doublé est invisible au rendu.
2. **Un seuil de distance ou un argmin** pour trouver où couper.
3. **`properties.inline.color`.** Il vaut bien `transport.color` avec
   `shape_color=railway_line`, mais c'est du style : deux legs sur une ligne de même
   couleur casseraient le découpage.

### L'encodeur

NAVITIME renvoie du GeoJSON brut, c'est donc TREK qui encode : Google encoded polyline,
**latitude d'abord**, précision 6 (~11 cm). Le client décode chaque leg avec le
`geometryPrecision` reçu (`transitGeometry.ts:17`). MOTIS, lui, envoie le polyline déjà
encodé avec sa propre précision — la constante n'y sert que de défaut.

`POLYLINE_PRECISION = 6` monte dans `transit.helpers.ts` : il remplace un `6` magique qui
apparaît déjà deux fois côté serveur. `encodePolyline` reste local à
`navitime.geometry.ts` tant qu'il n'a qu'un appelant.

### Une hypothèse nommée

La consommation gloutonne des marches suppose que **deux legs de marche
non-correspondance ne se suivent jamais**. Si ça arrivait, le premier avalerait les deux
séries et le second échouerait — donc repli total, jamais un tracé faux. Le cas n'existe
pas dans les captures, et l'échec est du bon côté, mais c'est une hypothèse et pas une
garantie de l'API.

## 8. `isTimetable`

`is_timetable` arrive tantôt booléen tantôt chaîne. Confirmé = `v === true || v === 'true'` ;
tout le reste — `false`, `'false'`, absent, inconnu — vaut « non confirmé ».

Un itinéraire est horaire si **tous** les liens de **tous** ses moves transit sont
confirmés (aucun lien ⇒ non horaire). La réponse est horaire si **tous** ses itinéraires
le sont. Prudent par construction : un lien sans indication, ou des indications mêlées,
valent « estimé ».

```ts
export interface TransitPlanResult {
  itineraries: TransitItinerary[];
  /** Faux dès qu'un itinéraire n'est pas confirmé horaire — déclenche le bandeau client. */
  isTimetable: boolean;
}
```

`TransitousPlanner` rend `true` : les horaires GTFS sont des horaires.

**Au niveau réponse et pas au niveau itinéraire**, pour une raison précise :
`transitItinerarySchema` est le contrat validé que l'outil MCP `create_transit_journey`
reçoit de l'extérieur. Y ajouter un champ, même optionnel, toucherait au contrat d'entrée
d'un outil. Au niveau réponse, **`transitItinerarySchema` ne change pas du tout**.

Côté client : `TransitSearchPanel` lit `d.isTimetable === false` et affiche
`transit.estimatedTimes`.

## 9. Effets de bord

- **La clé de cache** est aujourd'hui construite sur les paramètres MOTIS
  (`plan:fromPlace=…`). Elle doit être bâtie sur la `PlanQuery` TREK **et** l'identifiant
  du provider, sinon un changement de provider sert les itinéraires du précédent pendant
  60 s. Le cache reste partagé avec `geocode` (LRU, TTL 60 s, max 200).
- **`provider: 'transitous'` est écrit en dur** dans `buildTransitReservationParts`
  (`transit-itinerary.helpers.ts`). Un 4ᵉ paramètre. Son seul appelant est
  `transit.mcp.ts:207`, dans `create_transit_journey`, qui reçoit l'itinéraire de
  l'extérieur : la valeur est le provider **actuellement configuré**, exposé par
  `TransitService`.
- **`safeColor`** remonte dans `transit.helpers.ts` : deux appelants réels
  (`transport.color` chez NAVITIME, `routeColor` chez MOTIS).
- **`transit.mcp.ts`** passe par `TransitService.plan`, il hérite du dispatch sans rien
  changer d'autre.
- **UI admin** : une carte dédiée dans `AdminSettingsTab.tsx`, après la carte
  `admin.apiKeys` — celle-ci parle de clés personnelles servies par une autre route. Un
  `<select>` provider, et le champ de clé NAVITIME affiché seulement quand NAVITIME est
  choisi, avec son œil afficher/masquer. Les deux vont dans **une seule** requête
  `PUT /auth/app-settings`. Le champ arrive masqué (`••••••••`) quand une clé existe, et
  ré-échoyer le masque ne l'écrase pas — c'est le comportement que `smtp_pass` a déjà.
- **i18n, 23 locales** : `transit.estimatedTimes` dans `shared/src/i18n/<locale>/trip.ts` ;
  `admin.transit`, `admin.transitProvider`, `admin.transitProviderHint`,
  `admin.navitimeKey`, `admin.navitimeKeyHint` dans `admin.ts`.
  `npm run i18n:parity:strict --workspace=shared` est la barrière.

## 10. Vérifié sur la donnée réelle

Deux captures de `/route_transit`, **même requête** (Tokyo, 新宿 → 代々木, 5 itinéraires),
seul `calling_at` diffère. Elles entrent dans le dépôt **intactes** — ni clé, ni jeton, ni
en-tête d'authentification dedans (vérifié) :

```
server/tests/fixtures/navitime/route_transit.calling-at.json      (référence)
server/tests/fixtures/navitime/route_transit.no-calling-at.json   (repli)
```

L'algorithme a été prototypé en jetable et exécuté sur ces captures avant toute ligne de
TypeScript.

### Résultats

- **17 legs sur 17 tracés** sur les 5 itinéraires (3+3+3+3+5). Le décompte est 17, pas 15.
- Itinéraire 5 : le 大江戸線 prend **1** feature et finit à **2,6 m** de 新宿西口 ; la
  correspondance relie les deux gares ; le 山手線 prend **2** features et repart à
  **41,6 m** de 新宿. Le trou de **420,5 m** a disparu (2,6 → 0,0 → 41,6 m).
- `calling_at` concorde avec le nombre de features transport sur les **6** legs transit.
- Aller-retour encode → décode : **0,00 cm** de dérive sur les 17 legs.
- Plus grand écart restant entre deux legs consécutives : **239,5 m** (東新宿 ↔ début de
  la shape Fukutoshin), et uniquement des décalages gare ↔ shape.
- Géométrie encodée : **808 caractères au maximum** pour un itinéraire entier.
  `MAX_GEOMETRY_CHARS` vaut 60 000 — aucun risque.
- Couleurs : NAVITIME envoie déjà `#80C241`, format que `safeColor` accepte.
- `properties.section` vaut `"0001,0002,0003,0004,0005"` sur l'itinéraire à 5 moves :
  la liste de tous les moves, identique sur chaque feature. Inutilisable comme jointure.

### Les replis, tous rendant l'itinéraire entier à `null`

| scénario | motif journalisé |
|---|---|
| `next_transit` retiré | leg 2 : marche sans feature walk au curseur 4 |
| `shapes` absentes | leg 0 : marche sans feature walk au curseur 0 |
| un `calling_at` en moins | leg 4 : marche sans feature walk au curseur 5 |
| un `calling_at` en trop | leg 3 : feature non-transport dans les 3 attendues |
| une feature transport en trop à la fin | 1 feature non consommée |
| une insérée au début | leg 0 : marche sans feature walk au curseur 0 |

La capture sans `calling_at` a des shapes **identiques** à la référence (mêmes décomptes,
mêmes séquences `ways`) : chaque leg transit ne réclame plus qu'une feature, le décompte
ne tombe pas juste, et les 5 itinéraires sortent avec un motif précis. La dépendance à
`options=railway_calling_at` est détectée, pas subie.

### Le contrat existant accepte NAVITIME tel quel

- `time` (minutes) == `to_time − from_time` **exactement** sur les 17 moves : aucun risque
  sur la règle `|to − from − duration| ≤ 60 s` de `transitItinerarySchema`.
- La correspondance de l'itinéraire 5 a `distance: 0` mais **6 minutes** réelles — un vrai
  leg, pas un artefact.
- 新宿西口 → 新宿 = 435 m, sous `MAX_LEG_GAP_KM` (1 km). Les jointures entre legs sont
  exactes : leg N `to` et leg N+1 `from` sont la **même** section `point`.
- `transit_count` (0,0,0,0,1) concorde avec `deriveTransitStats` : la marche de
  correspondance est en mode WALK, elle ne compte pas comme leg transit.
- `transitCoordinatesMatch` tolère 100 m ; le premier leg NAVITIME part exactement des
  coordonnées demandées (0,0 m mesuré).

### Une correction au savoir de départ

Sur l'itinéraire 5, le 大江戸線 n'a pas `calling_at` parce que `links[0]` va de 東新宿 à
新宿西口, **deux stations adjacentes** sur la Ōedo : zéro gare intermédiaire, donc
`0 + 1 = 1` feature. Ce n'est pas un report sur le leg suivant — le `calling_at` du
山手線 ne contient que 代々木, gare intermédiaire de son *propre* leg. `next_transit: true`
signale la correspondance qui suit et n'a aucun effet sur `calling_at`.

Sur cette capture `is_timetable` vaut la chaîne `'false'` sur **tous** les liens : les 5
itinéraires sortent en « estimé ». Le cas horaire n'est donc pas couvert par ce fichier.

## 11. Tests

Après la fonctionnalité.

| fichier | couverture |
|---|---|
| `navitime.geometry.test.ts` | 17/17 sur la capture, l'itinéraire 5 au mètre, les 6 replis, la capture sans `calling_at` → 5 replis, l'aller-retour de l'encodeur |
| `navitime.mapper.test.ts` | table des modes, `START`/`END`, `line` nul sur marche, détection de correspondance, `isTimetable` (les trois formes de `is_timetable`, dont le cas horaire construit à la main) |
| `navitime.request.test.ts` | `unuse` séparé par des points, heure locale nue au bon fuseau, `arriveBy` → `goal_time`, filtre `maxTransfers` |
| `transit.service.test.ts` (existant) | dispatch, clé de cache incluant le provider, 503 sans clé ; les cas MOTIS existants doivent passer inchangés |
| `transit.settings.test.ts` | valeur inconnue / ligne absente → `transitous` |
| `transit.e2e.test.ts` (existant) | la route garde son contrat, plus `isTimetable` |
| client | bandeau sur `isTimetable === false` |

## 12. Hors périmètre

- **Pas de contrat Zod partagé pour `/api/transit/plan`.** La route n'en a pas aujourd'hui
  (le client lit `d.itineraries` non typé) ; ajouter `isTimetable` ne crée pas cette dette.
  La créer maintenant doublerait le périmètre. Choix conscient.
- **Tarifs** — `reference_fare`, `transport.fare`, `fare_detail`, `unit.currency` : aucun
  champ correspondant dans `TransitLeg` / `TransitItinerary`.
- **Décalages gare ↔ shape** (36 à 239 m mesurés) : ils subsistent après le port.
- **Puces `subway` / `tram` / `cable`** non exprimables sous NAVITIME : documentées, non
  masquées.
- **Endpoints `/shape_transit`, `/fare_table`, `/fare_comparison`** : non utilisés.

## 13. Langue des commentaires

Tranché : **anglais**, comme le reste du module. La consigne de travail demandait du
français « comme le reste de `nest/transit` », mais le module est intégralement commenté
en anglais (`transit.service.ts`, `transit.helpers.ts`, `transit.controller.ts`,
`transit-itinerary.helpers.ts`). L'anglais garde le module homogène.
