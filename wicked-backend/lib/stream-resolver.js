'use strict';

/* yt-dlp becomes unreliable when several searches/extractions run at once:
   parallel child processes consistently hit the resolver's short deadline.
   Keep the expensive work serial while allowing a selected track to overtake
   queued background warm-ups. Queue waits are bounded so a burst cannot grow
   an unbounded backlog. */
class ResolverQueueTimeoutError extends Error {
  constructor(waitTimeoutMs) {
    super(`Resolver queue timed out after ${waitTimeoutMs}ms`);
    this.name = 'ResolverQueueTimeoutError';
    this.code = 'RESOLVER_QUEUE_TIMEOUT';
    this.waitTimeoutMs = waitTimeoutMs;
  }
}

class ResolverQueueOverflowError extends Error {
  constructor(maxPending) {
    super(`Resolver queue is full (${maxPending} pending jobs)`);
    this.name = 'ResolverQueueOverflowError';
    this.code = 'RESOLVER_QUEUE_OVERFLOW';
    this.maxPending = maxPending;
  }
}

function resolverAbortError() {
  const error = new Error('Resolver job was cancelled');
  error.name = 'AbortError';
  error.code = 'RESOLVER_JOB_CANCELLED';
  return error;
}

function createPrioritySerialQueue(options = {}) {
  const defaultMaxPending = Math.max(1, Number(options.maxPending) || 100);
  const pending = [];
  let running = false;

  function insert(entry) {
    if (entry.priority > 0) {
      const index = pending.findIndex((item) => (
        item.priority < entry.priority
        || (entry.latestFirst && item.priority === entry.priority)
      ));
      if (index >= 0) {
        pending.splice(index, 0, entry);
        return;
      }
    }
    pending.push(entry);
  }

  function removePending(entry) {
    const index = pending.indexOf(entry);
    if (index >= 0) pending.splice(index, 1);
  }

  function cleanupWait(entry) {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (entry.signal && entry.abortListener) {
      entry.signal.removeEventListener('abort', entry.abortListener);
      entry.abortListener = null;
    }
  }

  function settleResolve(entry, value) {
    if (entry.settled) return;
    entry.settled = true;
    cleanupWait(entry);
    entry.resolve(value);
  }

  function settleReject(entry, error) {
    if (entry.settled) return;
    entry.settled = true;
    cleanupWait(entry);
    entry.reject(error);
  }

  async function drain() {
    if (running) return;
    running = true;
    try {
      while (pending.length) {
        const entry = pending.shift();
        if (entry.settled) continue;
        entry.started = true;
        cleanupWait(entry);
        if (entry.signal && entry.signal.aborted) {
          settleReject(entry, resolverAbortError());
          continue;
        }
        try {
          const value = await entry.task();
          settleResolve(entry, value);
        } catch (error) {
          settleReject(entry, error);
        }
      }
    } finally {
      running = false;
      if (pending.length) drain();
    }
  }

  function run(task, priority = 0, runOptions = {}) {
    if (typeof task !== 'function') return Promise.reject(new TypeError('task must be a function'));
    const waitTimeoutMs = Math.max(0, Number(runOptions.waitTimeoutMs) || 0);
    const maxPending = Math.max(1, Number(runOptions.maxPending) || defaultMaxPending);
    const signal = runOptions.signal || null;

    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        reject(resolverAbortError());
        return;
      }
      if (pending.length >= maxPending) {
        reject(new ResolverQueueOverflowError(maxPending));
        return;
      }

      const entry = {
        task,
        priority: Number(priority) || 0,
        latestFirst: runOptions.latestFirst === true,
        resolve,
        reject,
        settled: false,
        started: false,
        timer: null,
        signal,
        abortListener: null,
      };

      if (waitTimeoutMs > 0) {
        entry.timer = setTimeout(() => {
          if (entry.started || entry.settled) return;
          removePending(entry);
          settleReject(entry, new ResolverQueueTimeoutError(waitTimeoutMs));
        }, waitTimeoutMs);
        if (entry.timer.unref) entry.timer.unref();
      }

      if (signal) {
        entry.abortListener = () => {
          if (entry.started || entry.settled) return;
          removePending(entry);
          settleReject(entry, resolverAbortError());
        };
        signal.addEventListener('abort', entry.abortListener, { once: true });
      }

      insert(entry);
      drain();
    });
  }

  return {
    run,
    get pending() { return pending.length; },
    get running() { return running; },
  };
}

/* Cancellable jobs are registered before they enter the queue so a newer
   selection can cancel both an active child and a queued task. */
function createCancellableJobRegistry() {
  const jobs = new Set();
  return {
    add(job) { jobs.add(job); },
    remove(job) { jobs.delete(job); },
    cancelAll() {
      let cancelled = 0;
      for (const job of jobs) {
        job.cancelled = true;
        cancelled++;
        try { if (job.controller) job.controller.abort(); } catch {}
        try { if (typeof job.cancel === 'function') job.cancel(); } catch {}
      }
      return cancelled;
    },
    get size() { return jobs.size; },
  };
}

/* Backwards-compatible name used by the background warm-up registry. */
function createBackgroundJobRegistry() {
  return createCancellableJobRegistry();
}

/* Foreground preemption is scoped to one browser session. Other users keep
   their own active selections, and empty session registries are discarded so
   long-lived servers do not accumulate session identifiers. */
function createClientJobRegistry() {
  const clients = new Map();
  const normalizeKey = (key) => String(key || 'guest');
  return {
    get(key) {
      const normalized = normalizeKey(key);
      let registry = clients.get(normalized);
      if (!registry) {
        registry = createCancellableJobRegistry();
        clients.set(normalized, registry);
      }
      return registry;
    },
    release(key, registry) {
      const normalized = normalizeKey(key);
      if (registry && registry.size === 0 && clients.get(normalized) === registry) {
        clients.delete(normalized);
      }
    },
    get size() { return clients.size; },
  };
}

/* Pending foreground resolutions are also scoped by browser session. A shared
   global promise would let one user's newer selection cancel another user's
   request for the same track. Full-stream caching remains global. */
function createClientPendingRegistry() {
  const entries = new Map();
  const normalizeScope = (scope) => String(scope || 'guest');
  return {
    get(key, scope) {
      const scopes = entries.get(key);
      return scopes ? scopes.get(normalizeScope(scope)) : undefined;
    },
    has(key, scope) {
      if (scope !== undefined) return this.get(key, scope) !== undefined;
      return entries.has(key);
    },
    set(key, scope, value) {
      const normalized = normalizeScope(scope);
      let scopes = entries.get(key);
      if (!scopes) {
        scopes = new Map();
        entries.set(key, scopes);
      }
      scopes.set(normalized, value);
      return value;
    },
    delete(key, scope, expected) {
      const scopes = entries.get(key);
      if (!scopes) return false;
      const normalized = normalizeScope(scope);
      const current = scopes.get(normalized);
      if (expected !== undefined && current !== expected) return false;
      scopes.delete(normalized);
      if (!scopes.size) entries.delete(key);
      return true;
    },
    get size() {
      let count = 0;
      for (const scopes of entries.values()) count += scopes.size;
      return count;
    },
    get keyCount() { return entries.size; },
  };
}

/* Build the cancellable unit used by both foreground selections and
   background warm-ups. The pending-map cleanup is deliberately exact: a
   cancelled stale job may remove only its own promise, never a newer job for
   the same track or another browser session's request. */
function createResolverJob(options = {}) {
  const pendingMap = options.pendingMap || null;
  const job = {
    background: Boolean(options.background),
    cancelled: false,
    child: null,
    controller: new AbortController(),
    key: options.key || '',
    pendingMap,
    pendingScope: String(options.pendingScope || 'guest'),
    pendingPromise: null,
    cancel() {
      try {
        if (this.child && !this.child.killed) this.child.kill('SIGKILL');
      } catch {}
      try {
        if (this.pendingMap && this.pendingPromise) {
          this.pendingMap.delete(this.key, this.pendingScope, this.pendingPromise);
        }
      } catch {}
    },
  };
  return job;
}

function resolverStderrText(error) {
  if (!error || error.stderr == null) return '';
  return String(error.stderr);
}

function stripResolverCommand(message) {
  return String(message || '')
    .replace(/The command spawned as:\s*[\s\S]*?(?=exited with:)/i, ' ')
    /* Also remove any remaining backtick-delimited command text. Track names
       are arguments inside those commands and must never be interpreted as
       resolver diagnostics. */
    .replace(/`[^`]*`/g, '`[command]`')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolverErrorText(error) {
  return [
    resolverStderrText(error),
    stripResolverCommand(error && error.message),
    error && error.name,
    error && error.code,
  ].filter(Boolean).join('\n');
}

function isResolverBotChallenge(error) {
  const stderr = resolverStderrText(error);
  const message = stripResolverCommand(error && error.message);
  return /sign in to confirm|confirm you(?:'re| are) not a bot|bot challenge/i
    .test(`${stderr}\n${message}`);
}

function isResolverTimeout(error) {
  if (!error) return false;
  if (error.code === 'RESOLVER_QUEUE_TIMEOUT') return false;
  if (error.killed && ['SIGKILL', 'SIGTERM'].includes(String(error.signalCode || ''))) return true;
  return /timed?\s*out|timeout/i.test(resolverErrorText(error));
}

function isRetryableResolverError(error) {
  if (!error) return false;
  if (error.code === 'RESOLVER_QUEUE_TIMEOUT' || error.code === 'RESOLVER_QUEUE_OVERFLOW') return true;
  if (isResolverTimeout(error)) return true;
  if (isResolverBotChallenge(error)) return true;
  return /403|429|temporarily unavailable|requested format is not available|unable to extract|connection reset|http error 5\d\d/i
    .test(resolverErrorText(error));
}

function describeResolverError(error, timeoutMs) {
  if (error && error.code === 'RESOLVER_QUEUE_TIMEOUT') {
    return `Resolver queue timed out after ${Number(error.waitTimeoutMs) || 0}ms`;
  }
  if (error && error.code === 'RESOLVER_QUEUE_OVERFLOW') {
    return `Resolver queue is full (${Number(error.maxPending) || 0} pending jobs)`;
  }
  const text = resolverErrorText(error).trim().replace(/\s+/g, ' ');
  const botChallenge = isResolverBotChallenge(error) ? '; bot challenge detected' : '';
  if (isResolverTimeout(error)) {
    const timeout = Number(timeoutMs) > 0 ? ` after ${Number(timeoutMs)}ms` : '';
    return `yt-dlp timed out${timeout}${botChallenge}`;
  }
  return `${text || 'Unknown yt-dlp error'}${botChallenge}`.slice(0, 240);
}

module.exports = {
  ResolverQueueOverflowError,
  ResolverQueueTimeoutError,
  createBackgroundJobRegistry,
  createCancellableJobRegistry,
  createClientJobRegistry,
  createClientPendingRegistry,
  createPrioritySerialQueue,
  createResolverJob,
  describeResolverError,
  isResolverBotChallenge,
  isResolverTimeout,
  isRetryableResolverError,
  resolverErrorText,
  resolverStderrText,
  stripResolverCommand,
};
