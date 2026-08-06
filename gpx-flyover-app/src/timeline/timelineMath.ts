import type { MaxSpeedMarkerParams, MaxSpeedPoint, PhotoClip, VideoClip } from '../types/domain';

// Codifica un id "kind+id" (photo/video) in un intero unico — le due sequenze nextPhotoId()/
// nextVideoId() sono indipendenti e possono collidere (stesso numero per una foto e un video),
// quindi combinare le due liste in un solo grafo di risoluzione (necessario per la sovrapposizione
// foto↔video, "vince il video") richiede id davvero univoci prima di passarli a
// resolvePathAnchoredPositions.
function encodeClipId(kind: 'photo' | 'video', id: number): number {
  return kind === 'photo' ? id * 2 : id * 2 + 1;
}

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

// Zona di rallentamento intorno al punto di velocità massima, espressa in frazione di distanza
// (0..1) lungo il percorso — path[] è ricampionato a distanza costante (resamplePath, geo.ts),
// quindi la frazione di distanza coincide con la frazione di indice del percorso. factor è la
// velocità relativa del volo dentro la zona (0..1: 1 = nessun rallentamento).
export interface SlowZone {
  fStart: number;
  fEnd: number;
  factor: number;
}

// Costruisce la zona di rallentamento dalle impostazioni utente (pannello Mezzo) e dal punto di
// velocità massima EFFETTIVO della traccia principale (getEffectiveMaxSpeedPoint, geo.ts — tiene
// conto delle esclusioni di "Scarta questo punto") — null se non c'è un punto valido (nessun
// timestamp GPX, o tutti esclusi) o se la finestra risultante è vuota (bordo del percorso +
// entrambe le distanze nulle). Va ricalcolata quando cambiano traccia/esclusioni/impostazioni, non
// ad ogni fotogramma — ma è pura aritmetica: anche chiamarla ogni fotogramma è a costo trascurabile.
export function computeSlowZone(maxSpeedPoint: MaxSpeedPoint | null, totalDist: number, marker: MaxSpeedMarkerParams): SlowZone | null {
  if (!maxSpeedPoint || totalDist <= 0) return null;
  const f0 = maxSpeedPoint.dist / totalDist;
  const fStart = Math.max(0, f0 - marker.slowdownBeforeM / totalDist);
  const fEnd = Math.min(1, f0 + marker.slowdownAfterM / totalDist);
  if (fEnd <= fStart) return null;
  const factor = Math.min(1, Math.max(0.01, marker.slowdownFactor));
  return { fStart, fEnd, factor };
}

// Quanto tempo IN PIÙ (secondi) la zona di rallentamento aggiunge rispetto a un volo a ritmo
// costante di durata flightRecommendedSec — usato per il suggerimento "durata totale consigliata"
// (GpxSourcePanel.tsx): la porzione di percorso Δf coperta dalla zona, che al ritmo normale
// richiederebbe Δf*flightRecommendedSec, ne richiede invece Δf*flightRecommendedSec/factor.
export function slowZoneExtraSeconds(slowZone: SlowZone | null, flightRecommendedSec: number): number {
  if (!slowZone) return 0;
  const dfSlow = slowZone.fEnd - slowZone.fStart;
  return dfSlow * flightRecommendedSec * (1 / slowZone.factor - 1);
}

// Converte "tempo di volo grezzo" (rawFlightTime: video-time già depurato da foto+video, 0..
// availableFlightTime) in frazione di percorso (0..1), tenendo conto dell'eventuale zona di
// rallentamento. Senza zona: rapporto costante (comportamento originale). Con zona: tre tratti a
// velocità costante — normale, rallentata (factor), normale — le cui durate si ricavano in forma
// chiusa dalla conservazione del tempo totale (niente iterazione): (1-Δf)/R + Δf/(R·factor) =
// availableFlightTime, quindi R = [(1-Δf) + Δf/factor] / availableFlightTime.
function rawFlightTimeToFraction(rawFlightTime: number, availableFlightTime: number, slowZone: SlowZone | null): number {
  if (!slowZone) {
    return Math.max(0, Math.min(1, rawFlightTime / availableFlightTime));
  }
  const { fStart, fEnd, factor } = slowZone;
  const dfSlow = fEnd - fStart;
  const rate = ((1 - dfSlow) + dfSlow / factor) / availableFlightTime;
  const t1 = fStart / rate;
  const t2 = t1 + dfSlow / (rate * factor);
  let f: number;
  if (rawFlightTime <= t1) f = rawFlightTime * rate;
  else if (rawFlightTime <= t2) f = fStart + (rawFlightTime - t1) * rate * factor;
  else f = fEnd + (rawFlightTime - t2) * rate;
  return Math.max(0, Math.min(1, f));
}

// Inversa di rawFlightTimeToFraction: dalla frazione di percorso target risale al tempo di volo
// grezzo corrispondente, invertendo lo stesso tratto a 3 segmenti.
function fractionToRawFlightTime(fraction: number, availableFlightTime: number, slowZone: SlowZone | null): number {
  if (!slowZone) return fraction * availableFlightTime;
  const { fStart, fEnd, factor } = slowZone;
  const dfSlow = fEnd - fStart;
  const rate = ((1 - dfSlow) + dfSlow / factor) / availableFlightTime;
  const t1 = fStart / rate;
  if (fraction <= fStart) return fraction / rate;
  if (fraction <= fEnd) return t1 + (fraction - fStart) / (rate * factor);
  return t1 + dfSlow / (rate * factor) + (fraction - fEnd) / rate;
}

// Converte un istante della timeline VIDEO in un istante della timeline di VOLO (percorso),
// congelando l'avanzamento durante gli intervalli in cui è attiva una foto o una clip video — il
// volo riprende esattamente da dove si trovava quando la finestra termina. Base 1:1 da
// gpx-flyover.html:614, con un riscalamento aggiunto: il tempo "congelato" viene sottratto come
// prima, ma il tempo di volo risultante viene poi MOLTIPLICATO per
// totalDurationSec/tempoDiVoloDisponibile, così il percorso completa SEMPRE l'intero tracciato
// entro la durata video impostata, qualunque sia il tempo totale rubato dalle finestre — altrimenti
// il volo si fermerebbe prima della fine, esattamente in proporzione al tempo delle foto/video (bug
// osservato: un volo di 40s con foto/musica sovrapposte si fermava al 76% del percorso).
// slowZone (opzionale) rallenta ulteriormente il tratto di percorso intorno al punto di velocità
// massima — vedi rawFlightTimeToFraction.
export function videoTimeToPathTime(
  videoTime: number,
  photoClips: PhotoClip[],
  totalDurationSec: number,
  videoClips: VideoClip[] = [],
  slowZone: SlowZone | null = null,
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

  return rawFlightTimeToFraction(rawFlightTime, availableFlightTime, slowZone) * totalDurationSec;
}

// Inversa di videoTimeToPathTime: dato un punto del percorso (frazione di distanza 0..1), trova
// l'istante della timeline VIDEO (nominale, 0..totalDurationSec) in cui il volo lo attraversa —
// usata per posizionare il marcatore fisso del punto di velocità massima sul righello della
// timeline (PreviewControls.tsx). Cammina la timeline video in ordine (stessa logica della
// foto/video-walk sopra, ma in avanti verso il target invece che fino a un videoTime dato)
// accumulando tempo di volo solo FUORI dalle finestre di congelamento, fino a raggiungere il tempo
// di volo grezzo target.
export function pathFractionToVideoTime(
  fraction: number,
  photoClips: PhotoClip[],
  totalDurationSec: number,
  videoClips: VideoClip[] = [],
  slowZone: SlowZone | null = null,
): number {
  const sorted = freezeWindowsOf(photoClips, videoClips).sort((a, b) => a.videoStart - b.videoStart);
  const totalFrozenTime = sorted.reduce((sum, w) => sum + w.duration, 0);
  const availableFlightTime = Math.max(0.001, totalDurationSec - totalFrozenTime);
  const target = fractionToRawFlightTime(Math.max(0, Math.min(1, fraction)), availableFlightTime, slowZone);

  let videoTime = 0;
  let flightSoFar = 0;
  for (const w of sorted) {
    const gapLength = Math.max(0, w.videoStart - videoTime);
    if (flightSoFar + gapLength >= target) {
      return videoTime + (target - flightSoFar);
    }
    flightSoFar += gapLength;
    videoTime = Math.max(videoTime, w.videoStart + w.duration); // salta l'intera finestra
  }
  return videoTime + (target - flightSoFar);
}

// Blocco foto/video ancorato a una posizione lungo il percorso (fraction 0..1 di distanza
// cumulata) invece che a un secondo assoluto — vedi resolvePathAnchoredPositions.
//
// overlapOfId/overlapOffsetSec (opzionali) coprono il caso di due blocchi che condividono un
// tratto di finestra: essendo congelato il percorso durante quel tratto, la fraction NON può da
// sola distinguere "sovrapposti di 1s" da "sovrapposti di 2s" (la fraction risultante sarebbe
// identica in entrambi i casi — vedi il commento di resolvePathAnchoredPositions). L'offset è
// RELATIVO al blocco di riferimento (secondi dopo l'inizio della SUA finestra risolta), non alla
// timeline assoluta: resta valido anche se la posizione assoluta del riferimento cambia per
// modifiche altrove nella timeline. pathFraction resta comunque sempre valorizzata anche quando
// overlapOfId è presente (coincide con quella del riferimento al momento della sovrapposizione) —
// è l'ancora di ripiego se il riferimento sparisce, vedi sotto.
export interface PathAnchoredItem {
  id: number;
  pathFraction: number; // 0..1 — sempre valido di per sé, anche quando overlapOfId è presente
  length: number; // durata del congelamento in secondi (photo.duration o video.trimEnd-trimStart)
  overlapOfId?: number; // id di un altro item DI QUESTO STESSO INSIEME a cui questo blocco si sovrappone
  overlapOffsetSec?: number; // secondi dopo l'inizio della finestra risolta di overlapOfId (richiesto se overlapOfId è presente)
}

interface ResolvedRootInput {
  id: number;
  pathFraction: number;
  length: number; // per i blocchi "radice" con figli sovrapposti: la durata dell'INTERO cluster (unione), non solo la propria
}

// Nucleo invariato della Fase 0: cammina i blocchi in ordine di pathFraction crescente,
// posizionando ciascuno subito dopo la fine del precedente (mai prima) — vedi il commento esteso
// di resolvePathAnchoredPositions per il perché non serve iterazione a punto fisso.
function resolveSequential(
  items: ResolvedRootInput[],
  totalDurationSec: number,
  slowZone: SlowZone | null,
): Map<number, number> {
  const totalFrozenTime = items.reduce((sum, it) => sum + it.length, 0);
  const availableFlightTime = Math.max(0.001, totalDurationSec - totalFrozenTime);
  const sorted = [...items].sort((a, b) => a.pathFraction - b.pathFraction);

  const resolved = new Map<number, number>();
  let videoTimeCursor = 0;
  let flightSoFar = 0;
  for (const item of sorted) {
    const target = fractionToRawFlightTime(Math.max(0, Math.min(1, item.pathFraction)), availableFlightTime, slowZone);
    const need = Math.max(0, target - flightSoFar);
    const itemStart = videoTimeCursor + need;
    resolved.set(item.id, itemStart);
    flightSoFar = target;
    videoTimeCursor = itemStart + item.length;
  }
  return resolved;
}

// Risolve la posizione in secondi (videoStart) di un insieme di blocchi ancorati al percorso —
// stesso motore di pathFractionToVideoTime (già usato dal marcatore "Velocità max").
//
// Perché non basta chiamare pathFractionToVideoTime singolarmente per ciascun blocco: la sua
// mappatura fraction→tempo dipende dalle finestre di congelamento di TUTTI i blocchi
// (freezeWindowsOf), che a loro volta sono definite dal videoStart di ciascun blocco — lo stesso
// valore che si sta cercando di calcolare (dipendenza circolare). Si risolve percorrendo i blocchi
// "radice" (senza overlapOfId) in ordine di pathFraction CRESCENTE — l'ordine per fraction
// coincide sempre con l'ordine per tempo-video, quindi le finestre "prima" di un blocco sono
// esattamente quelle già risolte nei passi precedenti (resolveSequential, invariata dalla Fase 0:
// bullet 1 "separati" e 2 "adiacenti" della specifica restano identici a prima).
//
// SOVRAPPOSIZIONE (bullet 3, tempo pausa = durata1+durata2-sovrapposizione): la fraction da sola
// non basta a rappresentarla — durante il congelamento il percorso non avanza per definizione,
// quindi un blocco "sganciato" dentro la finestra di un altro riceverebbe automaticamente la
// STESSA identica fraction (la conversione tempo→percorso è costante durante tutto il
// congelamento), qualunque sia il punto esatto in cui è stato rilasciato: l'informazione "di
// quanti secondi si sovrappone" andrebbe persa. overlapOfId/overlapOffsetSec la preservano
// esplicitamente (offset relativo al blocco di riferimento, non alla timeline assoluta — resta
// valido anche se la posizione assoluta del riferimento cambia altrove). Un blocco con figli
// sovrapposti viene trattato, ai fini della risoluzione della SEQUENZA (ordine/spaziatura rispetto
// agli altri blocchi), come un singolo "cluster" la cui lunghezza è l'unione (il proprio + la coda
// di ciascun figlio che sporge oltre) — mai la somma piena, altrimenti si tornerebbe a "rubare"
// due volte lo stesso tempo di volo disponibile (esattamente il difetto che l'ancoraggio a
// percorso doveva eliminare). Il figlio viene poi piazzato di conseguenza, con un semplice
// riferimento_start + offset.
//
// RIPIEGO se il blocco di riferimento è assente da questo stesso insieme (rimosso dalla timeline,
// oppure — per restare semplici — puntava a sua volta a un altro figlio anziché a una radice:
// nessuna catena a più livelli per ora): il blocco perde solo il legame esplicito "relativo a X",
// non la propria posizione fisica — viene trattato come un blocco radice indipendente, usando la
// PROPRIA pathFraction (che già coincide con quella del riferimento al momento in cui la relazione
// era stata creata, per il motivo spiegato sopra) esattamente come se overlapOfId non fosse mai
// stato impostato.
export function resolvePathAnchoredPositions(
  items: PathAnchoredItem[],
  totalDurationSec: number,
  slowZone: SlowZone | null = null,
): Map<number, number> {
  const byId = new Map(items.map((it) => [it.id, it]));

  // Un overlapOfId è "attivo" solo se punta a un item presente in questo insieme che è a sua
  // volta una radice (non un altro figlio) — altrimenti ripiego: trattato come radice indipendente.
  const isActiveChild = (it: PathAnchoredItem): boolean => {
    if (it.overlapOfId == null || it.overlapOffsetSec == null) return false;
    const target = byId.get(it.overlapOfId);
    return target != null && !(target.overlapOfId != null && target.overlapOffsetSec != null);
  };

  const children = items.filter(isActiveChild);
  const childrenByParent = new Map<number, PathAnchoredItem[]>();
  for (const c of children) {
    const list = childrenByParent.get(c.overlapOfId!) ?? [];
    list.push(c);
    childrenByParent.set(c.overlapOfId!, list);
  }
  const childIds = new Set(children.map((c) => c.id));
  const roots = items.filter((it) => !childIds.has(it.id));

  const rootInputs: ResolvedRootInput[] = roots.map((root) => {
    const kids = childrenByParent.get(root.id) ?? [];
    const clusterSpan = kids.reduce((span, c) => Math.max(span, c.overlapOffsetSec! + c.length), root.length);
    return { id: root.id, pathFraction: root.pathFraction, length: clusterSpan };
  });

  const resolvedRoots = resolveSequential(rootInputs, totalDurationSec, slowZone);

  const resolved = new Map<number, number>(resolvedRoots);
  for (const root of roots) {
    const rootStart = resolvedRoots.get(root.id)!;
    for (const c of childrenByParent.get(root.id) ?? []) {
      resolved.set(c.id, rootStart + c.overlapOffsetSec!);
    }
  }
  return resolved;
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
  slowZone: SlowZone | null = null,
): number {
  const totalDurationSec = totalFrames / fps;
  const pt = videoTimeToPathTime(videoTimeSec, photoClips, totalDurationSec, videoClips, slowZone);
  return Math.max(0, Math.min(totalFrames - 1, Math.round(pt * fps)));
}

// Risolve in un solo passaggio le posizioni (videoStart, secondi) di foto E video insieme —
// combinati nello stesso grafo (id codificati con encodeClipId) così una sovrapposizione
// foto↔video viene contabilizzata correttamente (unione, non doppio conteggio) esattamente come
// una sovrapposizione foto↔foto o video↔video. Questa è l'UNICA funzione che lo store deve
// chiamare per tenere PhotoClip.videoStart/VideoClip.videoStart sincronizzati con
// pathFraction/overlap — vedi resyncPhotoVideoPositions in store/useProjectStore.ts.
export function resolvePhotoVideoClips(
  photoClips: PhotoClip[],
  videoClips: VideoClip[],
  totalDurationSec: number,
  slowZone: SlowZone | null = null,
): { photoClips: PhotoClip[]; videoClips: VideoClip[] } {
  const items: PathAnchoredItem[] = [
    ...photoClips.map((p) => ({
      id: encodeClipId('photo', p.id),
      pathFraction: p.pathFraction,
      length: p.duration,
      overlapOfId: p.overlapOfId != null ? encodeClipId(p.overlapOfKind ?? 'photo', p.overlapOfId) : undefined,
      overlapOffsetSec: p.overlapOffsetSec,
    })),
    ...videoClips.map((c) => ({
      id: encodeClipId('video', c.id),
      pathFraction: c.pathFraction,
      length: c.trimEnd - c.trimStart,
      overlapOfId: c.overlapOfId != null ? encodeClipId(c.overlapOfKind ?? 'video', c.overlapOfId) : undefined,
      overlapOffsetSec: c.overlapOffsetSec,
    })),
  ];
  const resolved = resolvePathAnchoredPositions(items, Math.max(0.001, totalDurationSec), slowZone);
  return {
    photoClips: photoClips.map((p) => ({ ...p, videoStart: resolved.get(encodeClipId('photo', p.id)) ?? 0 })),
    videoClips: videoClips.map((c) => ({ ...c, videoStart: resolved.get(encodeClipId('video', c.id)) ?? 0 })),
  };
}

export interface OverlapCandidate {
  id: number;
  kind: 'photo' | 'video';
  videoStart: number;
  length: number;
}

// Usata dal drag-and-drop (PhotoLane/VideoLane): dato un punto di sgancio in secondi nominali
// (dopo lo snap), verifica se cade STRETTAMENTE dentro la finestra risolta di un altro blocco già
// presente — in tal caso il blocco trascinato va ancorato con overlapOfId/overlapOffsetSec invece
// che con la sola pathFraction (altrimenti la conversione tempo→percorso gli assegnerebbe la
// stessa fraction del blocco coperto ma perderebbe l'esatto punto di sovrapposizione voluto — vedi
// il commento di resolvePathAnchoredPositions). Se il punto cade dentro PIÙ finestre (sovrapposizioni
// annidate), sceglie quella con inizio più antico, semplificazione accettata per questo caso limite.
export function detectOverlapTarget(
  droppedStartSec: number,
  candidates: OverlapCandidate[],
  excludeId: number,
  excludeKind: 'photo' | 'video',
): { id: number; kind: 'photo' | 'video'; offsetSec: number } | null {
  const inside = candidates
    .filter((c) => !(c.id === excludeId && c.kind === excludeKind))
    .filter((c) => droppedStartSec > c.videoStart + 1e-6 && droppedStartSec < c.videoStart + c.length - 1e-6)
    .sort((a, b) => a.videoStart - b.videoStart);
  if (inside.length === 0) return null;
  const target = inside[0];
  return { id: target.id, kind: target.kind, offsetSec: droppedStartSec - target.videoStart };
}

export interface DragAnchorResult {
  pathFraction: number;
  overlapOfId?: number;
  overlapOfKind?: 'photo' | 'video';
  overlapOffsetSec?: number;
}

// Punto unico richiamato dal drag-and-drop (PhotoLane/VideoLane, ultimo passo dell'handler, DOPO
// lo snap in secondi nominali) per calcolare l'ancora risultante — riusato da entrambe le corsie
// per non duplicare la logica di rilevamento sovrapposizione. droppedStartSec è la posizione (in
// secondi nominali, già passata per lo snap) in cui il blocco è stato rilasciato. photoClips/
// videoClips sono quelli ATTUALI (prima di applicare questo spostamento) — usati sia per
// l'individuazione di un'eventuale sovrapposizione (detectOverlapTarget) sia, se non c'è
// sovrapposizione, per la conversione secondi→percorso (videoTimeToPathTime).
export function resolveDragAnchor(
  droppedStartSec: number,
  excludeId: number,
  excludeKind: 'photo' | 'video',
  photoClips: PhotoClip[],
  videoClips: VideoClip[],
  totalDurationSec: number,
  slowZone: SlowZone | null,
): DragAnchorResult {
  // Il blocco trascinato va sempre escluso da SÉ STESSO — sia per il rilevamento sovrapposizione
  // (già gestito da detectOverlapTarget tramite excludeId/excludeKind) sia per la conversione
  // secondi->percorso qui sotto: includerlo tratterebbe la sua stessa finestra (con il videoStart
  // ANTECEDENTE al movimento in corso) come una finestra di congelamento indipendente da "saltare",
  // corrompendo la fraction risultante.
  const otherPhotoClips = photoClips.filter((p) => !(excludeKind === 'photo' && p.id === excludeId));
  const otherVideoClips = videoClips.filter((c) => !(excludeKind === 'video' && c.id === excludeId));

  const candidates: OverlapCandidate[] = [
    ...otherPhotoClips.map((p) => ({ id: p.id, kind: 'photo' as const, videoStart: p.videoStart, length: p.duration })),
    ...otherVideoClips.map((c) => ({ id: c.id, kind: 'video' as const, videoStart: c.videoStart, length: c.trimEnd - c.trimStart })),
  ];
  const overlap = detectOverlapTarget(droppedStartSec, candidates, excludeId, excludeKind);
  if (overlap) {
    const targetFraction =
      overlap.kind === 'photo'
        ? otherPhotoClips.find((p) => p.id === overlap.id)?.pathFraction
        : otherVideoClips.find((c) => c.id === overlap.id)?.pathFraction;
    return {
      pathFraction: targetFraction ?? 0,
      overlapOfId: overlap.id,
      overlapOfKind: overlap.kind,
      overlapOffsetSec: overlap.offsetSec,
    };
  }
  const safeDuration = Math.max(0.001, totalDurationSec);
  const pathFraction = videoTimeToPathTime(droppedStartSec, otherPhotoClips, safeDuration, otherVideoClips, slowZone) / safeDuration;
  return { pathFraction };
}
