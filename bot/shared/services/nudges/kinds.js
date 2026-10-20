'use strict';
/**
 * The nudge kinds this bot ships, in sweep order — the one list both schedulers
 * (the in-process interval on bot/workers/sqs-worker.js and the one-shot cron
 * entry bot/workers/teacher-nudges.worker.js) register from, so the two can
 * never disagree about what a deployment sends.
 *
 * Adding a kind: write `<name>.kind.js` exporting `{ kind, prepare?, handle }`
 * (see re-engage.kind.js and docs/features/teacher-nudges.md) and add it here.
 */

const KINDS = [
  require('./re-engage.kind'),
];

/** Register every shipped kind with the sweeper. Safe to call twice. */
function registerAllKinds(sweeper) {
  for (const kindModule of KINDS) sweeper.register(kindModule);
  return KINDS.map((k) => k.kind);
}

module.exports = { KINDS, registerAllKinds };
