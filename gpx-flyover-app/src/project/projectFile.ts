import { nextPhotoId } from '../photos/photoEngine';
import { nextTextId } from '../text/textEngine';
import { videoTimeToPathTime } from '../timeline/timelineMath';
import type {
  CameraParams,
  MapParams,
  MaxSpeedExclusion,
  MusicTrack,
  PhotoClip,
  ProjectState,
  SegmentMode,
  TextOverlay,
  VehicleParams,
  VideoClip,
  VideoParams,
} from '../types/domain';

const PROJECT_FILE_VERSION = 4;

// v3 (Fase 2, ancoraggio al percorso): pathFraction sostituisce videoStart come dato salvato per
// le foto — videoStart resta un campo derivato, non ha senso persisterlo (vedi PhotoClip in
// types/domain.ts). overlapOfId/overlapOfKind/overlapOffsetSec presenti solo per i blocchi
// sovrapposti (vedi resolvePathAnchoredPositions, timeline/timelineMath.ts).
interface SerializedPhotoClipV3 {
  name: string;
  pathFraction: number;
  overlapOfId?: number;
  overlapOfKind?: 'photo' | 'video';
  overlapOffsetSec?: number;
  duration: number;
  rotation: PhotoClip['rotation'];
  dataUrl: string;
}

// Formato v1/v2 (ancoraggio a tempo assoluto) — letto ancora per compatibilità, mai più scritto.
interface SerializedPhotoClipLegacy {
  name: string;
  videoStart: number;
  duration: number;
  rotation: PhotoClip['rotation'];
  dataUrl: string;
}

// Solo metadati per traccia: il GPX vero e proprio NON viene incorporato (si ricarica sempre a
// mano dalla sezione Sorgente GPX) — fileName+vehicle+isPrimary+maxSpeedExclusions vengono
// riapplicati AUTOMATICAMENTE non appena l'utente ricarica un file con lo stesso nome (vedi
// Sidebar.tsx handleLoad, che confronta expectedTracksMeta in usePlaybackStore per nome file).
export interface SerializedTrackMeta {
  fileName: string;
  vehicle: VehicleParams;
  isPrimary: boolean;
  maxSpeedExclusions: MaxSpeedExclusion[];
}

// Stessi campi di MusicTrack tranne l'AudioBuffer decodificato (non incorporabile) e l'id (nuovo
// ad ogni ricaricamento) — riapplicati automaticamente per nome file (vedi MusicPhotosPanel.tsx).
export type SerializedMusicMeta = Omit<MusicTrack, 'buffer' | 'id'>;

// Stessa idea di SerializedMusicMeta, per le clip video: il file sorgente (videoEl/audioBuffer/
// posterDataUrl) non è incorporabile, solo posizione/taglio/muto — riapplicati automaticamente per
// nome file (vedi MusicPhotosPanel.tsx, stesso pattern della musica).
export type SerializedVideoMeta = Omit<VideoClip, 'id' | 'videoEl' | 'audioBuffer' | 'posterDataUrl'>;

interface ProjectFileV1 {
  version: 1;
  title: string;
  segmentMode: SegmentMode;
  video: VideoParams;
  camera: CameraParams;
  map: MapParams;
  vehicle: VehicleParams;
  musicVolume: number;
  photoDefaultDuration: number;
  snapEnabled: boolean;
  musicTracksMeta: SerializedMusicMeta[];
  photoClips: SerializedPhotoClipLegacy[];
  textOverlays: Array<Omit<TextOverlay, 'id'>>;
}

interface ProjectFileV2 {
  version: 2;
  title: string;
  segmentMode: SegmentMode;
  video: VideoParams;
  camera: CameraParams;
  map: MapParams;
  tracksMeta: SerializedTrackMeta[];
  musicVolume: number;
  photoDefaultDuration: number;
  snapEnabled: boolean;
  // Solo metadati: il file audio vero e proprio NON viene incorporato (potrebbe pesare decine di
  // MB in base64 per brano) — servono solo come promemoria di quali brani riaggiungere a mano
  // dalla sezione Musica & Foto dopo il caricamento.
  musicTracksMeta: SerializedMusicMeta[];
  photoClips: SerializedPhotoClipLegacy[];
  textOverlays: Array<Omit<TextOverlay, 'id'>>;
  // Stesso motivo di musicTracksMeta: le clip video non sono incorporabili (potrebbero pesare
  // centinaia di MB), solo i loro metadati per il riaggancio automatico per nome file.
  videoClipsMeta: SerializedVideoMeta[];
}

interface ProjectFileV3 {
  version: 3;
  title: string;
  segmentMode: SegmentMode;
  video: VideoParams;
  camera: CameraParams;
  map: MapParams;
  tracksMeta: SerializedTrackMeta[];
  musicVolume: number;
  photoDefaultDuration: number;
  snapEnabled: boolean;
  musicTracksMeta: SerializedMusicMeta[];
  // pathFraction al posto di videoStart — vedi SerializedPhotoClipV3.
  photoClips: SerializedPhotoClipV3[];
  textOverlays: Array<Omit<TextOverlay, 'id'>>;
  videoClipsMeta: SerializedVideoMeta[];
}

// v4 (angolo camera): stessa forma di v3 — cambia solo il significato salvato in camera.pitch
// (prima nella semantica nativa MapLibre, ora 0°=orizzonte/90°=verticale dall'alto, vedi
// toMapPitch in camera/camera.ts) e i tre nuovi campi bearingMode/fixedBearingDeg/
// fixedBearingOrbitEnabled — vedi migrateLegacyCamera sotto per la conversione dei file più vecchi.
interface ProjectFileV4 {
  version: 4;
  title: string;
  segmentMode: SegmentMode;
  video: VideoParams;
  camera: CameraParams;
  map: MapParams;
  tracksMeta: SerializedTrackMeta[];
  musicVolume: number;
  photoDefaultDuration: number;
  snapEnabled: boolean;
  musicTracksMeta: SerializedMusicMeta[];
  photoClips: SerializedPhotoClipV3[];
  textOverlays: Array<Omit<TextOverlay, 'id'>>;
  videoClipsMeta: SerializedVideoMeta[];
}

type ProjectFile = ProjectFileV1 | ProjectFileV2 | ProjectFileV3 | ProjectFileV4;

// File precedenti a v4 salvano camera.pitch nella vecchia semantica nativa MapLibre (0°=verticale
// dall'alto, max 85°=orizzonte) e non hanno affatto bearingMode/fixedBearing* — li converte alla
// semantica corrente (0°=orizzonte, 90°=verticale dall'alto) e imposta i default della nuova
// modalità bearing ('followPath', invariata rispetto al comportamento di quei file).
function migrateLegacyCamera(camera: CameraParams): CameraParams {
  return {
    ...camera,
    pitch: 90 - camera.pitch,
    bearingMode: 'followPath',
    fixedBearingDeg: 0,
    fixedBearingOrbitEnabled: false,
  };
}

function photoToDataUrl(img: HTMLImageElement): string {
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  return canvas.toDataURL('image/jpeg', 0.85);
}

function loadImageFromDataUrl(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

// Converte lo stato di progetto (escluse le tracce GPX, sempre da ricaricare a mano) in un
// oggetto JSON-serializzabile: le foto sono incorporate come dataURL (in genere poche centinaia
// di KB l'una) e RESTANO ripristinate subito al caricamento (vedi deserializeProject) — solo la
// LORO POSIZIONE è ora pathFraction invece di videoStart (Fase 2, ancoraggio al percorso).
// Musica/video restano solo metadati, le tracce solo promemoria nome-file/impostazioni Mezzo/
// principale (vedi ProjectFileV3).
export function serializeProject(state: ProjectState): ProjectFileV4 {
  return {
    version: PROJECT_FILE_VERSION,
    title: state.title,
    segmentMode: state.segmentMode,
    video: state.video,
    camera: state.camera,
    map: state.map,
    tracksMeta: state.tracks.map((t) => ({
      fileName: t.fileName,
      vehicle: t.vehicle,
      isPrimary: t.isPrimary,
      maxSpeedExclusions: t.maxSpeedExclusions,
    })),
    musicVolume: state.musicVolume,
    photoDefaultDuration: state.photoDefaultDuration,
    snapEnabled: state.snapEnabled,
    musicTracksMeta: state.musicTracks.map(({ buffer: _buffer, id: _id, ...rest }) => rest),
    photoClips: state.photoClips.map((p) => ({
      name: p.name,
      pathFraction: p.pathFraction,
      overlapOfId: p.overlapOfId,
      overlapOfKind: p.overlapOfKind,
      overlapOffsetSec: p.overlapOffsetSec,
      duration: p.duration,
      rotation: p.rotation,
      dataUrl: photoToDataUrl(p.img),
    })),
    textOverlays: state.textOverlays.map(({ id: _id, ...rest }) => rest),
    videoClipsMeta: state.videoClips.map(({ id: _id, videoEl: _videoEl, audioBuffer: _audioBuffer, posterDataUrl: _posterDataUrl, ...rest }) => rest),
  };
}

export interface DeserializedProject {
  data: Partial<Omit<ProjectState, 'tracks' | 'pendingVehicle'>>;
  // Le impostazioni Mezzo salvate non sono un campo diretto di ProjectState (vivono dentro le
  // tracce, ricaricate una per una): il chiamante (ProjectPanel.tsx) le passa a
  // usePlaybackStore.setExpectedMeta, da cui Sidebar.tsx/MusicPhotosPanel.tsx le leggono per il
  // riaggancio automatico per nome file al prossimo caricamento di ciascun file GPX/audio/video.
  tracksMeta: SerializedTrackMeta[];
  musicMeta: SerializedMusicMeta[];
  videoMeta: SerializedVideoMeta[];
}

// Converte le foto di un file v1/v2 (ancorate a videoStart in secondi) in pathFraction — NON
// serve un GPX già caricato: la conversione tempo->percorso (videoTimeToPathTime) dipende solo
// dalla configurazione di congelamento salvata nello STESSO file (gli altri videoStart/duration
// di foto e video, tutti già noti) e da video.durationSec, mai dalla geometria della traccia in
// sé (la zona di rallentamento è l'unica eccezione, ignorata qui — slowZone null — con la stessa
// approssimazione già accettata per il posizionamento predefinito di nuovi blocchi, vedi
// photoEngine.ts/videoEngine.ts). Per questo le foto restano ripristinate SUBITO al caricamento
// del progetto, come sempre — a differenza di musica/video non serve alcun riaggancio differito
// per la loro posizione (deviazione dal piano originale concordato: il riaggancio differito era
// stato accettato perché ritenuto necessario, ma la conversione non richiede affatto un GPX
// caricato — evitare una regressione UX non necessaria).
function migrateLegacyPhotoFractions(
  legacyPhotos: SerializedPhotoClipLegacy[],
  legacyVideoMeta: SerializedVideoMeta[],
  totalDurationSec: number,
): number[] {
  const safeDuration = Math.max(0.001, totalDurationSec);
  // Solo i campi letti da freezeWindowsOf (videoStart/duration per le foto, videoStart/trimStart/
  // trimEnd per i video) contano per la conversione — cast mirato, mai esposto all'esterno.
  const photoWindows = legacyPhotos.map((p) => ({ videoStart: p.videoStart, duration: p.duration })) as unknown as PhotoClip[];
  const videoWindows = legacyVideoMeta.map((c) => ({
    videoStart: c.videoStart,
    trimStart: c.trimStart,
    trimEnd: c.trimEnd,
  })) as unknown as VideoClip[];
  return legacyPhotos.map((p) => videoTimeToPathTime(p.videoStart, photoWindows, safeDuration, videoWindows, null) / safeDuration);
}

// Ricostruisce lo stato da un file JSON esportato da serializeProject. Le foto vengono ricaricate
// subito (decodifica del dataURL, nessuna azione utente necessaria — vedi
// migrateLegacyPhotoFractions sopra per il perché questo vale anche per i file v1/v2); musica e
// video NON vengono ripristinati subito (nessun file sorgente incorporato) — i loro metadati
// completi (musicMeta/videoMeta) vengono riapplicati automaticamente non appena l'utente ricarica
// un file con lo stesso nome (vedi DeserializedProject sopra). Assegna id nuovi (nextPhotoId/
// nextTextId) invece di riusare quelli salvati, per evitare collisioni con elementi aggiunti nella
// sessione corrente dopo il caricamento.
// Accetta anche file v1/v2 (prima dell'ancoraggio al percorso) per compatibilità.
export async function deserializeProject(json: unknown): Promise<DeserializedProject> {
  const version = (json as { version?: unknown } | null)?.version;
  if (!json || typeof json !== 'object' || (version !== 1 && version !== 2 && version !== 3 && version !== 4)) {
    throw new Error('File di progetto non valido o di una versione non supportata.');
  }
  const f = json as ProjectFile;
  const camera = f.version === 4 ? f.camera : migrateLegacyCamera(f.camera);

  const legacyPhotoFractions =
    f.version === 1 || f.version === 2
      ? migrateLegacyPhotoFractions(f.photoClips ?? [], f.version === 2 ? (f.videoClipsMeta ?? []) : [], f.video.durationSec)
      : null;

  const photoClips: PhotoClip[] = await Promise.all(
    (f.photoClips ?? []).map(async (p, i) => ({
      id: nextPhotoId(),
      name: p.name,
      videoStart: 0, // derivato — risincronizzato dallo store subito dopo il caricamento (loadProjectData)
      pathFraction: legacyPhotoFractions ? legacyPhotoFractions[i] : (p as SerializedPhotoClipV3).pathFraction,
      overlapOfId: f.version >= 3 ? (p as SerializedPhotoClipV3).overlapOfId : undefined,
      overlapOfKind: f.version >= 3 ? (p as SerializedPhotoClipV3).overlapOfKind : undefined,
      overlapOffsetSec: f.version >= 3 ? (p as SerializedPhotoClipV3).overlapOffsetSec : undefined,
      duration: p.duration,
      rotation: p.rotation,
      img: await loadImageFromDataUrl(p.dataUrl),
    })),
  );

  const textOverlays: TextOverlay[] = (f.textOverlays ?? []).map((t) => ({ id: nextTextId(), ...t }));

  // maxSpeedExclusions è assente nei file salvati prima di questa modifica (v2 già esistenti):
  // ?? [] evita un crash a runtime, il campo è opzionale nei dati letti anche se non nel tipo.
  const tracksMeta: SerializedTrackMeta[] =
    f.version === 1
      ? [{ fileName: '', vehicle: f.vehicle, isPrimary: true, maxSpeedExclusions: [] }]
      : f.tracksMeta.map((t) => ({ ...t, maxSpeedExclusions: t.maxSpeedExclusions ?? [] }));

  return {
    data: {
      title: f.title,
      segmentMode: f.segmentMode,
      video: f.video,
      camera,
      map: f.map,
      musicVolume: f.musicVolume,
      photoDefaultDuration: f.photoDefaultDuration,
      snapEnabled: f.snapEnabled,
      musicTracks: [],
      photoClips,
      textOverlays,
      videoClips: [],
    },
    tracksMeta,
    musicMeta: f.musicTracksMeta ?? [],
    videoMeta: f.version === 2 || f.version === 3 || f.version === 4 ? (f.videoClipsMeta ?? []) : [],
  };
}
