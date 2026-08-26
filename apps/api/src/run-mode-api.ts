/**
 * Declares this process an API, before anything else can ask.
 *
 * The same import-order hazard as `run-mode-worker.ts`, with the same fix: assign at module scope
 * and import first. `??=` rather than `=`, so an explicitly configured RUN_MODE still wins.
 */
process.env.RUN_MODE ??= 'api';
