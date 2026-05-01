import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';
import {
  AuthError,
  loginUser,
  logoutUser,
  refreshAccessToken,
  registerUser,
} from '../services/authService';

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1).max(100),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(10),
});

const logoutSchema = z.object({
  refreshToken: z.string().min(10),
});

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/register', {
    schema: {
      tags: ['auth'],
      summary: 'Register a new user',
      body: {
        type: 'object',
        required: ['email', 'password', 'name'],
        properties: {
          email: { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 8 },
          name: { type: 'string', minLength: 1, maxLength: 100 },
        },
      },
    },
  }, async (req, reply) => {
    const body = registerSchema.parse(req.body);
    try {
      const result = await registerUser(body.email, body.password, body.name);
      return reply.code(201).send(result);
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.code(err.status).send({ error: err.message, code: err.code });
      }
      throw err;
    }
  });

  app.post('/auth/login', {
    schema: {
      tags: ['auth'],
      summary: 'Log in',
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', format: 'email' },
          password: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const body = loginSchema.parse(req.body);
    try {
      const result = await loginUser(body.email, body.password);
      return reply.send(result);
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.code(err.status).send({ error: err.message, code: err.code });
      }
      throw err;
    }
  });

  app.post('/auth/refresh', {
    schema: {
      tags: ['auth'],
      summary: 'Exchange refresh token for new access token',
      body: {
        type: 'object',
        required: ['refreshToken'],
        properties: { refreshToken: { type: 'string' } },
      },
    },
  }, async (req, reply) => {
    const body = refreshSchema.parse(req.body);
    try {
      const result = await refreshAccessToken(body.refreshToken);
      return reply.send(result);
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.code(err.status).send({ error: err.message, code: err.code });
      }
      throw err;
    }
  });

  app.post('/auth/logout', {
    preHandler: authenticate,
    schema: {
      tags: ['auth'],
      summary: 'Revoke a refresh token',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['refreshToken'],
        properties: { refreshToken: { type: 'string' } },
      },
    },
  }, async (req, reply) => {
    const body = logoutSchema.parse(req.body);
    await logoutUser(body.refreshToken);
    return reply.send({ success: true });
  });

  app.get('/auth/me', {
    preHandler: authenticate,
    schema: {
      tags: ['auth'],
      summary: 'Get current user',
      security: [{ bearerAuth: [] }],
    },
  }, async (req, reply) => {
    const user = await prisma.user.findUnique({
      where: { id: req.userId! },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        createdAt: true,
        defaultCenter: { select: { id: true, name: true } },
      },
    });
    if (!user) return reply.code(404).send({ error: 'User not found', code: 'NOT_FOUND' });
    return reply.send(user);
  });

  app.patch('/auth/me', {
    preHandler: authenticate,
    schema: {
      tags: ['auth'],
      summary: 'Update current user (default center)',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['defaultCenterId'],
        properties: { defaultCenterId: { type: 'string' } },
      },
    },
  }, async (req, reply) => {
    const { defaultCenterId } = z.object({ defaultCenterId: z.string().min(1) }).parse(req.body);
    const center = await prisma.fitnessCenter.findUnique({ where: { id: defaultCenterId } });
    if (!center || !center.isActive) {
      return reply.code(404).send({ error: 'Center not found or inactive', code: 'NOT_FOUND' });
    }
    await prisma.user.update({
      where: { id: req.userId! },
      data: { defaultCenterId },
    });
    return reply.send({ defaultCenter: { id: center.id, name: center.name } });
  });
}
