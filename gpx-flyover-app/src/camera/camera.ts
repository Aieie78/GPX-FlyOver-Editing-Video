import { bearingBetween, resamplePath } from '../geo/geo';
import type { AnimParams, CameraParams, FrameCamera, Track, VideoParams } from '../types/domain';

// Offset verticale in pixel schermo dovuto alla quota, in proporzione al pitch della camera.
// Port 1:1 da gpx-flyover.html:517.
export function altitudeOffsetPx(altitudeMeters: number, lat: number, zoom: number, pitchDeg: number): number {
  const metersPerPixel = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
  return (altitudeMeters / metersPerPixel) * Math.sin((pitchDeg * Math.PI) / 180);
}

// Converte il pitch "utente" (0° = vista all'orizzonte, 90° = vista verticale dall'alto) nel
// pitch nativo di MapLibre (0° = verticale dall'alto, max 85° = vista all'orizzonte — semantica
// opposta). Punto unico di conversione: da qui in poi (AnimParams.pitch, FrameCamera.pitch) il
// valore è sempre nella semantica MapLibre.
export function toMapPitch(userPitchDeg: number): number {
  return Math.max(0, Math.min(85, 90 - userPitchDeg));
}

// Costruisce i parametri di animazione (percorso ricampionato, lookahead, ecc.).
// Port di buildAnimParams da gpx-flyover.html:679, con i parametri passati esplicitamente
// invece di letti dal DOM.
export function buildAnimParams(
  track: Track,
  video: VideoParams,
  camera: CameraParams,
  title: string,
  durationOverrideSec?: number,
): AnimParams {
  const duration = durationOverrideSec ?? video.durationSec;
  const fps = video.fps;
  const totalFrames = Math.round(duration * fps);
  const path = resamplePath(track, totalFrames);
  // lookahead come frazione dell'intero percorso: la camera segue l'andamento GENERALE
  // del tragitto, non ogni singola curva locale (lettura d'insieme tipo panoramica)
  const lookAheadFrames = Math.max(3, Math.round(totalFrames * 0.08));
  return {
    duration,
    fps,
    pitch: toMapPitch(camera.pitch),
    zoom: camera.zoom,
    orbitAmp: camera.orbitAmp,
    orbitPeriod: camera.orbitPeriod,
    bearingMode: camera.bearingMode,
    fixedBearingDeg: camera.fixedBearingDeg,
    fixedBearingOrbitEnabled: camera.fixedBearingOrbitEnabled,
    totalFrames,
    path,
    title: title || 'Il mio giro',
    lookAheadFrames,
  };
}

// Avanza di un passo il filtro passa-basso del bearing (usato sia in registrazione che in anteprima).
// In modalità bearingMode 'fixed' non c'è nessun inseguimento: il bearing resta ancorato a
// fixedBearingDeg (l'eventuale rotazione nel tempo è aggiunta sopra, in cameraForFrame).
// Port 1:1 da gpx-flyover.html:696 per la modalità 'followPath'.
export function stepBearing(sb: number, i: number, p: AnimParams): number {
  if (p.bearingMode === 'fixed') return p.fixedBearingDeg;
  const cur = p.path[i];
  const next = p.path[Math.min(i + p.lookAheadFrames, p.totalFrames - 1)];
  const target = bearingBetween({ lat: cur.camLat, lon: cur.camLon }, { lat: next.camLat, lon: next.camLon });
  const diff = ((target - sb + 540) % 360) - 180;
  return (sb + diff * 0.035 + 360) % 360;
}

// Port 1:1 da gpx-flyover.html:704 per la modalità 'followPath'.
export function initialBearing(p: AnimParams): number {
  if (p.bearingMode === 'fixed') return p.fixedBearingDeg;
  const nextIdx = Math.min(p.lookAheadFrames, p.totalFrames - 1);
  return bearingBetween(
    { lat: p.path[0].camLat, lon: p.path[0].camLon },
    { lat: p.path[nextIdx].camLat, lon: p.path[nextIdx].camLon },
  );
}

// Port 1:1 da gpx-flyover.html:711. In modalità 'fixed' l'oscillazione orbitAmp/orbitPeriod è
// applicata solo se fixedBearingOrbitEnabled è attivo; in 'followPath' resta sempre attiva
// (comportamento storico, disattivabile impostando orbitAmp a 0).
export function cameraForFrame(p: AnimParams, i: number, smoothBearing: number): FrameCamera {
  const cur = p.path[i];
  const t = i / p.fps;
  const orbitEnabled = p.bearingMode === 'fixed' ? p.fixedBearingOrbitEnabled : true;
  const orbitOffset = orbitEnabled ? p.orbitAmp * Math.sin((2 * Math.PI * t) / p.orbitPeriod) : 0;
  const displayBearing = (smoothBearing + orbitOffset + 360) % 360;
  return { center: [cur.camLon, cur.camLat], zoom: p.zoom, pitch: p.pitch, bearing: displayBearing };
}
