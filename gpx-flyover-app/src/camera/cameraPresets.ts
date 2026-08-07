import type { CameraParams } from '../types/domain';

export interface CameraPreset {
  name: string;
  // Partial: i preset toccano solo pitch/zoom/orbitAmp/orbitPeriod, mai bearingMode/fixedBearing*
  // (vedi commento sotto).
  params: Partial<CameraParams>;
}

// Combinazioni pronte di pitch/zoom/ampiezza-periodo di rotazione, per partire da un'inquadratura
// sensata senza dover tarare i quattro parametri a mano. I valori restano scelte di gusto, non
// derivati da alcun calcolo — pensati per coprire stili diversi (dall'alto, ravvicinato, ampio).
// pitch qui è nella semantica "utente" (0°=orizzonte, 90°=verticale dall'alto, vedi CameraParams).
// I preset non toccano bearingMode/fixedBearing*: selezionarli non altera l'eventuale angolo
// fisso già impostato dall'utente.
export const CAMERA_PRESETS: CameraPreset[] = [
  { name: 'Cinematico (default)', params: { pitch: 24, zoom: 12.5, orbitAmp: 25, orbitPeriod: 14 } },
  { name: 'Dall’alto', params: { pitch: 50, zoom: 13.5, orbitAmp: 10, orbitPeriod: 22 } },
  { name: 'Inseguimento ravvicinato', params: { pitch: 18, zoom: 15.5, orbitAmp: 12, orbitPeriod: 9 } },
  { name: 'Panoramica ampia', params: { pitch: 35, zoom: 10.5, orbitAmp: 40, orbitPeriod: 18 } },
  { name: 'Statico (nessuna rotazione)', params: { pitch: 30, zoom: 13, orbitAmp: 0, orbitPeriod: 14 } },
];
