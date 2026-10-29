// Goal: preview startup skips Windows-reserved ports without hiding other socket failures.
// Method: replay bind errors at the actual socket boundary, verify sequential bounded
// retries and error propagation; real busy-socket coverage lives in mainBoundaries.test.ts.
import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';
import { findFreePort } from '#dist/electron/lib/nodeTools.js';
import { MAIN_LIMITS } from '#dist/electron/lib/mainLimits.js';

test('reserved and occupied ports are skipped before a successful bind', async (context) => {
  const errors = ['EACCES', 'EADDRINUSE'];
  let attempt = 0;
  const listen = context.mock.method(net.Server.prototype, 'listen', function (this: net.Server) {
    const code = errors[attempt++];
    queueMicrotask(() => {
      if (code) {
        this.emit('error', Object.assign(new Error('Port unavailable'), { code }));
      } else {
        this.emit('listening');
      }
    });
    return this;
  });
  assert.equal(await findFreePort(49821), 49823);
  assert.deepEqual(
    listen.mock.calls.map((call) => {
      const port: unknown = call.arguments[0];
      return port;
    }),
    [49821, 49822, 49823],
  );
});

test('reserved ranges remain bounded and unexpected socket failures propagate', async (context) => {
  let code = 'EACCES';
  const listen = context.mock.method(net.Server.prototype, 'listen', function (this: net.Server) {
    queueMicrotask(() => this.emit('error', Object.assign(new Error('Bind failed'), { code })));
    return this;
  });
  await assert.rejects(findFreePort(49821), /No available preview port within the search limit/);
  assert.equal(listen.mock.callCount(), MAIN_LIMITS.portAttemptsMax);
  code = 'EMFILE';
  await assert.rejects(findFreePort(49821), { code: 'EMFILE' });
  assert.equal(listen.mock.callCount(), MAIN_LIMITS.portAttemptsMax + 1);
});
