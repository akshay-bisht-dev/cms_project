import { Server } from 'socket.io';
import { loadEffectivePermissions } from '../modules/rbac/rbac.service.js';

const REVALIDATE_INTERVAL_MS = 60_000;

const memberRoom = (organizationId, userId) => `member:${organizationId}:${userId}`;
// Members who can see others' attendance get presence hints; they refetch within their own scope.
const presenceRoom = (organizationId) => `presence:${organizationId}`;

function parseCookies(header = '') {
  return Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim().split('='))
      .filter(([k, v]) => k && v !== undefined)
      .map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]),
  );
}

/**
 * Real-time hub (ADR D11). Created before the HTTP server so services can depend on it; attach()
 * starts Socket.IO. Clients never choose rooms: the server joins each socket to its member room
 * after authenticating the session cookie, and re-validates sessions periodically so revoked
 * sessions and deactivated members are disconnected. Events are thin hints; clients refetch
 * through REST, so authorization stays in one place.
 */
export function createRealtimeHub({ env, prisma, sessionService, logger }) {
  let io = null;
  let timer = null;
  const allowedOrigin = new URL(env.APP_ORIGIN).origin;

  async function authenticate(handshake) {
    const origin = handshake.headers.origin;
    if (origin && origin !== allowedOrigin) return { error: 'origin not allowed' };
    const token = parseCookies(handshake.headers.cookie)[sessionService.names.session];
    if (!token) return { error: 'unauthenticated' };
    const { session } = await sessionService.resolve(token);
    if (!session || (session.mfaRequired && !session.mfaVerifiedAt) || !session.activeOrganizationId) return { error: 'unauthenticated' };
    const member = await prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: session.activeOrganizationId, userId: session.userId } },
    });
    if (member?.status !== 'ACTIVE') return { error: 'unauthenticated' };
    const permissions = await loadEffectivePermissions(prisma, session.activeOrganizationId, session.userId);
    return {
      sessionId: session.id,
      token,
      userId: session.userId,
      organizationId: session.activeOrganizationId,
      watchesPresence: Boolean(permissions.get('attendance.read')?.size),
    };
  }

  async function revalidate() {
    for (const socket of await io.fetchSockets()) {
      const { token, sessionId } = socket.data;
      const result = await authenticate({ headers: { cookie: `${sessionService.names.session}=${encodeURIComponent(token)}` } });
      if (result.error || result.sessionId !== sessionId || result.organizationId !== socket.data.organizationId) {
        socket.emit('session.ended');
        socket.disconnect(true);
      }
    }
  }

  return {
    attach(httpServer) {
      io = new Server(httpServer, {
        path: '/socket.io',
        serveClient: false,
        cors: { origin: allowedOrigin, credentials: true },
        // Plain WebSocket only: no long-polling, so no sticky sessions are needed behind a balancer.
        transports: ['websocket'],
      });
      io.use(async (socket, next) => {
        try {
          const result = await authenticate(socket.handshake);
          if (result.error) return next(new Error(result.error));
          socket.data = result;
          next();
        } catch (err) {
          logger?.error({ err }, 'socket authentication failed');
          next(new Error('unavailable'));
        }
      });
      io.on('connection', (socket) => {
        socket.join(memberRoom(socket.data.organizationId, socket.data.userId));
        if (socket.data.watchesPresence) socket.join(presenceRoom(socket.data.organizationId));
        socket.emit('ready', { organizationId: socket.data.organizationId });
      });
      timer = setInterval(() => revalidate().catch((err) => logger?.warn({ err }, 'socket revalidation failed')), REVALIDATE_INTERVAL_MS);
      timer.unref();
      return io;
    },

    emitToMember(organizationId, userId, event, payload) {
      io?.to(memberRoom(organizationId, userId)).emit(event, payload);
    },

    emitToOrgPresence(organizationId, payload) {
      io?.to(presenceRoom(organizationId)).emit('presence.changed', payload);
    },

    revalidate: () => (io ? revalidate() : Promise.resolve()),

    async close() {
      clearInterval(timer);
      if (io) await io.close();
    },
  };
}

/** A hub that drops events: used by tests and scripts that do not run a socket server. */
export const nullRealtime = Object.freeze({ emitToMember() {}, emitToOrgPresence() {}, revalidate: async () => {}, close: async () => {} });
