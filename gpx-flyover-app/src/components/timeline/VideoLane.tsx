import { useRef } from 'react';
import type { ChangeEvent, DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent } from 'react';
import { Film, Plus, X } from 'lucide-react';
import { getSessionEngine } from '../../app/flyoverSession';
import { fmtMinSec } from '../../audio/musicEngine';
import { buildVideoClipAtPlayhead } from '../../video/videoEngine';
import { assignLaneRows, snapValue } from '../../timeline/timelineMath';
import { useTimelineRowScroll } from '../../timeline/useTimelineRowScroll';
import { useProjectStore } from '../../store/useProjectStore';
import { usePlaybackStore } from '../../store/usePlaybackStore';
import { useTimelineSelectionStore } from '../../store/useTimelineSelectionStore';
import type { VideoClip } from '../../types/domain';
import '../layout/transportGrid.css';

type DragMode = 'move' | 'left' | 'right';

// Corsia delle clip video importate (Fase 6, prompt-video-import.md) — mirror di MusicLane.tsx
// (drag/trim/snap, sovrapposizioni gestite come le altre corsie), con blocco a miniatura
// (posterDataUrl) invece di forma d'onda, come PhotoLane.
export function VideoLane() {
  const laneRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoClips = useProjectStore((s) => s.videoClips);
  const addVideoClip = useProjectStore((s) => s.addVideoClip);
  const updateVideoClip = useProjectStore((s) => s.updateVideoClip);
  const removeVideoClip = useProjectStore((s) => s.removeVideoClip);
  const totalDur = useProjectStore((s) => s.video.durationSec);
  const snapEnabled = useProjectStore((s) => s.snapEnabled);
  const currentTimeSec = usePlaybackStore((s) => s.currentTimeSec);
  const setStatusMessage = usePlaybackStore((s) => s.setStatusMessage);
  const selection = useTimelineSelectionStore((s) => s.selection);
  const selectClip = useTimelineSelectionStore((s) => s.select);
  const { scrollRef, onScroll, onWheel, zoom } = useTimelineRowScroll();

  const startDrag = (e: ReactMouseEvent, clip: VideoClip, mode: DragMode) => {
    e.preventDefault();
    const laneEl = laneRef.current;
    if (!laneEl) return;
    const laneRect = laneEl.getBoundingClientRect();
    const startX = e.clientX;
    const orig = { videoStart: clip.videoStart, trimStart: clip.trimStart, trimEnd: clip.trimEnd };
    const snapThreshold = snapEnabled ? (8 / laneRect.width) * totalDur : 0; // ~8px di tolleranza
    const snapCandidates = [0, totalDur, usePlaybackStore.getState().currentTimeSec];
    videoClips.forEach((other) => {
      if (other.id === clip.id) return;
      snapCandidates.push(other.videoStart, other.videoStart + (other.trimEnd - other.trimStart));
    });

    const onMove = (ev: MouseEvent) => {
      const dxSec = ((ev.clientX - startX) / laneRect.width) * totalDur;
      if (mode === 'move') {
        const length = orig.trimEnd - orig.trimStart;
        let newStart = Math.max(0, Math.min(totalDur - length, orig.videoStart + dxSec));
        newStart = snapValue(newStart, [...snapCandidates, ...snapCandidates.map((c) => c - length)], snapThreshold);
        updateVideoClip(clip.id, { videoStart: Math.max(0, Math.min(totalDur - length, newStart)) });
      } else if (mode === 'left') {
        // ancora il punto finale (videoStart+length e trimEnd), sposta l'inizio
        const endAnchorVideo = orig.videoStart + (orig.trimEnd - orig.trimStart);
        const newVideoStartRaw = snapValue(orig.videoStart + dxSec, snapCandidates, snapThreshold);
        const newTrimStart = Math.max(
          0,
          Math.min(orig.trimEnd - 0.3, orig.trimStart + (newVideoStartRaw - orig.videoStart)),
        );
        const newLength = orig.trimEnd - newTrimStart;
        let newVideoStart = endAnchorVideo - newLength;
        if (newVideoStart < 0) newVideoStart = 0;
        updateVideoClip(clip.id, { trimStart: newTrimStart, videoStart: newVideoStart });
      } else {
        // ancora inizio (videoStart, trimStart), estende/riduce la fine
        const rawEndVideo = snapValue(
          orig.videoStart + (orig.trimEnd - orig.trimStart) + dxSec,
          snapCandidates,
          snapThreshold,
        );
        let newTrimEnd = Math.max(
          orig.trimStart + 0.3,
          Math.min(clip.videoEl.duration, orig.trimStart + (rawEndVideo - orig.videoStart)),
        );
        const newLength = newTrimEnd - orig.trimStart;
        if (orig.videoStart + newLength > totalDur) newTrimEnd = orig.trimStart + (totalDur - orig.videoStart);
        updateVideoClip(clip.id, { trimEnd: newTrimEnd });
      }
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const handleBlockMouseDown = (e: ReactMouseEvent, clip: VideoClip) => {
    selectClip({ type: 'video', id: clip.id });
    const target = e.target as HTMLElement;
    if (target.closest('.lane-block__resize') || target.closest('.lane-block__remove')) return;
    startDrag(e, clip, 'move');
  };

  // Click su una corsia (fuori dai blocchi) sposta la riproduzione in quel punto e deseleziona.
  const handleLaneClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('.lane-block')) return;
    useTimelineSelectionStore.getState().clear();
    const engine = getSessionEngine();
    const totalFrames = usePlaybackStore.getState().totalFrames;
    if (!engine || totalFrames <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    engine.seekTo(Math.round(frac * (totalFrames - 1)));
  };

  const handleAddClick = () => fileInputRef.current?.click();

  const addFileAt = async (file: File, atSec: number) => {
    try {
      const clip = await buildVideoClipAtPlayhead(file, totalDur, atSec);
      addVideoClip(clip);
      // Se l'anteprima è aperta e ferma, nulla ridisegna da solo il frame corrente al variare
      // delle clip (lo store non è osservato per questo, a differenza di camera/video params in
      // liveParamsSync.ts): senza questa chiamata la clip appena aggiunta resta invisibile finché
      // non si preme play o non si effettua un nuovo seek.
      getSessionEngine()?.rerenderCurrentFrame();
    } catch (err) {
      console.error('Errore caricamento video', file.name, err);
      setStatusMessage(`Impossibile leggere il file video "${file.name}" — formato non supportato?`);
    }
  };

  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    await addFileAt(file, usePlaybackStore.getState().currentTimeSec);
  };

  // Drag-and-drop di un file video direttamente sulla corsia: posizionato nel punto esatto del
  // rilascio invece che al playhead.
  const handleDragOver = (e: ReactDragEvent<HTMLDivElement>) => e.preventDefault();
  const handleDrop = async (e: ReactDragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    await addFileAt(file, frac * totalDur);
  };

  const playheadPct = totalDur > 0 ? Math.max(0, Math.min(100, (currentTimeSec / totalDur) * 100)) : 0;

  // Clip sovrapposte/adiacenti nel tempo finiscono su righe separate all'interno della stessa
  // corsia, invece di impilarsi una sopra l'altra — la corsia cresce in altezza di conseguenza.
  const rowOf = assignLaneRows(
    videoClips.map((c) => ({ id: c.id, start: c.videoStart, length: c.trimEnd - c.trimStart })),
  );
  const rowCount = Math.max(1, ...Array.from(rowOf.values(), (r) => r + 1));

  return (
    <div className="transport-row">
      <div className="transport-row__prefix lane-row__label">
        <Film size={13} /> Video
        <button type="button" className="lane-add" title="Aggiungi video al punto attuale della riproduzione" onClick={handleAddClick}>
          <Plus size={13} />
        </button>
        <input ref={fileInputRef} type="file" accept="video/*" style={{ display: 'none' }} onChange={handleFileChange} />
      </div>
      <div className="transport-row__track-scroll" ref={scrollRef} onScroll={onScroll} onWheel={onWheel}>
        <div
          className="transport-row__track lane"
          ref={laneRef}
          onClick={handleLaneClick}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          style={{ height: `${rowCount * 40}px`, width: `${zoom * 100}%` }}
        >
          {videoClips.map((c) => {
            const length = c.trimEnd - c.trimStart;
            const leftPct = (c.videoStart / totalDur) * 100;
            const widthPct = Math.max(1, Math.min(100 - leftPct, (length / totalDur) * 100));
            const row = rowOf.get(c.id) ?? 0;
            const isSelected = selection?.type === 'video' && selection.id === c.id;
            return (
              <div
                key={c.id}
                className={`lane-block lane-block--video${isSelected ? ' lane-block--selected' : ''}${c.muted ? ' lane-block--muted' : ''}`}
                style={{ left: `${leftPct}%`, width: `${widthPct}%`, top: `${row * 40 + 3}px` }}
                title={`${c.name}: ${fmtMinSec(c.videoStart)} → ${fmtMinSec(c.videoStart + length)}`}
                onMouseDown={(e) => handleBlockMouseDown(e, c)}
              >
                <img className="lane-block__thumb" src={c.posterDataUrl} alt="" />
                <div className="lane-block__label">{c.name}</div>
                <div className="lane-block__remove" onClick={() => removeVideoClip(c.id)}>
                  <X size={10} />
                </div>
                <div className="lane-block__resize lane-block__resize--left" onMouseDown={(e) => startDrag(e, c, 'left')} />
                <div className="lane-block__resize lane-block__resize--right" onMouseDown={(e) => startDrag(e, c, 'right')} />
              </div>
            );
          })}
          <div className="lane-playhead" style={{ left: `${playheadPct}%` }} />
        </div>
      </div>
    </div>
  );
}
