import type { Map as MapLibreMap } from 'maplibre-gl';
import { buildAnimParams, cameraForFrame, initialBearing, stepBearing } from '../camera/camera';
import { ensureAudioCtx } from '../audio/musicEngine';
import { renderMusicMixOffline, sliceAudioBuffer } from '../audio/musicMix';
import { updateRouteDoneUpTo } from '../map/mapSetup';
import { buildTimeIndex, findPointAtTime, getEffectiveMaxSpeedPoint, type TimedPoint, type TimeIndexedTrack } from '../geo/geo';
import { computePathIndex, computeSlowZone } from '../timeline/timelineMath';
import { drawAltitudeLine, drawVehicleIcon, vehicleScreenPos } from '../vehicle/vehicleIcon';
import { drawPhotoCover, getActivePhotoLayers } from '../photos/photoEngine';
import { drawVideoCover, getActiveVideoClip, seekVideoFrame } from '../video/videoEngine';
import { drawLiveStatsBox } from '../stats/liveStatsOverlay';
import {
  buildProfileBackground,
  buildProfileBackgroundStacked,
  drawAltitudeProfile,
  drawAltitudeProfileStacked,
  type ProfileBackground,
} from '../stats/altitudeProfile';
import { drawMaxSpeedMarker, maxSpeedMarkerScreenPos } from '../stats/maxSpeedMarker';
import { drawTextOverlay, getActiveTextOverlays } from '../text/textEngine';
import type {
  CameraParams,
  MaxSpeedExclusion,
  MaxSpeedMarkerParams,
  MaxSpeedPoint,
  MusicTrack,
  PathPoint,
  PhotoClip,
  PlaybackSpeed,
  TextOverlay,
  Track,
  VehicleParams,
  VehicleTrack,
  VideoAspectRatio,
  VideoClip,
  VideoParams,
} from '../types/domain';

// Posizione di una traccia secondaria in un dato fotogramma (Fase 5.3): point è null quando il
// timestamp calcolato cade fuori dal range coperto da quella traccia — l'icona non va disegnata.
export interface SecondaryFramePosition {
  vehicle: VehicleParams;
  minEle: number;
  fileName: string;
  point: TimedPoint | null;
}

export interface AspectCrop {
  // Dimensioni del canvas "largo" di riferimento (16:9) su cui drawOverlayFrame disegna scena +
  // overlay, PRIMA del ritaglio finale.
  resW: number;
  resH: number;
  // Dimensioni finali del video esportato (dopo il ritaglio).
  outW: number;
  outH: number;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

// video.resolution indica sempre una coppia 16:9 (es. "1920x1080") usata come riferimento di
// QUALITÀ (lato corto = resH) — le dimensioni EFFETTIVE del video esportato dipendono anche dal
// formato scelto: per 9:16 il lato corto resta resH (es. 1080) ma diventa la LARGHEZZA, e il lato
// lungo (l'altezza, es. 1920) si ottiene moltiplicando per 16/9 — non è un sottoinsieme più
// piccolo della risoluzione 16:9 scelta, ma un canvas verticale a sé, della stessa qualità
// (stesso numero di pixel sul lato corto). Per 1:1 entrambi i lati sono pari al lato corto.
export function outputDimsFor(resW: number, resH: number, aspectRatio: VideoAspectRatio): { outW: number; outH: number } {
  if (aspectRatio === '16:9') return { outW: resW, outH: resH };
  if (aspectRatio === '1:1') return { outW: resH, outH: resH };
  const outW = resH;
  const outH = Math.round(((resH * 16) / 9) / 2) * 2;
  return { outW, outH };
}

// La scena viene sempre composta su un canvas "largo" 16:9 di riferimento e poi ritagliata al
// centro nel formato scelto — per 16:9 il ritaglio è un no-op (l'intero fotogramma È il
// riferimento, resW/resH = outW/outH). Per 9:16/1:1 il canvas di riferimento è un 16:9
// equivalente la cui ALTEZZA è già quella di output (outH, vedi outputDimsFor) — il ritaglio
// centrale ne preleva la fascia verticale larga outW, sempre entro i bordi per costruzione.
export function computeAspectCrop(resolution: string, aspectRatio: VideoAspectRatio): AspectCrop {
  const [baseW, baseH] = resolution.split('x').map(Number);
  const { outW, outH } = outputDimsFor(baseW, baseH, aspectRatio);
  if (aspectRatio === '16:9') {
    return { resW: outW, resH: outH, outW, outH, sx: 0, sy: 0, sw: outW, sh: outH };
  }
  const resH = outH;
  const resW = Math.round(((outH * 16) / 9) / 2) * 2;
  const sx = Math.max(0, Math.round((resW - outW) / 2));
  return { resW, resH, outW, outH, sx, sy: 0, sw: outW, sh: outH };
}

// Le posizioni di musica/foto sono impostate dall'utente guardando la durata NOMINALE (il campo
// "Durata video"); quando si registra a una velocità diversa da x1, la durata EFFETTIVA si
// comprime/allunga di conseguenza (effectiveDuration = durata/velocità). Senza riscalare le
// posizioni, un blocco piazzato ad es. al 90% della timeline nominale potrebbe cadere OLTRE la
// durata effettiva e sparire in silenzio dal video esportato, invece di restare — proporzionalmente
// — vicino alla fine del video accorciato/allungato. Il ritmo di riproduzione della musica in sé
// (playbackRate) NON cambia: cambia solo QUANTA della porzione tagliata rientra nella finestra
// sulla timeline (si ascolterà meno/più del brano a seconda che si acceleri o rallenti), esattamente
// come una foto mostrata per meno/più tempo — nessun conflitto con "la musica non accelera mai".
export function scaleMusicTracksForSpeed(musicTracks: MusicTrack[], speed: PlaybackSpeed): MusicTrack[] {
  if (speed === 1) return musicTracks;
  return musicTracks.map((t) => ({
    ...t,
    videoStart: t.videoStart / speed,
    trimEnd: t.trimStart + (t.trimEnd - t.trimStart) / speed,
  }));
}

export function scalePhotoClipsForSpeed(photoClips: PhotoClip[], speed: PlaybackSpeed): PhotoClip[] {
  if (speed === 1) return photoClips;
  return photoClips.map((p) => ({
    ...p,
    videoStart: p.videoStart / speed,
    duration: p.duration / speed,
  }));
}

// Stesso riscalamento di scaleMusicTracksForSpeed (stessa forma videoStart/trimStart/trimEnd) —
// una clip video piazzata guardando la durata nominale resta proporzionalmente al suo posto
// quando la durata effettiva si comprime/allunga per la velocità di registrazione scelta.
// Approssimazione accettata per questa prima versione, simmetrica a quella già scelta per la
// musica: in ESPORTAZIONE a velocità ≠ x1 la finestra sulla timeline si accorcia/allunga ma il
// contenuto sorgente resta a ritmo naturale (si vede una porzione proporzionalmente più corta/
// lunga della clip, non l'intera clip accelerata) — in ANTEPRIMA invece la clip è sincronizzata a
// velocità piena (syncPreviewVideo imposta playbackRate=speed sull'elemento <video>, mostrando
// sempre l'intero contenuto scelto). Le due modalità divergono quindi leggermente per questo solo
// aspetto quando speed≠1 — rimandabile in futuro se serve piena coerenza.
export function scaleVideoClipsForSpeed(videoClips: VideoClip[], speed: PlaybackSpeed): VideoClip[] {
  if (speed === 1) return videoClips;
  return videoClips.map((c) => ({
    ...c,
    videoStart: c.videoStart / speed,
    trimEnd: c.trimStart + (c.trimEnd - c.trimStart) / speed,
  }));
}

// Stesso riscalamento di scalePhotoClipsForSpeed, per le sovrapposizioni testuali.
export function scaleTextOverlaysForSpeed(textOverlays: TextOverlay[], speed: PlaybackSpeed): TextOverlay[] {
  if (speed === 1) return textOverlays;
  return textOverlays.map((t) => ({
    ...t,
    videoStart: t.videoStart / speed,
    duration: t.duration / speed,
  }));
}

// Attende fino all'istante di tempo reale target: aspetta con requestAnimationFrame quando
// manca poco (così si sincronizza comunque con il repaint della mappa), altrimenti con
// setTimeout per non tenere occupato il thread durante attese più lunghe. Se il momento target
// è già passato, si risolve immediatamente (nessuna attesa) — usata SOLO per l'attesa
// aggiuntiva quando siamo in anticipo sul ritmo, vedi waitForFrameAndPace più sotto.
function waitUntil(targetTimeMs: number): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      const remaining = targetTimeMs - performance.now();
      if (remaining <= 0) {
        resolve();
        return;
      }
      if (remaining > 20) {
        setTimeout(check, remaining - 10);
      } else {
        requestAnimationFrame(check);
      }
    };
    check();
  });
}

// Aspetta SEMPRE almeno un vero repaint (requestAnimationFrame) dopo un jumpTo — necessario
// perché il canvas della mappa catturato con drawImage() rifletta davvero la nuova inquadratura,
// non quella precedente. In più, se siamo in anticipo sul ritmo reale atteso per questo
// fotogramma, aspetta anche fino al momento giusto. Se invece siamo in ritardo (disegno troppo
// lento), NON salta più l'attesa del repaint come prima — saltarla del tutto lasciava la mappa
// catturata "vecchia" rispetto alla posizione icona già aggiornata, con l'effetto di icona che
// sembra staccarsi/volare rispetto allo sfondo, oltre a contribuire agli scatti.
async function waitForFrameAndPace(targetTimeMs: number): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const remaining = targetTimeMs - performance.now();
  if (remaining > 0) {
    await waitUntil(targetTimeMs);
  }
}

// Esportata: riusata anche dal percorso di rendering deterministico (deterministicExport.ts),
// stesso identico pre-caricamento prima di iniziare a catturare/disegnare fotogrammi.
export function waitForMapIdle(map: MapLibreMap, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      map.off('idle', onIdle);
      clearTimeout(timer);
      resolve();
    };
    const onIdle = () => finish();
    map.on('idle', onIdle);
    const timer = setTimeout(finish, timeoutMs);
  });
}

interface DrawOverlayArgs {
  title: string;
  cur: PathPoint;
  progress: number;
  zoom: number;
  pitch: number;
  timeSec: number;
  photoClips: PhotoClip[];
  videoClips: VideoClip[];
  textOverlays: TextOverlay[];
  showAltitudeProfile: boolean;
  crop: AspectCrop;
}

// Geometria del layout impilato (9:16/1:1): titolo, profilo altimetrico, card statistiche e barra
// di avanzamento, tutti confinati entro la finestra di ritaglio (crop.sx..crop.sx+crop.sw) invece
// che sull'intero canvas largo di riferimento — unica fonte di verità sia per chi pre-costruisce
// lo sfondo del profilo (buildProfileBackgroundStacked, prima del ciclo di rendering) sia per
// drawOverlayFrame (che disegna ogni fotogramma), così le dimensioni restano coerenti tra i due.
// Scala rispetto a una larghezza di riferimento di 1080px (formato verticale "1080p").
export interface StackedLayoutMetrics {
  scale: number;
  titleFontSize: number;
  titleShadowBlur: number;
  titleY: number;
  profileX: number;
  profileY: number;
  profileW: number;
  profileH: number;
  cardX: number;
  cardY: number;
  cardW: number;
  cardH: number;
  cardFontSize: number;
  cardPadX: number;
  row1Y: number;
  row2Y: number;
  col2X: number;
  barX: number;
  barY: number;
  barW: number;
  barH: number;
}

// Tutte le dimensioni sono già risolte in pixel assoluti (compresi font e offset del testo nella
// card) — chi disegna (drawOverlayFrame) non deve applicare NESSUN fattore di scala proprio: usare
// invece un riferimento diverso (es. la scala del canvas largo 16:9) qui produrrebbe testo fuori
// misura rispetto alle posizioni calcolate, con la card statistiche disegnata piccola ma il testo
// al suo interno enorme e traboccante sotto la barra di avanzamento — bug reale osservato in
// verifica: la card usava questa scala (~1x, riferita a 1080px) mentre i fillText successivi
// usavano ancora la scala del canvas largo (~2.7x per 9:16/1080p), risultando scollegati.
export function computeStackedLayout(crop: AspectCrop): StackedLayoutMetrics {
  const s = crop.outW / 1080;
  const margin = 28 * s;
  const left = crop.sx + margin;
  const width = crop.sw - margin * 2;
  const barH = 8 * s;
  const barY = crop.outH - 64 * s;
  const cardH = 116 * s;
  const cardY = barY - 22 * s - cardH;
  const cardPadX = 20 * s;
  return {
    scale: s,
    titleFontSize: 30 * s,
    titleShadowBlur: 8 * s,
    titleY: 64 * s,
    profileX: left,
    profileY: 96 * s,
    profileW: width,
    profileH: 130 * s,
    cardX: left,
    cardY,
    cardW: width,
    cardH,
    cardFontSize: 22 * s,
    cardPadX,
    row1Y: cardY + 40 * s,
    row2Y: cardY + 86 * s,
    col2X: left + width / 2 + 10 * s,
    barX: left,
    barY,
    barW: width,
    barH,
  };
}

// Costruisce lo sfondo del profilo altimetrico nel layout corretto per il formato di export —
// impilato a piena larghezza (9:16/1:1) o in alto a destra come oggi (16:9). Chiamata una volta
// sola per registrazione (prima del ciclo di rendering), non per fotogramma.
export function buildProfileBackgroundFor(track: Track, crop: AspectCrop): ProfileBackground {
  if (crop.outW <= crop.outH) {
    const layout = computeStackedLayout(crop);
    return buildProfileBackgroundStacked(track, layout.profileW, layout.profileH);
  }
  return buildProfileBackground(track, crop.resW / 1280);
}

// Zoom camera leggermente maggiore per i formati non 16:9, per compensare — solo in parte, non
// annullarlo — il minor campo visivo orizzontale dopo il ritaglio centrale (computeAspectCrop):
// costanti modeste, non pensate per restituire lo stesso campo visivo del 16:9 (che richiederebbe
// un ingrandimento molto più aggressivo, a scapito del contesto circostante il percorso). Si
// applica solo in fase di export: l'anteprima interattiva non è mai ritagliata e resta invariata.
const EXPORT_ZOOM_BOOST: Record<VideoAspectRatio, number> = { '16:9': 0, '9:16': 0.5, '1:1': 0.25 };

export function cameraForExport(camera: CameraParams, aspectRatio: VideoAspectRatio): CameraParams {
  const boost = EXPORT_ZOOM_BOOST[aspectRatio];
  return boost ? { ...camera, zoom: camera.zoom + boost } : camera;
}

// Disegna un fotogramma completo dell'overlay di esportazione (mappa + icona mezzo + titolo +
// profilo altimetrico + statistiche + barra avanzamento + foto). Port 1:1 da gpx-flyover.html:1411.
export function drawOverlayFrame(
  recCtx: CanvasRenderingContext2D,
  recCanvas: HTMLCanvasElement,
  map: MapLibreMap,
  track: Track,
  vehicle: VehicleParams,
  vehicleLabel: string,
  maxSpeedMarker: MaxSpeedMarkerParams,
  maxSpeedPoint: MaxSpeedPoint | null,
  profileBg: ProfileBackground,
  args: DrawOverlayArgs,
  secondaryPositions: SecondaryFramePosition[] = [],
): void {
  const { title, cur, progress, zoom, pitch, timeSec, photoClips, videoClips, textOverlays, showAltitudeProfile, crop } = args;
  const stacked = crop.outW <= crop.outH;
  const mapCanvas = map.getCanvas();
  recCtx.drawImage(mapCanvas, 0, 0, recCanvas.width, recCanvas.height);

  // fattore di scala rispetto alla risoluzione di riferimento (1280px larghezza)
  const s = recCanvas.width / 1280;

  // icona del mezzo, in scala con la risoluzione di registrazione
  const mapRect = map.getContainer().getBoundingClientRect();
  const scaleX = recCanvas.width / mapRect.width;
  const scaleY = recCanvas.height / mapRect.height;
  if (vehicle.icon !== 'none') {
    const pos = vehicleScreenPos(map, cur, zoom, pitch, track.minEle, vehicle);
    drawAltitudeLine(recCtx, pos.groundX * scaleX, pos.groundY * scaleY, pos.x * scaleX, pos.y * scaleY, vehicle.color, s);
    drawVehicleIcon(recCtx, pos.x * scaleX, pos.y * scaleY, s, vehicle);
  }

  // icone delle tracce secondarie sincronizzate per orario GPX reale (Fase 5.3) — non disegnata
  // se point è null (timestamp fuori dal range coperto da quella traccia) o se l'icona è "nessuna".
  for (const sec of secondaryPositions) {
    if (!sec.point || sec.vehicle.icon === 'none') continue;
    const secPos = vehicleScreenPos(map, sec.point, zoom, pitch, sec.minEle, sec.vehicle);
    drawAltitudeLine(
      recCtx,
      secPos.groundX * scaleX,
      secPos.groundY * scaleY,
      secPos.x * scaleX,
      secPos.y * scaleY,
      sec.vehicle.color,
      s,
    );
    drawVehicleIcon(recCtx, secPos.x * scaleX, secPos.y * scaleY, s, sec.vehicle);
  }

  // bandierina "Velocità max" — posizione geografica fissa, solo traccia principale, sempre
  // disegnata (non legata al progresso del volo). maxSpeedPoint è il punto EFFETTIVO (già al
  // netto delle esclusioni di "Scarta questo punto"), risolto una volta dal chiamante.
  if (maxSpeedPoint) {
    const maxSpeedPos = maxSpeedMarkerScreenPos(map, maxSpeedPoint, zoom, pitch, track.minEle, maxSpeedMarker);
    drawMaxSpeedMarker(
      recCtx,
      maxSpeedPos.x * scaleX,
      maxSpeedPos.y * scaleY,
      recCanvas.width,
      maxSpeedPoint,
      maxSpeedMarker.sizeScale,
      crop.sx + crop.sw,
    );
  }

  const distSoFar = (cur.dist / 1000).toFixed(1);
  const totalKm = (track.totalDist / 1000).toFixed(1);
  const gainSoFar = Math.round(track.gain * progress);

  if (stacked) {
    const layout = computeStackedLayout(crop);

    // titolo, centrato entro la finestra di ritaglio — tutte le dimensioni vengono dal layout
    // (scala ~1x su riferimento 1080px), MAI dalla `s` esterna (scala del canvas largo 16:9,
    // ~2-3x per 9:16/1:1): mischiare le due scale è il bug già preso una volta in verifica (vedi
    // commento su computeStackedLayout).
    recCtx.font = `bold ${layout.titleFontSize}px system-ui`;
    recCtx.fillStyle = '#fff';
    recCtx.shadowColor = 'rgba(0,0,0,0.6)';
    recCtx.shadowBlur = layout.titleShadowBlur;
    recCtx.textAlign = 'center';
    recCtx.fillText(title, crop.sx + crop.sw / 2, layout.titleY);
    recCtx.shadowBlur = 0;
    recCtx.textAlign = 'left';

    // profilo altimetrico: fascia a piena larghezza sotto il titolo, disattivabile
    if (showAltitudeProfile) {
      drawAltitudeProfileStacked(recCtx, layout.profileX, layout.profileY, track, profileBg, progress);
    }

    // card statistiche: righe impilate invece che affiancate (distanza, poi dislivello/quota)
    recCtx.fillStyle = 'rgba(0,0,0,0.45)';
    recCtx.fillRect(layout.cardX, layout.cardY, layout.cardW, layout.cardH);
    recCtx.fillStyle = '#ffcc00';
    recCtx.font = `bold ${layout.cardFontSize}px system-ui`;
    recCtx.fillText(`${distSoFar} / ${totalKm} km`, layout.cardX + layout.cardPadX, layout.row1Y);
    recCtx.fillText(`+${gainSoFar} m`, layout.cardX + layout.cardPadX, layout.row2Y);
    recCtx.fillText(`⛰ ${Math.round(cur.ele)} m`, layout.col2X, layout.row2Y);

    // barra di avanzamento, tutta larghezza
    recCtx.fillStyle = 'rgba(255,255,255,0.25)';
    recCtx.fillRect(layout.barX, layout.barY, layout.barW, layout.barH);
    recCtx.fillStyle = '#ffcc00';
    recCtx.fillRect(layout.barX, layout.barY, layout.barW * progress, layout.barH);
  } else {
    // titolo
    recCtx.font = `bold ${34 * s}px system-ui`;
    recCtx.fillStyle = '#fff';
    recCtx.shadowColor = 'rgba(0,0,0,0.6)';
    recCtx.shadowBlur = 8 * s;
    recCtx.fillText(title, 40 * s, 60 * s);
    recCtx.shadowBlur = 0;

    // ---- profilo altimetrico (sagoma pre-disegnata) in alto a destra, disattivabile ----
    if (showAltitudeProfile) {
      drawAltitudeProfile(recCtx, recCanvas.width, track, profileBg, progress);
    }

    // barra stats in basso
    recCtx.fillStyle = 'rgba(0,0,0,0.45)';
    recCtx.fillRect(30 * s, recCanvas.height - 90 * s, 520 * s, 60 * s);
    recCtx.fillStyle = '#ffcc00';
    recCtx.font = `bold ${20 * s}px system-ui`;
    recCtx.fillText(`${distSoFar} / ${totalKm} km`, 50 * s, recCanvas.height - 58 * s);
    recCtx.fillText(`+${gainSoFar} m`, 250 * s, recCanvas.height - 58 * s);
    recCtx.fillText(`⛰ ${Math.round(cur.ele)} m`, 400 * s, recCanvas.height - 58 * s);

    // barra di avanzamento
    recCtx.fillStyle = 'rgba(255,255,255,0.25)';
    recCtx.fillRect(30 * s, recCanvas.height - 25 * s, 520 * s, 6 * s);
    recCtx.fillStyle = '#ffcc00';
    recCtx.fillRect(30 * s, recCanvas.height - 25 * s, 520 * s * progress, 6 * s);
  }

  // foto della timeline (se attiva in questo istante): copre tutto il resto
  const activeLayers = getActivePhotoLayers(photoClips, timeSec);
  for (const layer of activeLayers) {
    drawPhotoCover(recCtx, layer.photo.img, recCanvas.width, recCanvas.height, layer.alpha, layer.photo.rotation);
  }

  // clip video della timeline (se attiva in questo istante): stesso punto delle foto, dopo di esse
  const activeVideoClip = getActiveVideoClip(videoClips, timeSec);
  if (activeVideoClip) {
    drawVideoCover(recCtx, activeVideoClip.videoEl, recCanvas.width, recCanvas.height);
  }

  // sovrapposizioni testuali della timeline (didascalie/titoli multipli)
  const activeTexts = getActiveTextOverlays(textOverlays, timeSec);
  for (const t of activeTexts) {
    drawTextOverlay(recCtx, recCanvas.width, recCanvas.height, t.overlay.text, t.alpha, t.overlay.x, t.overlay.y);
  }

  // riquadro/i "dati in tempo reale": uno per ciascuna traccia con la checkbox attiva (Fase
  // 5.3-bis) — principale (posizione/scala dal proprio VehicleParams) e/o secondarie.
  if (vehicle.showLiveStats) {
    drawLiveStatsBox(
      recCtx,
      recCanvas.width,
      recCanvas.height,
      cur,
      vehicleLabel,
      vehicle.color,
      vehicle.liveStatsX,
      vehicle.liveStatsY,
      vehicle.liveStatsScale,
    );
  }
  for (const sec of secondaryPositions) {
    if (!sec.point || !sec.vehicle.showLiveStats) continue;
    drawLiveStatsBox(
      recCtx,
      recCanvas.width,
      recCanvas.height,
      { ...sec.point, clockTimeMs: cur.clockTimeMs },
      sec.fileName,
      sec.vehicle.color,
      sec.vehicle.liveStatsX,
      sec.vehicle.liveStatsY,
      sec.vehicle.liveStatsScale,
    );
  }
}

export interface RecordFlightArgs {
  map: MapLibreMap;
  track: Track;
  primaryTrackId: number;
  primaryFileName: string;
  recCanvas: HTMLCanvasElement;
  video: VideoParams;
  camera: CameraParams;
  vehicle: VehicleParams;
  maxSpeedMarker: MaxSpeedMarkerParams;
  maxSpeedExclusions: MaxSpeedExclusion[];
  secondaryTracks: VehicleTrack[];
  musicTracks: MusicTrack[];
  musicVolume: number;
  title: string;
  selectedSpeed: PlaybackSpeed;
  photoClips: PhotoClip[];
  videoClips: VideoClip[];
  textOverlays: TextOverlay[];
}

// Prepara, per ciascuna traccia secondaria, l'indice per la ricerca per timestamp (una volta per
// registrazione, non per frame) e calcola posizione + coordinate del tratto "già percorso" per un
// dato istante di tempo reale (clockTimeMs della principale in quel frame) — condiviso da
// recordFlight e recordFlightDeterministic.
export function buildSecondaryIndexes(secondaryTracks: VehicleTrack[]): Array<{ track: VehicleTrack; timeIndex: TimeIndexedTrack }> {
  return secondaryTracks.map((t) => ({ track: t, timeIndex: buildTimeIndex(t.track) }));
}

export function computeSecondaryFrame(
  map: MapLibreMap,
  secondaryIndexes: Array<{ track: VehicleTrack; timeIndex: TimeIndexedTrack }>,
  targetTimeMs: number | null,
): SecondaryFramePosition[] {
  return secondaryIndexes.map(({ track: t, timeIndex }) => {
    const point = targetTimeMs != null ? findPointAtTime(timeIndex, targetTimeMs) : null;
    if (point) {
      const coords: Array<[number, number]> = timeIndex.pts.slice(0, point.idx).map((p) => [p.lon, p.lat]);
      coords.push([point.lon, point.lat]);
      updateRouteDoneUpTo(map, coords, String(t.id));
    }
    return { vehicle: t.vehicle, minEle: t.track.minEle, fileName: t.fileName, point };
  });
}

// Registrazione lineare, dall'inizio alla fine, per il file video — riproduce il volo in
// tempo reale (un video di 3 minuti impiega 3 minuti a generarsi). Il rendering deterministico
// più veloce del tempo reale è una funzionalità nuova pianificata per una fase successiva
// (prompt-refactoring.md, priorità alta #1) — qui si mantiene lo stesso comportamento
// dell'originale. Port 1:1 da gpx-flyover.html:730-818.
export async function recordFlight(args: RecordFlightArgs): Promise<Blob> {
  const {
    map,
    track,
    primaryTrackId,
    primaryFileName,
    recCanvas,
    video,
    camera,
    vehicle,
    maxSpeedMarker,
    maxSpeedExclusions,
    secondaryTracks,
    musicTracks,
    musicVolume,
    title,
    selectedSpeed,
    photoClips,
    videoClips,
    textOverlays,
  } = args;
  const secondaryIndexes = buildSecondaryIndexes(secondaryTracks);
  const effectiveMaxSpeedPoint = getEffectiveMaxSpeedPoint(track, maxSpeedExclusions);
  const slowZone = computeSlowZone(effectiveMaxSpeedPoint, track.totalDist, maxSpeedMarker);

  const baseDuration = video.durationSec;
  const effectiveDuration = baseDuration / selectedSpeed; // x1.5/x2 = video più corto e più rapido, x0.5 = più lungo e lento
  const p = buildAnimParams(track, video, cameraForExport(camera, video.aspectRatio), title, effectiveDuration);
  let smoothBearing = initialBearing(p);

  // Le posizioni di musica/foto/video/testo sono pensate dall'utente sulla durata NOMINALE — a
  // velocità diversa da x1 vanno riscalate sulla durata EFFETTIVA per restare proporzionalmente
  // corrette (vedi scaleMusicTracksForSpeed/scalePhotoClipsForSpeed/scaleVideoClipsForSpeed/
  // scaleTextOverlaysForSpeed più sopra).
  const scaledMusicTracks = scaleMusicTracksForSpeed(musicTracks, selectedSpeed);
  const scaledPhotoClips = scalePhotoClipsForSpeed(photoClips, selectedSpeed);
  const scaledVideoClips = scaleVideoClipsForSpeed(videoClips, selectedSpeed);
  const scaledTextOverlays = scaleTextOverlaysForSpeed(textOverlays, selectedSpeed);

  // Intervallo selezionato con le maniglie sulla barra video (PreviewControls.tsx), in secondi
  // NOMINALI (0..durationSec) — riscalato in proporzione alla durata effettiva come tutto il
  // resto. L'anteprima interattiva non è toccata da questo ritaglio: riguarda solo l'esportazione.
  const rangeEndNominal = video.trimEndSec ?? baseDuration;
  const effRangeStart = Math.max(0, video.trimStartSec / selectedSpeed);
  const effRangeEnd = Math.min(effectiveDuration, rangeEndNominal / selectedSpeed);
  const frameStart = Math.max(0, Math.min(p.totalFrames - 1, Math.round(effRangeStart * p.fps)));
  const frameEnd = Math.max(frameStart + 1, Math.min(p.totalFrames, Math.round(effRangeEnd * p.fps)));

  // La scena viene sempre composta su un canvas 16:9 di riferimento separato (composeCanvas), poi
  // ritagliata al centro nel formato scelto (video.aspectRatio) sul recCanvas vero e proprio,
  // quello effettivamente catturato da captureStream/MediaRecorder — per 16:9 il ritaglio è un
  // no-op (l'intero fotogramma). Per 9:16/1:1 il riferimento è più alto (non più semplicemente le
  // dimensioni scelte in "Risoluzione video", vedi computeAspectCrop) e l'output ha risoluzione
  // dedicata (es. 1080×1920), non una porzione più piccola della risoluzione 16:9 scelta.
  const crop = computeAspectCrop(video.resolution, video.aspectRatio);
  recCanvas.width = crop.outW;
  recCanvas.height = crop.outH;
  const recCtx = recCanvas.getContext('2d')!;
  const composeCanvas = document.createElement('canvas');
  composeCanvas.width = crop.resW;
  composeCanvas.height = crop.resH;
  const composeCtx = composeCanvas.getContext('2d')!;

  const recordedChunks: Blob[] = [];
  const videoStream = recCanvas.captureStream(p.fps);
  const profileBg = buildProfileBackgroundFor(track, crop);

  // Pre-caricamento: posiziona la camera sul PRIMO fotogramma del ritaglio (non necessariamente
  // l'inizio assoluto del percorso) e attende che la mappa sia effettivamente pronta (tile
  // visibili caricate) PRIMA di avviare MediaRecorder — altrimenti i primi secondi del video
  // mostrerebbero tile a bassa risoluzione/incomplete, dato che la cattura partirebbe subito dopo
  // il click invece che a mappa già pronta in quella posizione.
  const pathIndexAtStart = computePathIndex(frameStart / p.fps, p.totalFrames, p.fps, scaledPhotoClips, scaledVideoClips, slowZone);
  map.jumpTo(cameraForFrame(p, pathIndexAtStart, smoothBearing));
  updateRouteDoneUpTo(
    map,
    p.path.slice(0, pathIndexAtStart + 1).map((pt) => [pt.lon, pt.lat]),
    String(primaryTrackId),
  );
  computeSecondaryFrame(map, secondaryIndexes, p.path[pathIndexAtStart].clockTimeMs);
  await waitForMapIdle(map);

  // --- musica di sottofondo (posizionamento libero per brano, opzionale) + audio delle clip
  // video (ducking automatico della musica durante le loro finestre) ---
  // Il mix (sovrapposizioni + dissolvenze incrociate + volume/mute/solo + audio clip/ducking)
  // viene calcolato in anticipo con lo stesso renderer offline del percorso deterministico
  // (musicMix.ts), poi ritagliato all'intervallo selezionato e riprodotto dal vivo come UN SOLO
  // buffer — più semplice e robusto che programmare live ogni singolo brano con inizio/fine
  // spostati sull'intervallo (specie per brani già iniziati PRIMA del ritaglio), e il risultato
  // finale è identico a quello usato dal rendering deterministico.
  const musicBuffer = await renderMusicMixOffline(scaledMusicTracks, musicVolume, effectiveDuration, scaledVideoClips);
  const slicedMusicBuffer = musicBuffer ? sliceAudioBuffer(musicBuffer, effRangeStart, effRangeEnd) : null;
  const hasMusic = slicedMusicBuffer != null;

  const tracks: MediaStreamTrack[] = [...videoStream.getVideoTracks()];
  const scheduledSources: AudioBufferSourceNode[] = [];

  if (slicedMusicBuffer) {
    const ctx = ensureAudioCtx(musicVolume);
    const dest = ctx.createMediaStreamDestination();
    const startAt = ctx.currentTime + 0.05; // piccolo margine di sicurezza
    const source = ctx.createBufferSource();
    source.buffer = slicedMusicBuffer;
    source.connect(dest);
    source.start(startAt);
    scheduledSources.push(source);
    tracks.push(...dest.stream.getAudioTracks());
  }

  const stream = new MediaStream(tracks);
  const mimeCandidates = hasMusic
    ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  const mime = mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';
  const mediaRecorder = new MediaRecorder(stream, {
    ...(mime ? { mimeType: mime } : {}),
    videoBitsPerSecond: video.bitrateMbps * 1_000_000,
  });
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) recordedChunks.push(e.data);
  };
  mediaRecorder.start();

  // canvas.captureStream(fps) cattura un fotogramma ogni 1/fps di tempo REALE, per tutta la
  // durata della sessione (dall'avvio della registrazione a mediaRecorder.stop()) —
  // indipendentemente da quanti fotogrammi il nostro ciclo riesce effettivamente a disegnare.
  // Ogni fotogramma aspetta SEMPRE almeno un repaint reale dopo il jumpTo (altrimenti il canvas
  // mappa catturato può restare "vecchio" rispetto alla posizione icona già aggiornata — visto
  // che l'icona sembrava staccarsi/volare dallo sfondo) e in più si allinea all'orologio reale
  // se siamo in anticipo, per far corrispondere la durata del video a quella attesa da
  // selectedSpeed. Se il disegno è più lento del budget 1/fps la sessione può comunque allungarsi
  // un po' — è il limite intrinseco della cattura in tempo reale, superabile solo con un
  // rendering deterministico frame-by-frame (prompt-refactoring.md, priorità alta #1).
  // recordingStart è arretrato di quanto "salta" il ritaglio (frameStart/fps), così il ritmo si
  // allinea subito al primo fotogramma del ritaglio invece di aspettare inutilmente che scada il
  // tempo reale corrispondente alla porzione tagliata prima dell'inizio scelto.
  const recordingStart = performance.now() - (frameStart / p.fps) * 1000;
  let lastPathIndex = 0;
  for (let i = frameStart; i < frameEnd; i++) {
    // videoTimeSec resta assoluto (rispetto all'intera durata effettiva, non al ritaglio) —
    // foto/testo/percorso/musica sono già ritagliati/allineati su questa stessa base assoluta.
    const videoTimeSec = i / p.fps;
    const pathIndex = computePathIndex(videoTimeSec, p.totalFrames, p.fps, scaledPhotoClips, scaledVideoClips, slowZone);
    while (lastPathIndex < pathIndex) {
      lastPathIndex++;
      smoothBearing = stepBearing(smoothBearing, lastPathIndex, p);
    }
    map.jumpTo(cameraForFrame(p, pathIndex, smoothBearing));
    updateRouteDoneUpTo(
      map,
      p.path.slice(0, pathIndex + 1).map((pt) => [pt.lon, pt.lat]),
      String(primaryTrackId),
    );
    const secondaryPositions = computeSecondaryFrame(map, secondaryIndexes, p.path[pathIndex].clockTimeMs);
    // Se una clip video è attiva in questo istante, seek esplicito al fotogramma sorgente giusto
    // PRIMA di disegnare — per precisione deterministica, come il resto dell'esportazione.
    const activeClip = getActiveVideoClip(scaledVideoClips, videoTimeSec);
    if (activeClip) {
      await seekVideoFrame(activeClip.videoEl, activeClip.trimStart + (videoTimeSec - activeClip.videoStart));
    }
    await waitForFrameAndPace(recordingStart + videoTimeSec * 1000);
    drawOverlayFrame(
      composeCtx,
      composeCanvas,
      map,
      track,
      vehicle,
      primaryFileName,
      maxSpeedMarker,
      effectiveMaxSpeedPoint,
      profileBg,
      {
        title: p.title,
        cur: p.path[pathIndex],
        progress: (pathIndex + 1) / p.totalFrames,
        zoom: p.zoom,
        pitch: p.pitch,
        timeSec: videoTimeSec,
        photoClips: scaledPhotoClips,
        videoClips: scaledVideoClips,
        textOverlays: scaledTextOverlays,
        showAltitudeProfile: video.showAltitudeProfile,
        crop,
      },
      secondaryPositions,
    );
    recCtx.drawImage(composeCanvas, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, crop.outW, crop.outH);
  }

  await new Promise((r) => setTimeout(r, 300)); // ultimo frame
  mediaRecorder.stop();
  await new Promise<void>((resolve) => {
    mediaRecorder.onstop = () => resolve();
  });
  scheduledSources.forEach((s) => {
    try {
      s.stop();
    } catch {
      /* già fermata */
    }
  });

  return new Blob(recordedChunks, { type: 'video/webm' });
}
