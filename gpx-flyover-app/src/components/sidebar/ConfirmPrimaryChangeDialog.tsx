import { cancelPendingChange, confirmPendingChange, pendingChangeMessage, usePendingPrimaryChangeStore } from '../../app/primaryTrackGuard';
import './confirmPrimaryChangeDialog.css';

// Dialogo di conferma per Fase 3 (ancoraggio foto/video al percorso) — vedi primaryTrackGuard.ts
// per il motivo: cambiare traccia principale/segmentMode con foto/video già posizionati richiede
// conferma esplicita, perché la loro pathFraction si riferirebbe a un percorso non più attivo.
export function ConfirmPrimaryChangeDialog() {
  const pending = usePendingPrimaryChangeStore((s) => s.pending);
  const blockedCount = usePendingPrimaryChangeStore((s) => s.blockedCount);
  if (!pending) return null;

  return (
    <div className="confirm-dialog__backdrop" onMouseDown={cancelPendingChange}>
      <div className="confirm-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <p className="confirm-dialog__message">{pendingChangeMessage(pending, blockedCount)}</p>
        <div className="confirm-dialog__actions">
          <button type="button" className="confirm-dialog__btn" onClick={cancelPendingChange}>
            Annulla
          </button>
          <button type="button" className="confirm-dialog__btn confirm-dialog__btn--danger" onClick={confirmPendingChange}>
            Continua
          </button>
        </div>
      </div>
    </div>
  );
}
