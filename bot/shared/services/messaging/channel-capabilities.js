/**
 * channel-capabilities — what a channel can draw, asked by identifier.
 *
 * A native WhatsApp Flow (a multi-screen form) renders only on the Meta Cloud
 * API. Slack and Discord draw some Flows as modals through their own
 * registries (slack-flow-registry.js, discord-flow-registry.js). Baileys and
 * Matrix have only the text equivalent: numbered menus and one question per
 * message (text-flow.js).
 *
 * Handlers used to decide "open the Flow" only by checking that a *_FLOW_ID
 * env var is set. A deployment running Meta AND Matrix sets those ids for its
 * Meta teachers, so its Matrix teachers got a sendFlow() that returned false
 * and nothing else. Gates read the id through nativeFlowIdFor() instead: off
 * a native-Flow channel it comes back empty, and the gate takes the same path
 * a deployment with no Flow id configured takes.
 *
 * Data plus two pure functions, like channel-registry.js, so it can be
 * required from any handler without a cycle.
 */

const { driverForIdentifier } = require('./channel-registry');
const { resolveChannelDriver } = require('../../config/feature-availability');

const MODAL_CHANNELS = ['slack', 'discord'];

/**
 * How a Flow reaches the person behind `to`:
 *   'native' — a real WhatsApp Flow (Meta driver);
 *   'modal'  — the channel's own modal workaround, for the Flows it registers;
 *   'text'   — only the text equivalent (Baileys, Matrix).
 */
function flowSurfaceFor(to, env = process.env) {
  const additive = driverForIdentifier(to);
  if (additive) return MODAL_CHANNELS.includes(additive) ? 'modal' : 'text';
  return resolveChannelDriver(env) === 'meta' ? 'native' : 'text';
}

/** The Flow id to open for `to`, or '' when that channel can't draw a native Flow. */
function nativeFlowIdFor(to, flowId, env = process.env) {
  return flowSurfaceFor(to, env) === 'native' ? (flowId || '') : '';
}

module.exports = { flowSurfaceFor, nativeFlowIdFor };
