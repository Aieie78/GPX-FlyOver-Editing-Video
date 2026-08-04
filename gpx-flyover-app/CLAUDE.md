# Nota per Claude

Questo è il **tool con editing/import video** (Fase 6, nato come copia del tool "normale").

Esiste un secondo strumento, **"normale"** (senza editing/import video), mantenuto **separatamente e intenzionalmente** — i due NON vanno mai consolidati in uno solo:

- Tool con editing video (questo progetto): `C:\Users\robya\Documents\GPX-Flyover\GPX-FlyOver-Editing\gpx-flyover-app`
- Tool normale: `C:\Users\robya\Documents\GPX-Flyover\gpx-flyover-app`

Questo progetto è nato come copia del tool normale per sviluppare l'import video senza toccarlo, e da allora i due proseguono in parallelo.

**Regola**: prima di implementare una nuova funzionalità, se non è esplicitamente chiaro se debba applicarsi solo a questo tool, solo all'altro, o a entrambi, chiedilo all'utente prima di scrivere codice — per evitare che i due progetti tornino a divergere senza che ce ne si accorga.

**Ordine di implementazione**: per le funzionalità che si applicano a entrambi i tool, implementarle prima QUI (tool con editing video), poi portarle sul tool normale — mai il contrario. Così l'integrazione più complessa (con le clip video) si risolve per prima, e il porting verso il tool normale resta la direzione facile.
