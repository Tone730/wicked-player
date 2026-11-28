'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  createBackgroundJobRegistry,
  createCancellableJobRegistry,
  createClientJobRegistry,
  createClientPendingRegistry,
  createPrioritySerialQueue,
  createResolverJob,
  describeResolverError,
  isResolverBotChallenge,
  isRetryableResolverError,
  resolverErrorText,
} = require('../lib/stream-resolver');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('the yt-dlp resolver queue never overlaps concurrent jobs', async () => {
  const queue = createPrioritySerialQueue();
  let active = 0;
  let maxActive = 0;
  const order = [];

  const run = (name, ms) => queue.run(async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    order.push(`${name}:start`);
    await delay(ms);
    order.push(`${name}:end`);
    active--;
    return name;
  }, 10);

  const results = await Promise.all([
    run('first', 25),
    run('second', 5),
    run('third', 5),
  ]);

  assert.deepEqual(results, ['first', 'second', 'third']);
  assert.equal(maxActive, 1);
  assert.deepEqual(order, [
    'first:start',
    'first:end',
    'second:start',
    'second:end',
    'third:start',
    'third:end',
  ]);
});

test('a selected foreground resolution overtakes a queued background warm-up', async () => {
  const queue = createPrioritySerialQueue();
  const blockerStarted = deferred();
  const releaseBlocker = deferred();
  const order = [];

  const blocker = queue.run(async () => {
    blockerStarted.resolve();
    await releaseBlocker.promise;
  }, 10);
  await blockerStarted.promise;

  const background = queue.run(async () => {
    order.push('background');
  }, 0);
  const foreground = queue.run(async () => {
    order.push('foreground');
  }, 10);

  releaseBlocker.resolve();
  await Promise.all([blocker, background, foreground]);
  assert.deepEqual(order, ['foreground', 'background']);
});

test('the newest foreground resolution overtakes older queued foreground resolutions', async () => {
  const queue = createPrioritySerialQueue();
  const blockerStarted = deferred();
  const releaseBlocker = deferred();
  const order = [];

  const blocker = queue.run(async () => {
    blockerStarted.resolve();
    await releaseBlocker.promise;
  }, 10);
  await blockerStarted.promise;

  const older = queue.run(async () => {
    order.push('older');
  }, 10, { latestFirst: true });
  const newest = queue.run(async () => {
    order.push('newest');
  }, 10, { latestFirst: true });

  releaseBlocker.resolve();
  await Promise.all([blocker, older, newest]);
  assert.deepEqual(order, ['newest', 'older']);
});

test('a queued background warm-up can be cancelled before it starts', async () => {
  const queue = createPrioritySerialQueue();
  const registry = createBackgroundJobRegistry();
  const blockerStarted = deferred();
  const releaseBlocker = deferred();
  let backgroundStarted = false;

  const blocker = queue.run(async () => {
    blockerStarted.resolve();
    await releaseBlocker.promise;
  }, 10);
  await blockerStarted.promise;

  const controller = new AbortController();
  const job = {
    cancelled: false,
    controller,
    cancel() { this.cancelled = true; },
  };
  registry.add(job);

  const background = queue.run(async () => {
    backgroundStarted = true;
  }, 0, { signal: controller.signal });
  await delay(0);

  assert.equal(registry.cancelAll(), 1);
  await assert.rejects(background, (error) => error.code === 'RESOLVER_JOB_CANCELLED');
  releaseBlocker.resolve();
  await blocker;
  assert.equal(job.cancelled, true);
  assert.equal(backgroundStarted, false);
});

test('a newer foreground selection can cancel an active resolver child', async () => {
  const registry = createCancellableJobRegistry();
  const controller = new AbortController();
  let killed = false;
  const job = {
    cancelled: false,
    controller,
    cancel() {
      killed = true;
    },
  };
  registry.add(job);

  assert.equal(registry.cancelAll(), 1);
  assert.equal(job.cancelled, true);
  assert.equal(controller.signal.aborted, true);
  assert.equal(killed, true);
});

test('foreground preemption is scoped to one browser session', () => {
  const clients = createClientJobRegistry();
  const first = clients.get('session-a');
  const second = clients.get('session-b');
  const firstJob = { cancelled: false, controller: new AbortController(), cancel() {} };
  const secondJob = { cancelled: false, controller: new AbortController(), cancel() {} };
  first.add(firstJob);
  second.add(secondJob);

  first.cancelAll();
  assert.equal(firstJob.cancelled, true);
  assert.equal(secondJob.cancelled, false);

  first.remove(firstJob);
  clients.release('session-a', first);
  assert.equal(clients.size, 1);
  second.remove(secondJob);
  clients.release('session-b', second);
  assert.equal(clients.size, 0);
});

test('cancelling a stale resolver removes only its own pending entry', () => {
  const pending = createClientPendingRegistry();
  const stalePromise = Promise.resolve('stale');
  const newerPromise = Promise.resolve('newer');
  pending.set('track', 'session-a', stalePromise);

  const staleJob = createResolverJob({
    key: 'track',
    pendingMap: pending,
    pendingScope: 'session-a',
  });
  staleJob.pendingPromise = stalePromise;
  staleJob.cancel();
  assert.equal(pending.get('track', 'session-a'), undefined);

  pending.set('track', 'session-a', newerPromise);
  const olderJob = createResolverJob({
    key: 'track',
    pendingMap: pending,
    pendingScope: 'session-a',
  });
  olderJob.pendingPromise = stalePromise;
  olderJob.cancel();
  assert.equal(pending.get('track', 'session-a'), newerPromise);
});

test('cancelling one browser session does not cancel another session pending request', () => {
  const pending = createClientPendingRegistry();
  const firstPromise = Promise.resolve('first');
  const secondPromise = Promise.resolve('second');
  pending.set('track', 'session-a', firstPromise);
  pending.set('track', 'session-b', secondPromise);

  const firstJob = createResolverJob({
    key: 'track',
    pendingMap: pending,
    pendingScope: 'session-a',
  });
  firstJob.pendingPromise = firstPromise;
  firstJob.cancel();

  assert.equal(pending.get('track', 'session-a'), undefined);
  assert.equal(pending.get('track', 'session-b'), secondPromise);
  assert.equal(pending.has('track'), true);
  assert.equal(pending.size, 1);
});

test('background warm-ups are cancelled only after cache and dedupe checks', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const start = server.indexOf('function getStream(query, options = {})');
  const pendingCheck = server.indexOf('if (pending)', start);
  const cancellation = server.indexOf('cancelBackgroundYtDlpJobs();', pendingCheck);

  assert.ok(start >= 0);
  assert.ok(pendingCheck > start);
  assert.ok(cancellation > pendingCheck);
});

test('preview upgrades join the pending foreground resolution instead of polling previews', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const start = server.indexOf('function getStream(query, options = {})');
  const end = server.indexOf('const warmQueue = []', start);
  const pendingBlock = server.slice(start, end);

  assert.match(pendingBlock, /preview && !options\.upgrade/);
  assert.match(pendingBlock, /pendingMap\.get\(key, pendingScope\)/);
  assert.match(pendingBlock, /pendingMap\.set\(key, pendingScope, p\)/);
});

test('cancelled shared resolutions return a retryable response instead of empty JSON', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const routeStart = server.indexOf("app.get('/stream'");
  const routeEnd = server.indexOf("app.get('/resolve'", routeStart);
  const route = server.slice(routeStart, routeEnd);

  assert.match(route, /if \(data\.cancelled\)/);
  assert.match(route, /res\.status\(409\)/);
  assert.match(route, /Retry-After/);
});

test('yt-dlp command text cannot masquerade as a bot challenge', () => {
  const error = {
    name: 'ChildProcessError',
    message: [
      'The command spawned as:',
      '',
      '  `yt-dlp ytsearch5:Robot Rock Both Sides Now`',
      '',
      'exited with:',
      '',
      "  `{ signal: 'null', code: 1 }`",
    ].join('\n'),
    stderr: 'ERROR: generic extraction failure',
  };

  assert.equal(isResolverBotChallenge(error), false);
  assert.equal(isRetryableResolverError(error), false);
  assert.doesNotMatch(resolverErrorText(error), /Robot Rock/);
});

test('a real bot challenge is still detected from yt-dlp stderr', () => {
  const error = {
    name: 'ChildProcessError',
    message: 'The command spawned as:\n\n  `yt-dlp ytsearch5:track`',
    stderr: 'ERROR: Sign in to confirm you are not a bot',
  };

  assert.equal(isResolverBotChallenge(error), true);
  assert.equal(isRetryableResolverError(error), true);
  assert.match(describeResolverError(error, 6500), /bot challenge detected/i);
});

test('queue waits time out without starting the resolver job', async () => {
  const queue = createPrioritySerialQueue();
  const blockerStarted = deferred();
  const releaseBlocker = deferred();
  let queuedStarted = false;

  const blocker = queue.run(async () => {
    blockerStarted.resolve();
    await releaseBlocker.promise;
  }, 10);
  await blockerStarted.promise;

  const queued = queue.run(async () => {
    queuedStarted = true;
  }, 10, { waitTimeoutMs: 10 });
  await assert.rejects(queued, (error) => error.code === 'RESOLVER_QUEUE_TIMEOUT');
  assert.equal(isRetryableResolverError({ code: 'RESOLVER_QUEUE_TIMEOUT' }), true);

  releaseBlocker.resolve();
  await blocker;
  assert.equal(queuedStarted, false);
});

test('the resolver queue rejects work beyond its pending-job limit', async () => {
  const queue = createPrioritySerialQueue({ maxPending: 1 });
  const blockerStarted = deferred();
  const releaseBlocker = deferred();

  const blocker = queue.run(async () => {
    blockerStarted.resolve();
    await releaseBlocker.promise;
  }, 10);
  await blockerStarted.promise;

  const accepted = queue.run(async () => 'accepted', 10);
  const rejected = queue.run(async () => 'rejected', 10);
  await assert.rejects(rejected, (error) => error.code === 'RESOLVER_QUEUE_OVERFLOW');

  releaseBlocker.resolve();
  assert.equal(await blocker, undefined);
  assert.equal(await accepted, 'accepted');
});

test('a failed resolver job does not stall the queue', async () => {
  const queue = createPrioritySerialQueue();
  const failed = queue.run(async () => {
    throw new Error('resolver failed');
  }, 10);
  await assert.rejects(failed, /resolver failed/);
  assert.equal(await queue.run(async () => 'recovered', 10), 'recovered');
});

test('killed yt-dlp jobs are identified as timeouts and remain retryable', () => {
  const error = {
    name: 'ChildProcessError',
    message: '',
    stderr: '',
    killed: true,
    signalCode: 'SIGKILL',
    exitCode: null,
  };

  assert.equal(isRetryableResolverError(error), true);
  assert.match(describeResolverError(error, 6500), /timed out after 6500ms/i);
});

test('timeout descriptions preserve a bot challenge for fallback rotation', () => {
  const error = {
    name: 'ChildProcessError',
    message: 'Child process exited',
    stderr: 'ERROR: Sign in to confirm you are not a bot',
    killed: true,
    signalCode: 'SIGKILL',
    exitCode: null,
  };

  const description = describeResolverError(error, 6500);
  assert.match(description, /timed out after 6500ms/i);
  assert.match(description, /bot challenge detected/i);
});
