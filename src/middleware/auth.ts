import { FastifyReply, FastifyRequest } from 'fastify';
import { verifyAccessToken } from '../lib/jwt';
import { config } from '../lib/config';

declare module 'fastify' {
  interface FastifyRequest {
    userRole?: string;
  }
}

export async function authenticate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return reply.code(401).send({ error: 'Missing or invalid Authorization header', code: 'UNAUTHORIZED' });
  }
  const token = header.slice('Bearer '.length).trim();
  try {
    const payload = verifyAccessToken(token);
    req.userId = payload.sub;
    req.userEmail = payload.email;
    req.userRole = payload.role;
  } catch {
    return reply.code(401).send({ error: 'Invalid or expired access token', code: 'UNAUTHORIZED' });
  }
}

/**
 * Header-based admin guard (legacy, used only by the mobile-facing POST /slots).
 * New admin dashboard endpoints use {@link requireAdmin} which checks JWT role.
 */
export async function requireAdminSecret(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const adminHeader = req.headers['x-admin-secret'];
  if (typeof adminHeader !== 'string' || adminHeader !== config.adminSecret) {
    return reply.code(403).send({ error: 'Admin access required', code: 'FORBIDDEN' });
  }
}

/**
 * JWT-based admin guard: authenticates the user AND requires role === "admin".
 */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await authenticate(req, reply);
  if (reply.sent) return;
  if (req.userRole !== 'admin') {
    return reply.code(403).send({ error: 'Admin role required', code: 'FORBIDDEN' });
  }
}
