import type { Track } from '../types/domain';

export interface ProfileBackground {
  canvas: HTMLCanvasElement;
  pw: number;
  ph: number;
  eleMin: number;
  eleRange: number;
}

// Disegna la sagoma statica (sfondo sfumato + linea, 250 punti) in un canvas pw x ph — nucleo
// condiviso da buildProfileBackground (layout orizzontale, dimensioni derivate dalla scala) e
// buildProfileBackgroundStacked (layout verticale/impilato, dimensioni esplicite a piena
// larghezza del formato).
function renderProfileCanvas(track: Track, pw: number, ph: number, lineWidth: number): Omit<ProfileBackground, 'pw' | 'ph'> {
  const canvas = document.createElement('canvas');
  canvas.width = pw;
  canvas.height = ph;
  const ctx = canvas.getContext('2d')!;
  const profile = track.profile;
  const eleMin = Math.min(...profile);
  const eleMax = Math.max(...profile);
  const eleRange = Math.max(1, eleMax - eleMin);

  ctx.beginPath();
  ctx.moveTo(0, ph);
  profile.forEach((e, i) => {
    const x = (i / (profile.length - 1)) * pw;
    const y = ph - ((e - eleMin) / eleRange) * ph * 0.85;
    ctx.lineTo(x, y);
  });
  ctx.lineTo(pw, ph);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, ph);
  grad.addColorStop(0, 'rgba(255,204,0,0.55)');
  grad.addColorStop(1, 'rgba(255,204,0,0.08)');
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.8)';
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  profile.forEach((e, i) => {
    const x = (i / (profile.length - 1)) * pw;
    const y = ph - ((e - eleMin) / eleRange) * ph * 0.85;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  return { canvas, eleMin, eleRange };
}

// Pre-disegna la sagoma statica del profilo altimetrico (formato orizzontale, in alto a destra)
// UNA sola volta per sessione (registrazione, o anteprima finché non cambiano traccia/dimensione
// canvas — vedi PreviewEngine), invece di ricostruirla ad ogni fotogramma — l'unica parte che
// cambia frame per frame è il pallino di avanzamento, disegnato da drawAltitudeProfile qui sotto
// sopra l'immagine già pronta.
export function buildProfileBackground(track: Track, s: number): ProfileBackground {
  const pw = 420 * s;
  const ph = 90 * s;
  return { ...renderProfileCanvas(track, pw, ph, 1.5 * s), pw, ph };
}

// Variante per il layout impilato (9:16/1:1): dimensioni esplicite in pixel (fascia a piena
// larghezza sotto il titolo, vedi drawOverlayFrame) invece che derivate dalla scala 16:9.
export function buildProfileBackgroundStacked(track: Track, pw: number, ph: number): ProfileBackground {
  return { ...renderProfileCanvas(track, pw, ph, 2), pw, ph };
}

// Disegna lo sfondo del profilo già pronto (canvas pre-renderizzato) più il pallino di posizione
// attuale (progress 0..1 lungo il percorso) all'origine (x, y) indicata — unica parte ridisegnata
// ad ogni fotogramma. Nucleo condiviso da drawAltitudeProfile (layout orizzontale) e
// drawAltitudeProfileStacked (layout impilato).
function drawProfileAt(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  track: Track,
  profileBg: ProfileBackground,
  progress: number,
  markerRadius: number,
  markerLineWidth: number,
): void {
  const { canvas: profileCanvas, pw, ph, eleMin, eleRange } = profileBg;
  ctx.drawImage(profileCanvas, x, y);

  const profile = track.profile;
  const markerX = x + progress * pw;
  const markerIdx = Math.min(profile.length - 1, Math.round(progress * (profile.length - 1)));
  const markerY = y + ph - ((profile[markerIdx] - eleMin) / eleRange) * ph * 0.85;
  ctx.save();
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(markerX, markerY, markerRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = markerLineWidth;
  ctx.stroke();
  ctx.restore();
}

// Layout orizzontale (16:9): in alto a destra del fotogramma. Condivisa da drawOverlayFrame
// (videoExport.ts, video esportato) e da PreviewEngine.drawOverlay (anteprima interattiva): stessa
// identica logica in entrambi, così quello che si vede in anteprima corrisponde esattamente al
// video finale.
export function drawAltitudeProfile(
  ctx: CanvasRenderingContext2D,
  canvasW: number,
  track: Track,
  profileBg: ProfileBackground,
  progress: number,
): void {
  const s = canvasW / 1280;
  const px = canvasW - profileBg.pw - 40 * s;
  const py = 20 * s;
  drawProfileAt(ctx, px, py, track, profileBg, progress, 5 * s, 1 * s);
}

// Layout impilato (9:16/1:1): fascia a piena larghezza, posizione esplicita passata dal chiamante
// (drawOverlayFrame) — vedi buildProfileBackgroundStacked.
export function drawAltitudeProfileStacked(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  track: Track,
  profileBg: ProfileBackground,
  progress: number,
): void {
  drawProfileAt(ctx, x, y, track, profileBg, progress, 7, 1.5);
}
