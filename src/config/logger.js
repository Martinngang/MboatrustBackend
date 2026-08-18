const pino = require('pino');
const env = require('./env');

// Separate from morgan (app.js) on purpose — morgan logs HTTP access lines
// (method/path/status/duration), this is for application/error-level
// events: what actually happened and why, structured enough to query later.
// Pretty-printed in dev for readability, plain JSON in production (no
// transport dependency needed at deploy time).
const logger = pino({
  level: process.env.LOG_LEVEL || (env.nodeEnv === 'production' ? 'info' : 'debug'),
  transport:
    env.nodeEnv === 'production'
      ? undefined
      : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
});

module.exports = logger;
