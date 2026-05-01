import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/auth';
import { prisma } from '../lib/prisma';

const tokenSchema = z.object({
  token: z.string().min(1),
  platform: z.enum(['ios', 'android']).default('ios'),
});

const tokenDeleteSchema = z.object({
  token: z.string().min(1),
});

export async function notificationRoutes(app: FastifyInstance) {
  app.post('/notifications/token', {
    preHandler: authenticate,
    schema: {
      tags: ['notifications'],
      summary: 'Register push token',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['token'],
        properties: {
          token: { type: 'string' },
          platform: { type: 'string', enum: ['ios', 'android'], default: 'ios' },
        },
      },
    },
  }, async (req, reply) => {
    const body = tokenSchema.parse(req.body);
    await prisma.pushToken.upsert({
      where: { token: body.token },
      update: { userId: req.userId!, platform: body.platform },
      create: { userId: req.userId!, token: body.token, platform: body.platform },
    });
    return reply.send({ success: true });
  });

  app.delete('/notifications/token', {
    preHandler: authenticate,
    schema: {
      tags: ['notifications'],
      summary: 'Remove push token',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['token'],
        properties: { token: { type: 'string' } },
      },
    },
  }, async (req, reply) => {
    const body = tokenDeleteSchema.parse(req.body);
    await prisma.pushToken
      .deleteMany({ where: { token: body.token, userId: req.userId! } });
    return reply.send({ success: true });
  });
}
