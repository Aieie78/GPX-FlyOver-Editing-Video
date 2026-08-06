import type { PhotoClip, PlaybackSpeed, VideoClip } from '../types/domain';
import { ensureAudioCtx } from '../audio/musicEngine';
import { videoTimeToPathTime } from '../timeline/timelineMath';

// Mirror di photoEngine.ts/musicEngine.ts per le clip video importate (Fase 6,
// prompt-video-import.md): stesso pattern di caricamento/posizionamento, adattato dato che una
// clip video ha una durata intrinseca (come un brano musicale, trimStart/trimEnd) invece di una
// durata di visualizzazione arbitraria (come le foto).

export function loadVideoFile(file: File): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const videoEl = document.createElement('video');
    videoEl.preload = 'auto';
    videoEl.playsInline = true;
    videoEl.src = URL.createObjectURL(file);
    videoEl.onloadedmetadata = () => resolve(videoEl);
    videoEl.onerror = () => reject(new Error(`Impossibile leggere il file video "${file.name}"`));
  });
}

// Stessa decodeAudioData già usata per la musica — null se il file non ha una traccia audio
// utilizzabile o la decodifica fallisce (nessun crash: la clip resta valida, solo muta).
export async function decodeClipAudio(file: File): Promise<AudioBuffer | null> {
  try {
    const ctx = ensureAudioCtx(0.6);
    const arrayBuffer = await file.arrayBuffer();
    return await ctx.decodeAudioData(arrayBuffer);
  } catch {
    return null;
  }
}

// Miniatura per il blocco in timeline: seek al punto richiesto (se non già lì) + cattura su
// canvas offscreen.
export function capturePoster(videoEl: HTMLVideoElement, atSec = 0): Promise<string> {
  return new Promise((resolve) => {
    const capture = () => {
      const canvas = document.createElement('canvas');
      canvas.width = videoEl.videoWidth || 160;
      canvas.height = videoEl.videoHeight || 90;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.7));
    };
    const target = Math.min(atSec, Math.max(0, (videoEl.duration || 0) - 0.05));
    if (Math.abs(videoEl.currentTime - target) < 0.05) {
      capture();
      return;
    }
    const onSeeked = () => {
      videoEl.removeEventListener('seeked', onSeeked);
      capture();
    };
    videoEl.addEventListener('seeked', onSeeked);
    videoEl.currentTime = target;
  });
}

let videoIdSeq = 0;
export function nextVideoId(): number {
  return videoIdSeq++;
}

// Carica una clip e calcola la posizione di attacco predefinita (in coda alle clip esistenti), poi
// la converte in pathFraction — stessa logica/stessa approssimazione (slowZone null) di
// buildPhotoClipAppended (photoEngine.ts). Port della logica in decodeMusicFile (musicEngine.ts),
// adattata al video.
export async function buildVideoClipAppended(
  file: File,
  existingPhotoClips: PhotoClip[],
  existingVideoClips: VideoClip[],
  totalDurationSec: number,
): Promise<VideoClip> {
  const videoEl = await loadVideoFile(file);
  const audioBuffer = await decodeClipAudio(file);
  const posterDataUrl = await capturePoster(videoEl, Math.min(0.1, videoEl.duration || 0));
  const videoStart = existingVideoClips.reduce(
    (max, c) => Math.max(max, c.videoStart + (c.trimEnd - c.trimStart)),
    0,
  );
  const availableSpace = Math.max(0.5, totalDurationSec - videoStart);
  const trimEnd = Math.min(videoEl.duration, availableSpace);
  const safeDuration = Math.max(0.001, totalDurationSec);
  const pathFraction = videoTimeToPathTime(videoStart, existingPhotoClips, safeDuration, existingVideoClips, null) / safeDuration;
  return {
    id: nextVideoId(),
    name: file.name,
    videoEl,
    audioBuffer,
    posterDataUrl,
    videoStart,
    pathFraction,
    trimStart: 0,
    trimEnd,
    muted: false,
  };
}

// Carica una clip e la posiziona esattamente al punto di riproduzione attuale (pulsante "+"
// nella corsia), come decodeMusicFileAtPlayhead/buildPhotoClipAtPlayhead.
export async function buildVideoClipAtPlayhead(
  file: File,
  existingPhotoClips: PhotoClip[],
  existingVideoClips: VideoClip[],
  totalDurationSec: number,
  playheadSec: number,
): Promise<VideoClip> {
  const videoEl = await loadVideoFile(file);
  const audioBuffer = await decodeClipAudio(file);
  const posterDataUrl = await capturePoster(videoEl, Math.min(0.1, videoEl.duration || 0));
  const videoStart = Math.max(0, Math.min(totalDurationSec - 0.5, playheadSec));
  const availableSpace = Math.max(0.5, totalDurationSec - videoStart);
  const trimEnd = Math.min(videoEl.duration, availableSpace);
  const safeDuration = Math.max(0.001, totalDurationSec);
  const pathFraction = videoTimeToPathTime(videoStart, existingPhotoClips, safeDuration, existingVideoClips, null) / safeDuration;
  return {
    id: nextVideoId(),
    name: file.name,
    videoEl,
    audioBuffer,
    posterDataUrl,
    videoStart,
    pathFraction,
    trimStart: 0,
    trimEnd,
    muted: false,
  };
}

// Nessuna dissolvenza incrociata tra clip video sovrapposte (semplificazione accettata): una sola
// clip attiva alla volta — se due si sovrappongono per errore, vince la prima per ordine di inizio.
export function getActiveVideoClip(videoClips: VideoClip[], timeSec: number): VideoClip | null {
  const sorted = [...videoClips].sort((a, b) => a.videoStart - b.videoStart);
  for (const clip of sorted) {
    const length = clip.trimEnd - clip.trimStart;
    if (length <= 0.05) continue;
    const start = clip.videoStart;
    const end = start + length;
    if (timeSec >= start && timeSec < end) return clip;
  }
  return null;
}

// Usata SOLO in esportazione: seek esplicito + attesa dell'evento 'seeked', per la precisione
// deterministica già usata per il resto dell'esportazione. Risolve subito se già al fotogramma
// giusto (altrimenti 'seeked' potrebbe non scattare mai).
export function seekVideoFrame(videoEl: HTMLVideoElement, sourceTime: number): Promise<void> {
  const target = Math.max(0, Math.min(videoEl.duration || sourceTime, sourceTime));
  if (Math.abs(videoEl.currentTime - target) < 0.001) return Promise.resolve();
  return new Promise((resolve) => {
    const onSeeked = () => {
      videoEl.removeEventListener('seeked', onSeeked);
      resolve();
    };
    videoEl.addEventListener('seeked', onSeeked);
    videoEl.currentTime = target;
  });
}

// Usata SOLO in anteprima, mai awaitata: la clip attiva riproduce/mette in pausa da sola (audio
// nativo incluso), velocità sincronizzata a quella di riproduzione scelta, con una correzione di
// deriva se lo scarto rispetto al punto atteso supera 0.15s. Ogni clip non attiva viene messa in
// pausa (anche quella appena terminata).
//
// In pausa il ciclo di rendering NON ridisegna da solo fotogramma dopo fotogramma: se il
// fotogramma richiesto non è ancora decodificato (clip appena aggiunta e mai riprodotta, o uno
// scarto troppo grande rispetto alla posizione corrente dell'elemento <video>), il disegno
// immediato in PreviewEngine.drawOverlay lo salta (readyState<2) e il riquadro video resta vuoto
// finché non si preme play. onFrameReady, se passato, viene richiamato non appena il browser
// consegna il fotogramma richiesto, così il chiamante può ridisegnare quel frame.
export function syncPreviewVideo(
  videoClips: VideoClip[],
  timeSec: number,
  playing: boolean,
  speed: PlaybackSpeed,
  onFrameReady?: () => void,
): void {
  const active = getActiveVideoClip(videoClips, timeSec);
  for (const clip of videoClips) {
    const el = clip.videoEl;
    if (active && clip.id === active.id) {
      const targetTime = clip.trimStart + (timeSec - clip.videoStart);
      el.muted = clip.muted;
      if (el.playbackRate !== speed) el.playbackRate = speed;
      if (playing) {
        if (Math.abs(el.currentTime - targetTime) > 0.15) el.currentTime = targetTime;
        if (el.paused) void el.play().catch(() => {});
      } else {
        if (!el.paused) el.pause();
        const needsFrame = Math.abs(el.currentTime - targetTime) > 0.15 || el.readyState < 2;
        if (needsFrame) {
          if (onFrameReady) {
            const fire = () => {
              el.removeEventListener('seeked', fire);
              onFrameReady();
            };
            el.addEventListener('seeked', fire, { once: true });
          }
          el.currentTime = targetTime;
        }
      }
    } else if (!el.paused) {
      el.pause();
    }
  }
}

// Stesso "contain-fit" di drawPhotoCover (photoEngine.ts) — mostra sempre l'intero fotogramma
// video, con bande nere dove il rapporto d'aspetto non combacia. Nessuna correzione di rotazione
// (semplificazione accettata: i video sono assunti già orientati correttamente).
export function drawVideoCover(ctx: CanvasRenderingContext2D, videoEl: HTMLVideoElement, w: number, h: number): void {
  const vw = videoEl.videoWidth || 1;
  const vh = videoEl.videoHeight || 1;
  const scale = Math.min(w / vw, h / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  ctx.save();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(videoEl, (w - dw) / 2, (h - dh) / 2, dw, dh);
  ctx.restore();
}

// Livello/durata del ducking fissi nel codice, non esposti come impostazione (semplificazione
// accettata per questa prima versione).
const DUCK_LEVEL = 0.22;
const DUCK_FADE_SEC = 0.4;

// Moltiplicatore [0,1] da applicare al volume della musica di sottofondo nell'istante timeSec: 1
// fuori dalle finestre video, DUCK_LEVEL dentro, con una rampa lineare ai bordi (dissolvenza in
// entrata/uscita). Una clip silenziata (muted) non causa ducking — non c'è audio da "proteggere".
export function computeDuckFactor(
  videoClips: VideoClip[],
  timeSec: number,
  duckLevel = DUCK_LEVEL,
  fadeSec = DUCK_FADE_SEC,
): number {
  const active = getActiveVideoClip(videoClips, timeSec);
  if (!active || active.muted) return 1;
  const length = active.trimEnd - active.trimStart;
  const start = active.videoStart;
  const end = start + length;
  const fade = Math.min(fadeSec, length / 2);
  if (timeSec - start < fade) {
    const t = (timeSec - start) / fade;
    return 1 - t * (1 - duckLevel);
  }
  if (end - timeSec < fade) {
    const t = (end - timeSec) / fade;
    return 1 - t * (1 - duckLevel);
  }
  return duckLevel;
}

export { DUCK_LEVEL, DUCK_FADE_SEC };
