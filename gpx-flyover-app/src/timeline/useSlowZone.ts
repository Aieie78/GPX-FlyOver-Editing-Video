import { getEffectiveMaxSpeedPoint } from '../geo/geo';
import { getPrimaryTrack, useProjectStore } from '../store/useProjectStore';
import { computeSlowZone, type SlowZone } from './timelineMath';

// Zona di rallentamento EFFETTIVA (traccia principale, al netto delle esclusioni) — stessa logica
// già duplicata in PreviewControls.tsx e nello store (useProjectStore.ts, slowZoneOf), estratta
// qui come hook condiviso per il drag-and-drop di foto/video (PhotoLane/VideoLane), che deve
// convertire posizioni in secondi nominali <-> pathFraction con la STESSA zona di rallentamento
// usata dallo store per il resync, altrimenti la posizione visualizzata durante il trascinamento
// potrebbe divergere leggermente da quella effettiva dopo il rilascio.
export function useSlowZone(): SlowZone | null {
  const primaryTrack = useProjectStore((s) => getPrimaryTrack(s));
  const maxSpeedMarker = useProjectStore((s) => s.maxSpeedMarker);
  if (!primaryTrack) return null;
  const maxSpeedPoint = getEffectiveMaxSpeedPoint(primaryTrack.track, primaryTrack.maxSpeedExclusions);
  return computeSlowZone(maxSpeedPoint, primaryTrack.track.totalDist, maxSpeedMarker);
}
