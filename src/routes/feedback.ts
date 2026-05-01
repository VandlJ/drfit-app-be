import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/auth';
import { prisma } from '../lib/prisma';

const feedbackSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(2000).optional(),
  reservationId: z.string().optional(),
});

export async function feedbackRoutes(app: FastifyInstance) {
  app.post('/feedback', {
    preHandler: authenticate,
    schema: {
      tags: ['feedback'],
      summary: 'Submit feedback',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['rating'],
        properties: {
          rating: { type: 'integer', minimum: 1, maximum: 5 },
          comment: { type: 'string', maxLength: 2000 },
          reservationId: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const body = feedbackSchema.parse(req.body);
    await prisma.feedback.create({
      data: {
        userId: req.userId!,
        rating: body.rating,
        comment: body.comment,
        reservationId: body.reservationId,
      },
    });
    return reply.send({ success: true });
  });
}
