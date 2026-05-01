import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';

const idParams = z.object({ id: z.string().min(1) });

export async function centerRoutes(app: FastifyInstance) {
  app.get('/centers', {
    preHandler: authenticate,
    schema: {
      tags: ['centers'],
      summary: 'List active fitness centers',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const centers = await prisma.fitnessCenter.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
    });
    return {
      centers: centers.map((c) => ({
        id: c.id,
        name: c.name,
        address: c.address,
        description: c.description,
        imageUrl: c.imageUrl,
        isActive: c.isActive,
      })),
    };
  });

  app.get('/centers/:id', {
    preHandler: authenticate,
    schema: {
      tags: ['centers'],
      summary: 'Get fitness center detail',
      security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    },
  }, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const c = await prisma.fitnessCenter.findUnique({ where: { id } });
    if (!c || !c.isActive) {
      return reply.code(404).send({ error: 'Center not found', code: 'NOT_FOUND' });
    }
    return {
      id: c.id,
      name: c.name,
      address: c.address,
      description: c.description,
      imageUrl: c.imageUrl,
      isActive: c.isActive,
    };
  });
}
