/**
 * Declares this process a worker, before anything else can ask.
 *
 * Eight modules decide what to register from `process.env.RUN_MODE` **at import time** — whether to
 * consume queues, whether to run schedulers, whether to start channel adapters. An entrypoint that
 * assigns the variable in its own body assigns it too late: `import` statements are hoisted above
 * every statement in the file, so the module graph has already been evaluated by the time the
 * assignment runs. A worker started that way registers no queue consumer, reports itself healthy,
 * and lets the queue back up behind it.
 *
 * This module does the assignment at module scope and is imported for that side effect alone, as
 * the FIRST import of `worker.ts` — imports execute in source order, so it wins.
 *
 * In a container the variable comes from the environment and this changes nothing. It exists for
 * every other way the process is started: `nest start`, a debugger, a script.
 */
process.env.RUN_MODE = 'worker';
