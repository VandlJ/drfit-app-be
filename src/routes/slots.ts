import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { authenticate, requireAdminSecret } from '../middleware/auth';

const dateQuery = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const createSlotSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
  priceCredits: z.number().int().positive(),
});

export async function slotRoutes(app: FastifyInstance) {
  app.get('/slots', {
    preHandler: authenticate,
    schema: {
      tags: ['slots'],
      summary: 'List slots for a date',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        required: ['date'],
        properties: { date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } },
      },
    },
  }, async (req, reply) => {
    const { date } = dateQuery.parse(req.query);
    const day = new Date(`${date}T00:00:00.000Z`);
    const slots = await prisma.slot.findMany({
      where: { date: day },
      include: { reservation: { select: { status: true } } },
      orderBy: { startTime: 'asc' },
    });
    return reply.send({
      slots: slots.map((s) => ({
        id: s.id,
        date: s.date.toISOString().slice(0, 10),
        startTime: s.startTime,
        endTime: s.endTime,
        priceCredits: s.priceCredits,
        isAvailable: s.isAvailable && (!s.reservation || s.reservation.status !== 'ACTIVE'),
      })),
    });
  });

  app.post('/slots', {
    preHandler: requireAdminSecret,
    schema: {
      tags: ['slots'],
      summary: 'Create a slot (admin)',
      security: [{ adminSecret: [] }],
      body: {
        type: 'object',
        required: ['date', 'startTime', 'endTime', 'priceCredits'],
        properties: {
          date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          startTime: { type: 'string', pattern: '^\\d{2}:\\d{2}$' },
          endTime: { type: 'string', pattern: '^\\d{2}:\\d{2}$' },
          priceCredits: { type: 'integer', minimum: 1 },
        },
      },
    },
  }, async (req, reply) => {
    const body = createSlotSchema.parse(req.body);
    const slot = await prisma.slot.create({
      data: {
        date: new Date(`${body.date}T00:00:00.000Z`),
        startTime: body.startTime,
        endTime: body.endTime,
        priceCredits: body.priceCredits,
        isAvailable: true,
      },
    });
    return reply.code(201).send({
      slot: {
        id: slot.id,
        date: slot.date.toISOString().slice(0, 10),
        startTime: slot.startTime,
        endTime: slot.endTime,
        priceCredits: slot.priceCredits,
        isAvailable: slot.isAvailable,
      },
    });
  });
}
