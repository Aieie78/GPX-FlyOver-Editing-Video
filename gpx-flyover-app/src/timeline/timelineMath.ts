import type { PhotoClip, VideoClip } from '../types/domain';

// Adatta foto+video a un'unica lista di finestre di congelamento {videoStart, duration} — la
// stessa forma già usata da videoTimeToPathTime, senza doverne riscrivere l'algoritmo (Fase 6,
// prompt-video-import.md: le clip video congelano il volo esattamente come le foto).
interface FreezeWindow {
  videoStart: number;
  duration: number;
}

function freezeWindowsOf(photoClips: PhotoClip[], videoClips: VideoClip[]): FreezeWindow[] {
  return [
    ...photoClips.map((p) => ({ videoStart: p.videoStart, duration: p.duration })),
    ...videoClips.map((c) => ({ videoStart: c.videoStart, duration: c.trimEnd - c.trimStart })),
  ];
}

// Calamita: arrotonda un valore in secondi al candidato più vicino (0, durata totale, playhead,
// bordi di altri blocchi) se entro una piccola soglia — utile per accostare i blocchi senza buchi.
// Port 1:1 da gpx-flyover.html:669.
export function snapValue(value: number, candidates: number[], thresholdSec: number): number {
  let best = value;
  let bestDist = thresholdSec;
  for (const c of candidates) {
    const d = Math.abs(value - c);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

// Converte un istante della timeline VIDEO in un istante della timeline di VOLO (percorso),
// congelando l'avanzamento durante gli intervalli in cui è attiva una foto — il volo
// riprende esattamente da dove si trovava quando la foto termina. Base 1:1 da
// gpx-flyover.html:614, con un riscalamento aggiunto: il tempo "congelato" dalle foto viene
// sottratto come prima, ma il tempo di volo risultante viene poi MOLTIPLICATO per
// totalDurationSec/tempoDiVoloDisponibile, così il percorso completa SEMPRE l'intero tracciato
// entro la durata video impostata, qualunque sia il tempo totale rubato dalle foto — altrimenti
// il volo si fermerebbe prima della fine, esattamente in proporzione al tempo delle foto (bug
// osservato: un volo di 40s con foto/musica sovrapposte si fermava al 76% del percorso).
export function videoTimeToPathTime(
  videoTime: number,
  photoClips: PhotoClip[],
  totalDurationSec: number,
  videoClips: VideoClip[] = [],
): number {
  const sorted = freezeWindowsOf(photoClips, videoClips).sort((a, b) => a.videoStart - b.videoStart);
  let subtracted = 0;
  for (const w of sorted) {
    if (videoTime <= w.videoStart) break;
    if (videoTime >= w.videoStart + w.duration) {
      subtracted += w.duration; // finestra già passata: tutto il suo tempo non conta per il volo
    } else {
      subtracted += videoTime - w.videoStart; // dentro la finestra adesso: congela qui
      break;
    }
  }
  const rawFlightTime = Math.max(0, videoTime - subtracted);

  const totalFrozenTime = sorted.reduce((sum, w) => sum + w.duration, 0);
  const availableFlightTime = Math.max(0.001, totalDurationSec - totalFrozenTime);
  const speedUpFactor = totalDurationSec / availableFlightTime;

  return rawFlightTime * speedUpFactor;
}

export interface RowAssignItem {
  id: number;
  start: number;
  length: number;
}

// Assegna a ciascun blocco una "sotto-riga" (0, 1, 2...) all'interno della stessa corsia, in modo
// che blocchi sovrapposti/adiacenti nel tempo finiscano su righe visive separate invece di
// impilarsi uno sopra l'altro. Algoritmo greedy classico da "interval scheduling": si scorrono i
// blocchi in ordine di inizio e si riusa la prima riga già libera (il cui ultimo blocco finisce
// prima dell'inizio di quello corrente), altrimenti se ne apre una nuova.
export function assignLaneRows(items: RowAssignItem[]): Map<number, number> {
  const sorted = [...items].sort((a, b) => a.start - b.start);
  const rowEnds: number[] = [];
  const rows = new Map<number, number>();
  for (const item of sorted) {
    let row = rowEnds.findIndex((end) => end <= item.start + 1e-6);
    if (row === -1) {
      row = rowEnds.length;
      rowEnds.push(item.start + item.length);
    } else {
      rowEnds[row] = item.start + item.length;
    }
    rows.set(item.id, row);
  }
  return rows;
}

// Port 1:1 da gpx-flyover.html:629, con il riscalamento di videoTimeToPathTime propagato.
export function computePathIndex(
  videoTimeSec: number,
  totalFrames: number,
  fps: number,
  photoClips: PhotoClip[],
  videoClips: VideoClip[] = [],
): number {
  const totalDurationSec = totalFrames / fps;
  const pt = videoTimeToPathTime(videoTimeSec, photoClips, totalDurationSec, videoClips);
  return Math.max(0, Math.min(totalFrames - 1, Math.round(pt * fps)));
}
