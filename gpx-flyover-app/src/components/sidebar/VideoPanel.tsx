import { useProjectStore } from '../../store/useProjectStore';
import { outputDimsFor } from '../../export/videoExport';
import type { VideoAspectRatio, VideoResolution } from '../../types/domain';

// Etichette risoluzione per il selettore: mostrano le dimensioni EFFETTIVE di output per il
// formato attualmente scelto (es. "1080×1920" per 9:16 con qualità "1080p") — per 9:16 non è un
// sottoinsieme più piccolo della risoluzione 16:9 corrispondente, ma un canvas verticale dedicato
// della stessa qualità (vedi outputDimsFor/computeAspectCrop in videoExport.ts).
function resolutionLabel(resolution: VideoResolution, aspectRatio: VideoAspectRatio): string {
  const [baseW, baseH] = resolution.split('x').map(Number);
  const { outW, outH } = outputDimsFor(baseW, baseH, aspectRatio);
  const tier = baseH === 720 ? '720p (più leggero)' : baseH === 1440 ? '1440p (più pesante)' : '1080p (consigliato)';
  return `${tier} — ${outW}×${outH}`;
}

// Port dei controlli video di gpx-flyover.html:97-123.
export function VideoPanel() {
  const video = useProjectStore((s) => s.video);
  const updateVideo = useProjectStore((s) => s.updateVideo);

  return (
    <>
      <div className="row">
        <div>
          <label>Risoluzione video</label>
          <select
            value={video.resolution}
            onChange={(e) => updateVideo({ resolution: e.target.value as VideoResolution })}
          >
            <option value="1280x720">{resolutionLabel('1280x720', video.aspectRatio)}</option>
            <option value="1920x1080">{resolutionLabel('1920x1080', video.aspectRatio)}</option>
            <option value="2560x1440">{resolutionLabel('2560x1440', video.aspectRatio)}</option>
          </select>
        </div>
        <div>
          <label>Bitrate (Mbps)</label>
          <input
            type="number"
            min={1}
            max={30}
            step={0.5}
            value={video.bitrateMbps}
            onChange={(e) => updateVideo({ bitrateMbps: parseFloat(e.target.value) || 8 })}
          />
        </div>
      </div>

      <label>Durata video (sec)</label>
      <input
        type="number"
        min={5}
        max={600}
        value={video.durationSec}
        onChange={(e) => updateVideo({ durationSec: parseFloat(e.target.value) || 30 })}
      />

      <div className="row">
        <div>
          <label>FPS</label>
          <input
            type="number"
            min={15}
            max={60}
            value={video.fps}
            onChange={(e) => updateVideo({ fps: parseInt(e.target.value, 10) || 30 })}
          />
        </div>
        <div>
          <label>Formato</label>
          <select value={video.aspectRatio} onChange={(e) => updateVideo({ aspectRatio: e.target.value as VideoAspectRatio })}>
            <option value="16:9">16:9 (standard)</option>
            <option value="9:16">9:16 (storie/reel)</option>
            <option value="1:1">1:1 (quadrato)</option>
          </select>
        </div>
      </div>
      {video.aspectRatio !== '16:9' && (
        <p className="field-hint">
          Titolo, statistiche e profilo altimetrico usano un layout impilato dedicato a questo formato. La mappa
          resta ritagliata al centro (si perde parte del contesto ai lati) — la camera zooma leggermente di più per
          compensare.
        </p>
      )}
      <label>
        <input
          type="checkbox"
          checked={video.showAltitudeProfile}
          onChange={(e) => updateVideo({ showAltitudeProfile: e.target.checked })}
        />
        Mostra profilo altimetrico (anteprima e video, in alto a destra)
      </label>
    </>
  );
}
