require('express-async-errors');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const env = require('./config/env');
const routes = require('./routes');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

const app = express();

app.set('trust proxy', env.trustProxy);
app.use(helmet());
app.use(cors({ origin: env.clientOrigins, credentials: true }));
app.use(morgan(env.nodeEnv === 'production' ? 'combined' : 'dev'));
app.use(express.json({
  limit: '2mb',
  verify: (req, _res, buf) => {
    // Capture raw body for webhook signature verification handlers (Stripe/Flutterwave)
    req.rawBody = buf;
  },
}));
app.use(express.urlencoded({ extended: true }));

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
    // Default handler sends a plain-text body — every other error response
    // in this API is { success: false, error: { message } } (see
    // errorHandler.js), and apiErrorMessage() on the frontend expects that
    // shape. Without this, a 429 still degrades safely (falls back to a
    // generic axios message) but loses the actual "try again later" text.
    handler: (req, res) => {
      res.status(429).json({ success: false, error: { message: 'Too many requests — please try again in a few minutes.' } });
    },
  })
);

app.get('/health', (req, res) => res.json({ status: 'ok', env: env.nodeEnv }));

app.use('/api/v1', routes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
