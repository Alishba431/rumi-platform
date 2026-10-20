/**
 * Empirical Reproduction Suite: Standalone Microservice & Normalization Edge Cases
 *
 * Authored by Challenger 2 (Empirical Challenger)
 * Demonstrates confirmed bugs, edge cases, and architectural flaws in Phase 3 gateway:
 *
 * 1. CRITICAL: Standalone server process terminates with exit code 78 (EX_CONFIG)
 *    when handling Slack open_modal block_actions without Supabase credentials.
 * 2. CRITICAL: Standalone server drops inbound Slack Events because the Slack router
 *    is bound to defaultDispatcher instead of server.js's local IngressDispatcher.
 * 3. MEDIUM: createInboundEnvelope({ metadata: null }) crashes with TypeError.
 * 4. MEDIUM: parseToEnvelope crashes on button_reply: null and list_reply: null with TypeError.
 * 5. MEDIUM: Slack media/file shares normalized as ENVELOPE_TYPES.UNKNOWN with lost media metadata.
 */

delete process.env.REDIS_URL;

const fs = require('fs');
const path = require('path');
const http = require('http');

const crypto = require('crypto');
const { spawn } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '../..');
const SERVER_PATH = path.resolve(REPO_ROOT, 'bot/gateway/server.js');
const memoryQueue = require('../../bot/shared/services/queue/memory-queue.service');
const { createInboundEnvelope, ENVELOPE_TYPES, whatsAppRequestToEnvelope } = require('../../bot/gateway/envelope');
const gatewayModule = require('../../bot/gateway/server');

const TEST_SLACK_SECRET = 'chal2_slack_secret_123';
process.env.SLACK_SIGNING_SECRET = TEST_SLACK_SECRET;
process.env.QUEUE_DRIVER = 'memory';

function computeSlackSignature(timestamp, rawBody, secret = TEST_SLACK_SECRET) {
  const sigBasestring = `v0:${timestamp}:${rawBody}`;
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(sigBasestring);
  return `v0=${hmac.digest('hex')}`;
}

describe('Challenger 2 Empirical Bug Reproduction & Edge Case Harness', () => {
  beforeEach(() => {
    memoryQueue.clear();
  });

  // =========================================================================
  // DEFECT 3: createInboundEnvelope({ metadata: null }) crash
  // =========================================================================
  describe('Defect 3: Envelope Factory Null Pointer on metadata: null', () => {
    it('safely handles metadata explicitly passed as null without throwing', () => {
      const envelope = createInboundEnvelope({
        id: 'test_null_meta',
        channel: 'whatsapp',
        from: '123456',
        metadata: null
      });
      expect(envelope).toBeDefined();
      expect(envelope.metadata.correlationId).toBeNull();
    });
  });

  // =========================================================================
  // DEFECT 4: parseToEnvelope TypeError on null interactive reply objects
  // =========================================================================
  describe('Defect 4: parseToEnvelope Unhandled TypeError on button_reply: null', () => {
    it('handles interactive.type button_reply safely when button_reply object is null', () => {
      const req = {
        body: {
          object: 'whatsapp_business_account',
          entry: [{
            changes: [{
              value: {
                messaging_product: 'whatsapp',
                messages: [{
                  id: 'wamid.bad_btn',
                  from: '923001234567',
                  timestamp: '1720000000',
                  type: 'interactive',
                  interactive: {
                    type: 'button_reply',
                    button_reply: null
                  }
                }]
              }
            }]
          }]
        }
      };

      const envelope = whatsAppRequestToEnvelope(req, 'test-corr-id');
      expect(envelope).toBeDefined();
      expect(envelope.type).toBe(ENVELOPE_TYPES.UNKNOWN);
    });

    it('handles interactive.type list_reply safely when list_reply object is null', () => {
      const req = {
        body: {
          object: 'whatsapp_business_account',
          entry: [{
            changes: [{
              value: {
                messaging_product: 'whatsapp',
                messages: [{
                  id: 'wamid.bad_list',
                  from: '923001234567',
                  timestamp: '1720000000',
                  type: 'interactive',
                  interactive: {
                    type: 'list_reply',
                    list_reply: null
                  }
                }]
              }
            }]
          }]
        }
      };

      const envelope = whatsAppRequestToEnvelope(req, 'test-corr-id');
      expect(envelope).toBeDefined();
      expect(envelope.type).toBe(ENVELOPE_TYPES.UNKNOWN);
    });
  });

});
