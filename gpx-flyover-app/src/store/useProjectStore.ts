import { create, useStore } from 'zustand';
import { temporal, type TemporalState } from 'zundo';
import { nextMusicId } from '../audio/musicEngine';
import { nextPhotoId } from '../photos/photoEngine';
import { nextTextId } from '../text/textEngine';
import { nextTrackId } from '../gpx/parseGpx';
import { nextVideoId } from '../video/videoEngine';
import { getEffectiveMaxSpeedPoint } from '../geo/geo';
import { effectiveRouteColor, pickRouteColor } from '../vehicle/routeColor';
import { computeSlowZone, resolvePhotoVideoClips, videoTimeToPathTime, type SlowZone } from '../timeline/timelineMath';
import type {
  CameraParams,
  MapParams,
  MaxSpeedExclusion,
  MaxSpeedMarkerParams,
  MusicTrack,
  PhotoClip,
  ProjectState,
  SegmentMode,
  TextOverlay,
  Track,
  VehicleParams,
  VehicleTrack,
  VideoClip,
  VideoParams,
} from '../types/domain';

// Traccia principale del progetto — esattamente come oggi solo una guida camera/statistiche/
// percorso giallo. In Fase 5.1 esiste sempre al più una traccia (quella caricata), sempre
// marcata principale: la gestione multi-traccia vera e propria (aggiungi/rimuovi/designa) arriva
// nelle fasi successive (5.2+).
export function getPrimaryTrack(state: ProjectState): VehicleTrack | undefined {
  return state.tracks.find((t) => t.isPrimary);
}

// Impostazioni Mezzo "effettive" mostrate nel pannello: quelle della traccia principale se
// esiste, altrimenti i default in pendingVehicle (nessuna traccia ancora caricata).
export function getEffectiveVehicle(state: ProjectState): VehicleParams {
  return getPrimaryTrack(state)?.vehicle ?? state.pendingVehicle;
}

// Zona di rallentamento EFFETTIVA (traccia principale, al netto delle esclusioni) — stessa
// funzione già usata dal marcatore "Velocità max" (PreviewControls.tsx), qui riusata per tenere
// sincronizzate le posizioni risolte di foto/video (vedi resyncPhotoVideoPositions sotto): la zona
// di rallentamento fa parte del calcolo tempo↔percorso, quindi cambia le posizioni risolte di ogni
// blocco ancorato al percorso anche se nessuna foto/video è stata toccata direttamente.
function slowZoneOf(tracks: VehicleTrack[], maxSpeedMarker: MaxSpeedMarkerParams): SlowZone | null {
  const primary = tracks.find((t) => t.isPrimary);
  if (!primary) return null;
  const maxSpeedPoint = getEffectiveMaxSpeedPoint(primary.track, primary.maxSpeedExclusions);
  return computeSlowZone(maxSpeedPoint, primary.track.totalDist, maxSpeedMarker);
}

// Ricalcola photoClips[].videoStart/videoClips[].videoStart da pathFraction (+ overlap) — va
// richiamata all'interno di OGNI azione dello store che tocca posizioni/durate di foto/video, la
// durata totale del video, o qualunque cosa influenzi la zona di rallentamento (marcatore
// "Velocità max", esclusioni): vedi resolvePhotoVideoClips (timeline/timelineMath.ts) per il
// motivo (dipendenza circolare pathFraction->videoStart, risolta in un solo passaggio). I
// photoClips/videoClips passati sono quelli GIÀ AGGIORNATI dall'azione chiamante (dopo add/
// remove/update), non quelli precedenti allo stesso set().
function resyncPhotoVideoPositions(
  photoClips: PhotoClip[],
  videoClips: VideoClip[],
  durationSec: number,
  tracks: VehicleTrack[],
  maxSpeedMarker: MaxSpeedMarkerParams,
): { photoClips: PhotoClip[]; videoClips: VideoClip[] } {
  return resolvePhotoVideoClips(photoClips, videoClips, durationSec, slowZoneOf(tracks, maxSpeedMarker));
}

interface ProjectActions {
  addTrack: (fileName: string, track: Track) => number;
  removeTrack: (id: number) => void;
  setPrimaryTrack: (id: number) => void;
  setSegmentMode: (mode: SegmentMode) => void;
  setTitle: (title: string) => void;
  updateVideo: (patch: Partial<VideoParams>) => void;
  updateCamera: (patch: Partial<CameraParams>) => void;
  updateMap: (patch: Partial<MapParams>) => void;
  // trackId null aggiorna pendingVehicle (nessuna traccia caricata ancora); altrimenti aggiorna
  // le impostazioni Mezzo di quella specifica traccia.
  updateVehicle: (trackId: number | null, patch: Partial<VehicleParams>) => void;
  updateMaxSpeedMarker: (patch: Partial<MaxSpeedMarkerParams>) => void;
  // "Scarta questo punto / trova il prossimo": esclude il punto di velocità massima ATTUALE
  // (effettivo, già al netto delle esclusioni precedenti) e ricalcola. Nessun effetto se la
  // traccia non ha al momento un punto valido (nessun timestamp GPX, o già tutto escluso).
  discardMaxSpeedPoint: (trackId: number) => void;
  resetMaxSpeedExclusions: (trackId: number) => void;
  // Assegnazione diretta (non ricalcolata dal punto attuale) — usata dal riaggancio automatico
  // per nome file al ricaricamento di un progetto salvato (Sidebar.tsx), per riapplicare
  // esclusioni salvate in precedenza.
  setMaxSpeedExclusions: (trackId: number, exclusions: MaxSpeedExclusion[]) => void;
  setMusicVolume: (volume: number) => void;
  addMusicTrack: (track: MusicTrack) => void;
  updateMusicTrack: (id: number, patch: Partial<MusicTrack>) => void;
  removeMusicTrack: (id: number) => void;
  duplicateMusicTrack: (id: number) => void;
  splitMusicTrackAt: (id: number, atSec: number) => void;
  setPhotoDefaultDuration: (sec: number) => void;
  addPhotoClip: (clip: PhotoClip) => void;
  updatePhotoClip: (id: number, patch: Partial<PhotoClip>) => void;
  removePhotoClip: (id: number) => void;
  duplicatePhotoClip: (id: number) => void;
  splitPhotoClipAt: (id: number, atSec: number) => void;
  addVideoClip: (clip: VideoClip) => void;
  updateVideoClip: (id: number, patch: Partial<VideoClip>) => void;
  removeVideoClip: (id: number) => void;
  duplicateVideoClip: (id: number) => void;
  splitVideoClipAt: (id: number, atSec: number) => void;
  addTextOverlay: (text: string, videoStart: number, duration: number) => number;
  updateTextOverlay: (id: number, patch: Partial<TextOverlay>) => void;
  removeTextOverlay: (id: number) => void;
  duplicateTextOverlay: (id: number) => void;
  setSnapEnabled: (enabled: boolean) => void;
  loadProjectData: (patch: Partial<Omit<ProjectState, 'tracks'>>) => void;
  // Rimuove TUTTI i blocchi foto/video ancorati al percorso — usata SOLO dal flusso di conferma
  // cambio/rimozione traccia principale o segmentMode (src/app/primaryTrackGuard.ts), mai
  // direttamente dalla UI. Vedi CLAUDE.md/Fase 3: cambiare la traccia principale invalida
  // l'ancoraggio di ogni foto/video esistente (fraction relativa a un percorso che non è più
  // quello attivo) — niente "salto silenzioso", i blocchi vengono rimossi esplicitamente dopo
  // conferma dell'utente, non ripiazzati a caso.
  clearPathAnchoredBlocks: () => void;
}

type ProjectStore = ProjectState & ProjectActions;

// Raggio (metri) della zona esclusa quando si scarta un punto di velocità massima — nel range
// 300-500m suggerito, abbastanza da lasciarsi alle spalle il rumore GPS locale del punto scartato.
const MAX_SPEED_EXCLUSION_RADIUS_M = 400;

const defaultVehicle: VehicleParams = {
  icon: '🏍️',
  color: '#00e5ff',
  routeColor: '',
  iconStyle: 'filled',
  size: 0.55,
  use3DAltitude: false,
  altExaggeration: 8,
  showLiveStats: false,
  // Riproduce esattamente la posizione fissa basso-destra usata prima della Fase 5.3-bis, su un
  // canvas 16:9 di riferimento — chi non tocca nulla vede lo stesso risultato di sempre.
  liveStatsX: 0.923,
  liveStatsY: 0.93,
  liveStatsScale: 1,
};

const initialState: ProjectState = {
  tracks: [],
  pendingVehicle: defaultVehicle,
  segmentMode: 'longest',
  title: '',
  video: {
    resolution: '1920x1080',
    bitrateMbps: 8,
    durationSec: 30,
    fps: 30,
    aspectRatio: '16:9',
    trimStartSec: 0,
    trimEndSec: null,
    showAltitudeProfile: true,
  },
  camera: {
    pitch: 24,
    zoom: 12.5,
    orbitAmp: 25,
    orbitPeriod: 14,
    bearingMode: 'followPath',
    fixedBearingDeg: 0,
    fixedBearingOrbitEnabled: false,
  },
  map: {
    maptilerToken: 'FyCTckIX29KYsBltxupY',
    styleId: 'hybrid-v4',
    useCustomStyleUrl: false,
    customStyleUrl: 'https://api.maptiler.com/maps/019fad3d-3469-7200-b415-d66035b09fd7/style.json?key=FyCTckIX29KYsBltxupY',
  },
  musicTracks: [],
  musicVolume: 0.6,
  photoClips: [],
  photoDefaultDuration: 3,
  videoClips: [],
  textOverlays: [],
  snapEnabled: true,
  maxSpeedMarker: {
    sizeScale: 1,
    use3DAltitude: false,
    altExaggeration: 8,
    slowdownBeforeM: 300,
    slowdownAfterM: 300,
    slowdownFactor: 0.4,
  },
};

// Undo/redo (Ctrl+Z / Ctrl+Y) copre musica, foto e parametri principali — non il Track
// caricato (troppo grande, e ricaricare il GPX non è un'operazione da "annullare").
// prompt-refactoring.md, priorità alta #2.
export const useProjectStore = create<ProjectStore>()(
  temporal(
    (set) => ({
      ...initialState,
      // Aggiunge una nuova traccia. Se è la prima del progetto, diventa principale ed eredita i
      // default da pendingVehicle (comportamento Fase 5.1 invariato); altrimenti è una traccia
      // secondaria con impostazioni Mezzo di default (Fase 5.2 — gestione multi-traccia).
      addTrack: (fileName, track) => {
        const id = nextTrackId();
        set((s) => {
          const isFirst = s.tracks.length === 0;
          const vehicle = isFirst ? { ...s.pendingVehicle } : { ...defaultVehicle };
          return {
            tracks: [...s.tracks, { id, fileName, track, vehicle, isPrimary: isFirst, maxSpeedExclusions: [] }],
          };
        });
        return id;
      },
      // Rimuove una traccia; se era la principale e ne restano altre, promuove la prima rimasta.
      removeTrack: (id) =>
        set((s) => {
          const wasPrimary = s.tracks.find((t) => t.id === id)?.isPrimary ?? false;
          const remaining = s.tracks.filter((t) => t.id !== id);
          if (wasPrimary && remaining.length > 0) {
            remaining[0] = { ...remaining[0], isPrimary: true };
          }
          return { tracks: remaining };
        }),
      setPrimaryTrack: (id) =>
        set((s) => ({
          tracks: s.tracks.map((t) => (t.id === id ? { ...t, isPrimary: true } : { ...t, isPrimary: false })),
        })),
      setSegmentMode: (segmentMode) => set({ segmentMode }),
      setTitle: (title) => set({ title }),
      // durationSec influenza direttamente il calcolo tempo↔percorso (availableFlightTime) —
      // ogni cambio (anche di altri campi VideoParams, per semplicità: il ricalcolo è a costo
      // trascurabile) risincronizza le posizioni risolte di foto/video.
      updateVideo: (patch) =>
        set((s) => {
          const video = { ...s.video, ...patch };
          return { video, ...resyncPhotoVideoPositions(s.photoClips, s.videoClips, video.durationSec, s.tracks, s.maxSpeedMarker) };
        }),
      updateCamera: (patch) => set((s) => ({ camera: { ...s.camera, ...patch } })),
      updateMap: (patch) => set((s) => ({ map: { ...s.map, ...patch } })),
      // trackId null: nessuna traccia caricata ancora, modifica i default (pendingVehicle).
      // trackId dato: modifica le impostazioni Mezzo di quella specifica traccia.
      updateVehicle: (trackId, patch) =>
        set((s) => {
          if (trackId == null) return { pendingVehicle: { ...s.pendingVehicle, ...patch } };
          return {
            tracks: s.tracks.map((t) => {
              if (t.id !== trackId) return t;
              // Passaggio a icona "nessuna" senza un colore percorso già personalizzato: assegna
              // automaticamente il primo colore della palette non ancora usato dalle altre
              // tracce (spec: evitare duplicati con le altre tracce/il giallo della principale).
              let effectivePatch = patch;
              if (patch.icon === 'none' && patch.routeColor === undefined && !t.vehicle.routeColor) {
                const usedColors = s.tracks
                  .filter((other) => other.id !== trackId)
                  .map((other) => effectiveRouteColor(other, s.tracks.length));
                usedColors.push('#ffcc00');
                effectivePatch = { ...patch, routeColor: pickRouteColor(usedColors) };
              }
              return { ...t, vehicle: { ...t.vehicle, ...effectivePatch } };
            }),
          };
        }),
      // La zona di rallentamento (derivata dal marcatore + dal punto di velocità massima
      // effettivo) fa parte del calcolo tempo↔percorso — cambiarla risincronizza le posizioni
      // risolte di foto/video, anche se nessuna foto/video è stata toccata direttamente.
      updateMaxSpeedMarker: (patch) =>
        set((s) => {
          const maxSpeedMarker = { ...s.maxSpeedMarker, ...patch };
          return {
            maxSpeedMarker,
            ...resyncPhotoVideoPositions(s.photoClips, s.videoClips, s.video.durationSec, s.tracks, maxSpeedMarker),
          };
        }),
      discardMaxSpeedPoint: (trackId) =>
        set((s) => {
          const tracks = s.tracks.map((t) => {
            if (t.id !== trackId) return t;
            const current = getEffectiveMaxSpeedPoint(t.track, t.maxSpeedExclusions);
            if (!current) return t;
            return {
              ...t,
              maxSpeedExclusions: [
                ...t.maxSpeedExclusions,
                { lat: current.lat, lon: current.lon, radiusM: MAX_SPEED_EXCLUSION_RADIUS_M },
              ],
            };
          });
          return { tracks, ...resyncPhotoVideoPositions(s.photoClips, s.videoClips, s.video.durationSec, tracks, s.maxSpeedMarker) };
        }),
      resetMaxSpeedExclusions: (trackId) =>
        set((s) => {
          const tracks = s.tracks.map((t) => (t.id === trackId ? { ...t, maxSpeedExclusions: [] } : t));
          return { tracks, ...resyncPhotoVideoPositions(s.photoClips, s.videoClips, s.video.durationSec, tracks, s.maxSpeedMarker) };
        }),
      setMaxSpeedExclusions: (trackId, exclusions) =>
        set((s) => {
          const tracks = s.tracks.map((t) => (t.id === trackId ? { ...t, maxSpeedExclusions: exclusions } : t));
          return { tracks, ...resyncPhotoVideoPositions(s.photoClips, s.videoClips, s.video.durationSec, tracks, s.maxSpeedMarker) };
        }),
      setMusicVolume: (musicVolume) => set({ musicVolume }),
      addMusicTrack: (track) => set((s) => ({ musicTracks: [...s.musicTracks, track] })),
      updateMusicTrack: (id, patch) =>
        set((s) => ({
          musicTracks: s.musicTracks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
        })),
      removeMusicTrack: (id) =>
        set((s) => ({ musicTracks: s.musicTracks.filter((t) => t.id !== id) })),
      duplicateMusicTrack: (id) =>
        set((s) => {
          const t = s.musicTracks.find((x) => x.id === id);
          if (!t) return {};
          const length = t.trimEnd - t.trimStart;
          const videoStart = Math.min(Math.max(0, s.video.durationSec - length), t.videoStart + length);
          return { musicTracks: [...s.musicTracks, { ...t, id: nextMusicId(), videoStart }] };
        }),
      // Taglia un brano nel punto atSec (in secondi video) in due tracce distinte, accorciando
      // quella esistente e creandone una nuova per la seconda metà — riferiscono lo stesso
      // AudioBuffer decodificato, cambia solo il ritaglio (trimStart/trimEnd) e la posizione.
      splitMusicTrackAt: (id, atSec) =>
        set((s) => {
          const t = s.musicTracks.find((x) => x.id === id);
          if (!t) return {};
          const length = t.trimEnd - t.trimStart;
          const cutOffset = atSec - t.videoStart;
          if (cutOffset <= 0.15 || cutOffset >= length - 0.15) return {};
          const cutTrim = t.trimStart + cutOffset;
          const second: MusicTrack = { ...t, id: nextMusicId(), videoStart: atSec, trimStart: cutTrim };
          return {
            musicTracks: [
              ...s.musicTracks.map((x) => (x.id === id ? { ...x, trimEnd: cutTrim } : x)),
              second,
            ],
          };
        }),
      setPhotoDefaultDuration: (photoDefaultDuration) => set({ photoDefaultDuration }),
      addPhotoClip: (clip) =>
        set((s) => {
          const photoClips = [...s.photoClips, clip];
          return resyncPhotoVideoPositions(photoClips, s.videoClips, s.video.durationSec, s.tracks, s.maxSpeedMarker);
        }),
      updatePhotoClip: (id, patch) =>
        set((s) => {
          const photoClips = s.photoClips.map((p) => (p.id === id ? { ...p, ...patch } : p));
          return resyncPhotoVideoPositions(photoClips, s.videoClips, s.video.durationSec, s.tracks, s.maxSpeedMarker);
        }),
      removePhotoClip: (id) =>
        set((s) => {
          const photoClips = s.photoClips.filter((p) => p.id !== id);
          return resyncPhotoVideoPositions(photoClips, s.videoClips, s.video.durationSec, s.tracks, s.maxSpeedMarker);
        }),
      // Nominal-seconds -> pathFraction: usa la posizione RISOLTA attuale di p (p.videoStart, già
      // sincronizzata dallo store) per calcolare dove piazzare la copia in secondi (stessa logica
      // di sempre — subito dopo l'originale), poi converte quel secondo in pathFraction con la
      // configurazione ATTUALE (prima dell'inserimento) di foto/video. La copia non eredita
      // relazioni di sovrapposizione dall'originale (overlapOfId pulito): parte come blocco
      // indipendente, coerente con "subito dopo la fine dell'originale".
      duplicatePhotoClip: (id) =>
        set((s) => {
          const p = s.photoClips.find((x) => x.id === id);
          if (!p) return {};
          const durationSec = s.video.durationSec;
          const videoStart = Math.min(Math.max(0, durationSec - p.duration), p.videoStart + p.duration);
          const slowZone = slowZoneOf(s.tracks, s.maxSpeedMarker);
          const safeDuration = Math.max(0.001, durationSec);
          const pathFraction = videoTimeToPathTime(videoStart, s.photoClips, safeDuration, s.videoClips, slowZone) / safeDuration;
          const newClip: PhotoClip = {
            ...p,
            id: nextPhotoId(),
            videoStart,
            pathFraction,
            overlapOfId: undefined,
            overlapOfKind: undefined,
            overlapOffsetSec: undefined,
          };
          const photoClips = [...s.photoClips, newClip];
          return resyncPhotoVideoPositions(photoClips, s.videoClips, durationSec, s.tracks, s.maxSpeedMarker);
        }),
      // atSec è un secondo nominale (playhead) — stessa logica di taglio di sempre sul secondo
      // "risolto" attuale, poi il pezzo nuovo (second) viene ri-ancorato in pathFraction a quello
      // stesso secondo, come blocco indipendente (nessuna relazione di sovrapposizione ereditata).
      splitPhotoClipAt: (id, atSec) =>
        set((s) => {
          const p = s.photoClips.find((x) => x.id === id);
          if (!p) return {};
          const cutOffset = atSec - p.videoStart;
          if (cutOffset <= 0.15 || cutOffset >= p.duration - 0.15) return {};
          const durationSec = s.video.durationSec;
          const slowZone = slowZoneOf(s.tracks, s.maxSpeedMarker);
          const safeDuration = Math.max(0.001, durationSec);
          const secondPathFraction = videoTimeToPathTime(atSec, s.photoClips, safeDuration, s.videoClips, slowZone) / safeDuration;
          const second: PhotoClip = {
            ...p,
            id: nextPhotoId(),
            videoStart: atSec,
            pathFraction: secondPathFraction,
            duration: p.duration - cutOffset,
            overlapOfId: undefined,
            overlapOfKind: undefined,
            overlapOffsetSec: undefined,
          };
          const photoClips = [...s.photoClips.map((x) => (x.id === id ? { ...x, duration: cutOffset } : x)), second];
          return resyncPhotoVideoPositions(photoClips, s.videoClips, durationSec, s.tracks, s.maxSpeedMarker);
        }),
      addVideoClip: (clip) =>
        set((s) => {
          const videoClips = [...s.videoClips, clip];
          return resyncPhotoVideoPositions(s.photoClips, videoClips, s.video.durationSec, s.tracks, s.maxSpeedMarker);
        }),
      updateVideoClip: (id, patch) =>
        set((s) => {
          const videoClips = s.videoClips.map((c) => (c.id === id ? { ...c, ...patch } : c));
          return resyncPhotoVideoPositions(s.photoClips, videoClips, s.video.durationSec, s.tracks, s.maxSpeedMarker);
        }),
      removeVideoClip: (id) =>
        set((s) => {
          const videoClips = s.videoClips.filter((c) => c.id !== id);
          return resyncPhotoVideoPositions(s.photoClips, videoClips, s.video.durationSec, s.tracks, s.maxSpeedMarker);
        }),
      // Stessa logica di duplicatePhotoClip sopra, adattata al video (lunghezza = trimEnd-trimStart).
      duplicateVideoClip: (id) =>
        set((s) => {
          const c = s.videoClips.find((x) => x.id === id);
          if (!c) return {};
          const durationSec = s.video.durationSec;
          const length = c.trimEnd - c.trimStart;
          const videoStart = Math.min(Math.max(0, durationSec - length), c.videoStart + length);
          const slowZone = slowZoneOf(s.tracks, s.maxSpeedMarker);
          const safeDuration = Math.max(0.001, durationSec);
          const pathFraction = videoTimeToPathTime(videoStart, s.photoClips, safeDuration, s.videoClips, slowZone) / safeDuration;
          const newClip: VideoClip = {
            ...c,
            id: nextVideoId(),
            videoStart,
            pathFraction,
            overlapOfId: undefined,
            overlapOfKind: undefined,
            overlapOffsetSec: undefined,
          };
          const videoClips = [...s.videoClips, newClip];
          return resyncPhotoVideoPositions(s.photoClips, videoClips, durationSec, s.tracks, s.maxSpeedMarker);
        }),
      // Taglia una clip nel punto atSec in due clip distinte, come splitMusicTrackAt — riferiscono
      // lo stesso <video>/AudioBuffer, cambia solo il ritaglio (trimStart/trimEnd); il pezzo nuovo
      // viene ri-ancorato in pathFraction come blocco indipendente (stessa logica di splitPhotoClipAt).
      splitVideoClipAt: (id, atSec) =>
        set((s) => {
          const c = s.videoClips.find((x) => x.id === id);
          if (!c) return {};
          const length = c.trimEnd - c.trimStart;
          const cutOffset = atSec - c.videoStart;
          if (cutOffset <= 0.15 || cutOffset >= length - 0.15) return {};
          const durationSec = s.video.durationSec;
          const cutTrim = c.trimStart + cutOffset;
          const slowZone = slowZoneOf(s.tracks, s.maxSpeedMarker);
          const safeDuration = Math.max(0.001, durationSec);
          const secondPathFraction = videoTimeToPathTime(atSec, s.photoClips, safeDuration, s.videoClips, slowZone) / safeDuration;
          const second: VideoClip = {
            ...c,
            id: nextVideoId(),
            videoStart: atSec,
            pathFraction: secondPathFraction,
            trimStart: cutTrim,
            overlapOfId: undefined,
            overlapOfKind: undefined,
            overlapOffsetSec: undefined,
          };
          const videoClips = [...s.videoClips.map((x) => (x.id === id ? { ...x, trimEnd: cutTrim } : x)), second];
          return resyncPhotoVideoPositions(s.photoClips, videoClips, durationSec, s.tracks, s.maxSpeedMarker);
        }),
      addTextOverlay: (text, videoStart, duration) => {
        const id = nextTextId();
        set((s) => ({ textOverlays: [...s.textOverlays, { id, text, videoStart, duration, x: 0.5, y: 0.85 }] }));
        return id;
      },
      updateTextOverlay: (id, patch) =>
        set((s) => ({
          textOverlays: s.textOverlays.map((t) => (t.id === id ? { ...t, ...patch } : t)),
        })),
      removeTextOverlay: (id) =>
        set((s) => ({ textOverlays: s.textOverlays.filter((t) => t.id !== id) })),
      duplicateTextOverlay: (id) =>
        set((s) => {
          const t = s.textOverlays.find((x) => x.id === id);
          if (!t) return {};
          const videoStart = Math.min(Math.max(0, s.video.durationSec - t.duration), t.videoStart + t.duration);
          return { textOverlays: [...s.textOverlays, { ...t, id: nextTextId(), videoStart }] };
        }),
      setSnapEnabled: (snapEnabled) => set({ snapEnabled }),
      // Applica in blocco i dati di un progetto caricato da JSON (project/projectFile.ts) —
      // le tracce GPX restano fuori: vanno sempre ricaricate a mano, come per l'undo/redo. Le
      // foto arrivano con pathFraction già valorizzata ma videoStart ancora segnaposto (0): va
      // risincronizzato subito, altrimenti resterebbero visivamente ammassate all'inizio della
      // timeline finché non scatta un altro resync qualsiasi.
      loadProjectData: (patch) =>
        set((s) => {
          const next = { ...s, ...patch };
          return { ...patch, ...resyncPhotoVideoPositions(next.photoClips, next.videoClips, next.video.durationSec, next.tracks, next.maxSpeedMarker) };
        }),
      clearPathAnchoredBlocks: () => set({ photoClips: [], videoClips: [] }),
    }),
    {
      partialize: (state) => {
        const { tracks: _tracks, ...rest } = state;
        return rest;
      },
      limit: 100,
    },
  ),
);

export function useProjectTemporalStore<T>(
  selector: (state: TemporalState<Omit<ProjectStore, 'tracks'>>) => T,
): T {
  return useStore(useProjectStore.temporal, selector);
}
