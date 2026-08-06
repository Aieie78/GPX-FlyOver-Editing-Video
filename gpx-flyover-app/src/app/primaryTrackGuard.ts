import { create } from 'zustand';
import { getPrimaryTrack, useProjectStore } from '../store/useProjectStore';
import type { SegmentMode } from '../types/domain';

// Fase 3 (ancoraggio foto/video al percorso): cambiare la traccia principale, o il segmentMode
// (che ha lo stesso effetto sul percorso ricampionato — buildAnimParams usa sempre e solo la
// traccia principale), invalida l'ancoraggio di ogni foto/video esistente: la loro pathFraction
// si riferirebbe silenziosamente a un percorso diverso da quello che l'ha generata. Invece di
// "spostare" i blocchi a un punto scorrelato, li rimuoviamo esplicitamente — ma solo dopo
// conferma dell'utente, mai in automatico.
//
// Questo modulo intercetta le tre azioni che possono cambiare il percorso attivo (radio
// "principale", cestino "Rimuovi traccia" quando rimuove la principale, select "Segmenti
// multipli") e, se ci sono blocchi ancorati, sospende l'azione mostrando un dialogo — vedi
// ConfirmPrimaryChangeDialog.tsx.

export type PendingPrimaryChange =
  | { kind: 'setPrimary'; trackId: number; trackName: string }
  | { kind: 'removeTrack'; trackId: number; trackName: string }
  | { kind: 'setSegmentMode'; mode: SegmentMode };

interface PendingChangeStore {
  pending: PendingPrimaryChange | null;
  blockedCount: number;
  set: (pending: PendingPrimaryChange | null, blockedCount: number) => void;
}

export const usePendingPrimaryChangeStore = create<PendingChangeStore>((set) => ({
  pending: null,
  blockedCount: 0,
  set: (pending, blockedCount) => set({ pending, blockedCount }),
}));

function anchoredBlockCount(): number {
  const s = useProjectStore.getState();
  return s.photoClips.length + s.videoClips.length;
}

export function requestSetPrimaryTrack(trackId: number, trackName: string): void {
  const count = anchoredBlockCount();
  if (count === 0) {
    useProjectStore.getState().setPrimaryTrack(trackId);
    return;
  }
  usePendingPrimaryChangeStore.getState().set({ kind: 'setPrimary', trackId, trackName }, count);
}

export function requestRemoveTrack(trackId: number, trackName: string): void {
  const s = useProjectStore.getState();
  const wasPrimary = s.tracks.find((t) => t.id === trackId)?.isPrimary ?? false;
  const count = anchoredBlockCount();
  // Rimuovere una traccia NON principale non tocca il percorso attivo — nessun avviso necessario.
  if (!wasPrimary || count === 0) {
    s.removeTrack(trackId);
    return;
  }
  usePendingPrimaryChangeStore.getState().set({ kind: 'removeTrack', trackId, trackName }, count);
}

export function requestSetSegmentMode(mode: SegmentMode): void {
  const count = anchoredBlockCount();
  if (count === 0) {
    useProjectStore.getState().setSegmentMode(mode);
    return;
  }
  usePendingPrimaryChangeStore.getState().set({ kind: 'setSegmentMode', mode }, count);
}

export function cancelPendingChange(): void {
  usePendingPrimaryChangeStore.getState().set(null, 0);
}

// Applica il cambio confermato e rimuove i blocchi ancorati, poi AZZERA l'intera cronologia
// undo/redo (zundo temporal.clear()).
//
// Perché non basta "escludere" la sola rimozione dalla cronologia (pause/resume attorno a queste
// due chiamate, senza toccare pastStates): VERIFICATO IN BROWSER che non è sufficiente — zundo
// non "salta" i passi mettizzati in pausa, la sua undo() ripristina semplicemente l'ULTIMO
// checkpoint tracciato per intero (l'intero stato, non un diff). Se quel checkpoint precedente è
// stato preso PRIMA della rimozione (quando i blocchi esistevano ancora — inevitabile, dato che la
// rimozione stessa non crea un nuovo checkpoint), un Ctrl+Z successivo — anche per un'azione
// completamente scorrelata, non necessariamente il primo Ctrl+Z dopo la conferma — riporta
// comunque quel vecchio checkpoint "con i blocchi", ripristinandoli mentre la traccia principale
// resta quella nuova: esattamente l'inconsistenza silenziosa che dovevamo eliminare, riemersa per
// una via diversa da quella prevista. L'unico modo per garantire davvero che non possa MAI
// riemergere è non lasciare alcun checkpoint precedente a cui tornare — da qui clear() invece di
// pause()/resume() (entrambe le varianti erano state esplicitamente autorizzate in alternativa).
// Costo accettato: si perde anche la cronologia undo di modifiche precedenti scorrelate (es.
// parametri camera) — non selettivo, perché zundo non supporta un clear parziale per singolo campo.
export function confirmPendingChange(): void {
  const pending = usePendingPrimaryChangeStore.getState().pending;
  if (!pending) return;
  const store = useProjectStore.getState();
  if (pending.kind === 'setPrimary') store.setPrimaryTrack(pending.trackId);
  else if (pending.kind === 'removeTrack') store.removeTrack(pending.trackId);
  else store.setSegmentMode(pending.mode);
  useProjectStore.getState().clearPathAnchoredBlocks();
  useProjectStore.temporal.getState().clear();
  usePendingPrimaryChangeStore.getState().set(null, 0);
}

export function pendingChangeMessage(pending: PendingPrimaryChange, blockedCount: number): string {
  const noun = blockedCount === 1 ? 'blocco foto/video già posizionato' : 'blocchi foto/video già posizionati';
  const action =
    pending.kind === 'setPrimary'
      ? `impostare "${pending.trackName}" come traccia principale`
      : pending.kind === 'removeTrack'
        ? `rimuovere la traccia principale "${pending.trackName}"`
        : 'cambiare la modalità segmenti multipli';
  return `${action[0].toUpperCase()}${action.slice(1)} rimuoverà ${blockedCount} ${noun}, perché ancorati al percorso della traccia attuale. Continuare?`;
}

// Traccia principale "effettiva" per etichettare il messaggio quando trackName non è noto in
// anticipo (es. rimozione via cestino, dove il chiamante ha già il nome della riga cliccata).
export function getPrimaryTrackName(): string {
  const primary = getPrimaryTrack(useProjectStore.getState());
  return primary?.fileName ?? '';
}
