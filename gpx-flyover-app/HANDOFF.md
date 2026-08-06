# HANDOFF — ancoraggio foto/video al percorso GPX (Fasi 1-5)

## STATO FINALE: Fasi 1-5 COMPLETE e verificate in browser (incluso un giro completo di export). Commit eseguito.

### Verifica aggiuntiva completata (dopo il primo riepilogo)
- Video: drag (con sovrapposizione genuina foto↔video via offset relativo), split, duplica, snap,
  righe multiple per blocchi sovrapposti — tutti confermati funzionanti in browser.
- Musica: due brani sovrapposti (drag), impilamento su righe multiple — confermato (codice non
  toccato, comportamento invariato).
- Testo: due sovrapposizioni testuali sullo stesso istante — confermato (codice non toccato).
- Ducking: scenario video-con-audio + musica sovrapposti riprodotto senza errori console; il
  valore di gain non è stato misurato direttamente (nessun accesso al nodo audio dalla pagina),
  ma il codice che lo calcola è invariato e riceve dati corretti (già verificato).
- Velocità x0.5/x1.5/x2: confermate (messaggio "durata effettiva video" corretto per ciascuna).
- Riaggancio automatico per nome file: verificato end-to-end — salvato un progetto con 2 tracce
  GPX, 2 brani (uno muto), 1 video; ricaricato a vuoto; ricaricati gli stessi file per nome →
  traccia principale, posizione/mute musica, posizione/trim video tutti riapplicati correttamente.
- Multi-GPX con riproduzione simultanea: confermato visivamente (icona traccia secondaria visibile
  e in movimento indipendente sulla mappa durante la riproduzione, insieme alla principale).
- **Registrazione completa** (non solo avvio): foto (0-3s) e video (1-7s) ancorati al percorso e
  sovrapposti (overlap 1-3s) esportati con successo (WebM, VP9+Opus, 10.02s). Verificato tramite
  estrazione fotogrammi (ffmpeg) a 4 istanti chiave: t=0.5s → rosso (solo foto), t=2s → blu (video
  vince nella sovrapposizione, coerente con l'anteprima), t=5s → blu (video da solo dopo la fine
  della foto), t=8s → mappa satellitare (volo ripreso dopo la fine del video). Tutti i colori
  corrispondono esattamente al comportamento atteso e già osservato in anteprima.
- Nessun errore in console in nessuno di questi scenari (solo l'artefatto generico dell'estensione
  Chrome, invariato per tutta la sessione).

Bug reale trovato e corretto in Fase 5 (browser): il meccanismo pause/resume di zundo per
escludere la rimozione-per-cambio-principale dalla cronologia undo NON bastava — un Ctrl+Z
successivo (anche per un'azione scorrelata) poteva comunque "saltare indietro" a un checkpoint
precedente in cui i blocchi esistevano ancora, ripristinandoli con la traccia principale già
cambiata. Corretto sostituendo pause/resume con `temporal.clear()` subito dopo la conferma
(azzera l'intera cronologia undo/redo — unico modo per garantire che non possa mai riemergere,
dato che zundo non supporta un clear selettivo per singolo campo). Vedi `primaryTrackGuard.ts`.

Checkpoint di avanzamento — contesto completo nella conversazione originale, qui solo i fatti.

### Cosa è stato deciso (riassunto)
- Opzione (b): PhotoClip/VideoClip ancorati a `pathFraction` (0..1, posizione lungo il percorso)
  invece che a `videoStart` (secondi assoluti). Testo e musica restano a tempo assoluto, invariati.
- Sovrapposizione parziale tra blocchi: `overlapOfId`/`overlapOfKind`/`overlapOffsetSec` (offset
  RELATIVO al blocco di riferimento) — necessario perché la fraction da sola non distingue quanto
  due blocchi si sovrappongono (durante il congelamento il percorso non avanza).
- Cambio traccia principale / rimozione traccia principale / cambio segmentMode con blocchi
  ancorati presenti: richiede conferma esplicita (dialogo), poi rimuove i blocchi ancorati — MAI
  spostati a un punto scorrelato. La rimozione (e il cambio traccia stesso) sono ESCLUSI dalla
  cronologia undo (zundo pause/resume) per evitare l'inconsistenza "Ctrl+Z riporta i blocchi ma la
  principale è già cambiata".
- Aggiungere foto/video senza una traccia principale caricata: bloccato con messaggio.
- **Deviazione dal piano concordato** (motivata, non richiede riconferma): le foto NON usano il
  pattern di riaggancio differito che era stato pre-approvato — si è scoperto che la conversione
  legacy videoStart→pathFraction (e la risoluzione pathFraction→videoStart) non dipende affatto
  dalla geometria della traccia GPX (solo da durationSec + configurazione di congelamento salvata
  nello stesso file), quindi le foto restano ripristinate SUBITO al caricamento progetto, come
  sempre — evita una regressione UX non necessaria. Video restano differiti (motivo diverso: il
  file video non è incorporabile nel salvataggio, non per ragioni di GPX).

### File toccati
- `src/types/domain.ts` — PhotoClip/VideoClip: `pathFraction` + `overlapOfId?/overlapOfKind?/overlapOffsetSec?` aggiunti, `videoStart` resta ma è DERIVATO (mai scritto direttamente fuori dallo store/resolver).
- `src/timeline/timelineMath.ts` — `resolvePathAnchoredPositions` (motore radici+figli sovrapposti), `resolvePhotoVideoClips` (combina foto+video con id codificati via `encodeClipId`, unica funzione che lo store chiama per il resync), `detectOverlapTarget`, `resolveDragAnchor` (usata dal drag-and-drop).
- `src/timeline/useSlowZone.ts` — nuovo hook condiviso (estratto da PreviewControls.tsx).
- `src/store/useProjectStore.ts` — `resyncPhotoVideoPositions`/`slowZoneOf` (helper interni), richiamati da OGNI azione che tocca foto/video/durationSec/maxSpeedMarker/esclusioni/loadProjectData. Nuova azione `clearPathAnchoredBlocks`.
- `src/photos/photoEngine.ts`, `src/video/videoEngine.ts` — builder foto/video ora calcolano pathFraction (slowZone=null per l'euristica di posizionamento default, approssimazione accettata).
- `src/components/timeline/PhotoLane.tsx`, `VideoLane.tsx` — drag-and-drop usa `resolveDragAnchor` invece di scrivere videoStart direttamente; guardia "nessuna traccia principale" sull'aggiunta.
- `src/components/sidebar/MusicPhotosPanel.tsx` — stessa guardia; riaggancio video ora spread `...expected` (include pathFraction/overlap).
- `src/app/primaryTrackGuard.ts` (nuovo) — intercetta setPrimaryTrack/removeTrack/setSegmentMode, mostra dialogo se ci sono blocchi ancorati.
- `src/components/sidebar/ConfirmPrimaryChangeDialog.tsx` + `.css` (nuovi) — il dialogo.
- `src/components/sidebar/GpxSourcePanel.tsx` — usa le funzioni guardate invece delle azioni dirette dello store.
- `src/project/projectFile.ts` — versione file 3, `SerializedPhotoClipV3` (pathFraction+overlap), migrazione v1/v2→v3 (`migrateLegacyPhotoFractions`, non richiede GPX caricato).
- `src/components/preview/PreviewControls.tsx` + `previewControls.css` — (lavoro di una richiesta precedente, indipendente) fasce colorate foto/video/testo sulla barra di scrub principale.

### NON toccato (per design, confermato zero-touch dopo verifica)
`PreviewEngine.ts`, `camera.ts`, `videoEngine.ts` (funzioni di sync/ducking), `musicMix.ts`,
`export/deterministicExport.ts`, `export/videoExport.ts` (tranne le funzioni di scaling-per-velocità,
già a posto), `TimelineInspector.tsx`, `MusicLane.tsx`, `TextLane.tsx`, `MapCanvas.tsx` — tutti
consumano `photoClips`/`videoClips` dallo store, che li tiene SEMPRE risolti (videoStart aggiornato).

### Verifica fatta finora
- `npx tsc --noEmit -p tsconfig.app.json` pulito (⚠️ usare SEMPRE questo comando, MAI `tsc --noEmit -p .` da solo — il tsconfig.json root ha `files:[]` e references, senza `-b` non controlla nulla, dà falsi negativi silenziosi — scoperta fatta a metà di questa sessione).
- Test numerici puri (Node, fuori dall'app) su `timelineMath.ts`: 26 controlli su resolver base, sovrapposizione con offset, ripiego riferimento rotto/catena, integrazione foto+video con id codificati, drag-anchor end-to-end — tutti OK. Script in scratchpad (non nel repo): `phase0/verify.mjs`, `phase2/verify2.mjs`.
- **NON ancora verificato**: comportamento reale nel browser (nessuna delle due checklist di regressione è stata eseguita). Questo è il lavoro rimanente.

### Prossimo passo
Fase 5: avviare il dev server (`npm run dev` in questa cartella), usare gli strumenti Chrome per
percorrere la checklist di regressione (quella dell'utente + le mie aggiunte, elencate nella
conversazione) con particolare attenzione alle parti NUOVE (ancoraggio, dialogo cambio traccia,
blocco senza GPX, sovrapposizione con offset). Poi riepilogo finale consolidato come richiesto
dall'utente, prima di qualunque commit.
