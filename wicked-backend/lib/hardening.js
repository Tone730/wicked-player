'use strict';

const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const pino = require('pino');
const pinoHttp = require('pino-http');

function applyHardening(app) {
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

  app.use(pinoHttp({
    logger,
    genReqId: (req) => String(req.headers['x-request-id'] || crypto.randomUUID()),
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
  }));

  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  }));

  /* The player polls a handful of read-only endpoints in the background.
     Those must never consume the budget needed by account/playlist *writes* —
     otherwise everything silently starts returning 429 after a few minutes.
     Exempt only safe GET reads; all writes stay rate limited. */
  const READ_ONLY_POLLS = new Set([
    '/api/profiles', '/api/online-users', '/api/stream-cache/stats',
    '/api/config/discord-invite', '/api/status', '/genre-art',
  ]);

  app.use(rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: Number(process.env.RATE_LIMIT || 5000),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: (req) => req.method === 'GET' && READ_ONLY_POLLS.has(req.path),
    message: { error: 'Too many requests' },
  }));
}

module.exports = { applyHardening };
