const http = require('http');
const { Server } = require('socket.io');

const env = require('./config/env');
const { connectDB } = require('./config/db');
const app = require('./app');
const { resolveUser } = require('./middleware/auth');
const { Conversation } = require('./models');
const { bootstrapInitialAdmin } = require('./services/bootstrapAdminService');

async function main() {
  // DEV_AUTH_BYPASS trusts a client-supplied x-dev-user-id header with zero
  // proof of identity (see middleware/auth.js) — a deliberate convenience
  // for local development before Firebase is wired up, never safe to run
  // with real user data. `.env.example` defaults it to `true`, so this is
  // the only thing standing between "someone forgot to flip it off" and a
  // full identity-spoofing hole in production.
  if (env.nodeEnv === 'production' && env.devAuthBypass) {
    throw new Error('DEV_AUTH_BYPASS must not be true when NODE_ENV=production — it lets any request impersonate any user.');
  }

  await connectDB();
  await bootstrapInitialAdmin();

  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: env.clientOrigins } });

  // Mirrors the HTTP `authenticate` middleware's identity resolution — the
  // client sends the same Firebase ID token (or dev-bypass user id) it
  // already attaches to REST requests, via the handshake `auth` payload
  // (see api/socket.ts). A socket that can't be resolved to a real user is
  // dropped immediately; nothing past this point ever runs unauthenticated.
  io.use(async (socket, next) => {
    const { token, devUserId } = socket.handshake.auth || {};
    const user = await resolveUser({ authHeader: token ? `Bearer ${token}` : undefined, devUserId });
    if (!user || !user.isActive) return next(new Error('unauthorized'));
    socket.data.userId = String(user._id);
    next();
  });

  // Presence Tracking
  const onlineUsers = new Map(); // userId -> connectionCount

  io.on('connection', (socket) => {
    const userId = socket.data.userId;
    const currentCount = onlineUsers.get(userId) || 0;
    onlineUsers.set(userId, currentCount + 1);
    
    if (currentCount === 0) {
      // User came online
      io.emit('presence:online', { userId });
    }

    socket.on('conversation:join', async (conversationId) => {
      const conversation = await Conversation.findById(conversationId).select('participantIds').catch(() => null);
      if (!conversation) return;
      const isParticipant = conversation.participantIds.some((id) => String(id) === socket.data.userId);
      if (!isParticipant) return;
      socket.join(`conversation:${conversationId}`);
    });
    
    socket.on('conversation:leave', (conversationId) => {
      socket.leave(`conversation:${conversationId}`);
    });

    socket.on('typing:start', ({ conversationId, fullName }) => {
      socket.to(`conversation:${conversationId}`).emit('typing:start', { userId: socket.data.userId, fullName });
    });

    socket.on('typing:stop', ({ conversationId, fullName }) => {
      socket.to(`conversation:${conversationId}`).emit('typing:stop', { userId: socket.data.userId, fullName });
    });

    socket.on('disconnect', () => {
      const count = onlineUsers.get(userId) || 0;
      if (count <= 1) {
        onlineUsers.delete(userId);
        io.emit('presence:offline', { userId });
      } else {
        onlineUsers.set(userId, count - 1);
      }
    });
  });

  app.set('io', io);
  app.set('onlineUsers', onlineUsers);

  server.listen(env.port, () => {
    console.log(`[server] Mboa Trust API listening on port ${env.port} (${env.nodeEnv})`);
  });
}

main().catch((err) => {
  console.error('[server] failed to start:', err);
  process.exit(1);
});
