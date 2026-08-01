const http = require('http');
const { Server } = require('socket.io');

const env = require('./config/env');
const { connectDB } = require('./config/db');
const app = require('./app');

async function main() {
  await connectDB();

  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: env.clientOrigins } });

  io.on('connection', (socket) => {
    socket.on('conversation:join', (conversationId) => {
      socket.join(`conversation:${conversationId}`);
    });
    socket.on('conversation:leave', (conversationId) => {
      socket.leave(`conversation:${conversationId}`);
    });
  });

  app.set('io', io);

  server.listen(env.port, () => {
    console.log(`[server] Mboa Trust API listening on port ${env.port} (${env.nodeEnv})`);
  });
}

main().catch((err) => {
  console.error('[server] failed to start:', err);
  process.exit(1);
});
