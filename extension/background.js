// Service worker (module). All wiring lives in lib/service-worker.js;
// startServiceWorker registers every listener synchronously, here at the top
// level, as MV3 requires.

import { startServiceWorker } from './lib/service-worker.js';

startServiceWorker(chrome);
