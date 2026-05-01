import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/auth';
import {
  ReservationError,
  cancelReservation,
  createReservation,
  getReservationPin,
  listReservationsForUser,
} from '../services/reservationService';

const createSchema = z.object({
  slotId: z.string().min(1),
});

const idParams = z.object({
  id: z.string().min(1),
});

export async function reservationRoutes(app: FastifyInstance) {
  app.get('/reservations', {
    preHandler: authenticate,
    schema: {
      tags: ['reservations'],
      summary: 'List my reservations',
      security: [{ bearerAuth: [] }],
    },
  }, async (req, reply) => {
    const reservations = await listReservationsForUser(req.userId!);
    return reply.send({
      reservations: reservations.map((r) => ({
        id: r.id,
        status: r.status,
        creditsSpent: r.creditsSpent,
        createdAt: r.createdAt,
        cancelledAt: r.cancelledAt,
        slot: {
          id: r.slot.id,
          date: r.slot.date.toISOString().slice(0, 10),
          startTime: r.slot.startTime,
          endTime: r.slot.endTime,
          priceCredits: r.slot.priceCredits,
          centerId: r.slot.centerId,
          center: {
            id: r.slot.center.id,
            name: r.slot.center.name,
            address: r.slot.center.address,
          },
        },
      })),
    });
  });

  app.post('/reservations', {
    preHandler: authenticate,
    schema: {
      tags: ['reservations'],
      summary: 'Create a reservation',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['slotId'],
        properties: { slotId: { type: 'string' } },
      },
    },
  }, async (req, reply) => {
    const body = createSchema.parse(req.body);
    try {
      const reservation = await createReservation(req.userId!, body.slotId);
      return reply.code(201).send({
        reservation: {
          id: reservation.id,
          slotId: reservation.slotId,
          pin: reservation.pin,
          creditsSpent: reservation.creditsSpent,
          status: reservation.status,
        },
      });
    } catch (err) {
      if (err instanceof ReservationError) {
        return reply.code(err.status).send({ error: err.message, code: err.code });
      }
      throw err;
    }
  });

  app.delete('/reservations/:id', {
    preHandler: authenticate,
    schema: {
      tags: ['reservations'],
      summary: 'Cancel a reservation',
      security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    },
  }, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    try {
      const result = await cancelReservation(req.userId!, id);
      return reply.send(result);
    } catch (err) {
      if (err instanceof ReservationError) {
        return reply.code(err.status).send({ error: err.message, code: err.code });
      }
      throw err;
    }
  });

  app.get('/reservations/:id/pin', {
    preHandler: authenticate,
    schema: {
      tags: ['reservations'],
      summary: 'Get reservation PIN (available anytime while reservation is ACTIVE)',
      security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    },
  }, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    try {
      const result = await getReservationPin(req.userId!, id);
      return reply.send(result);
    } catch (err) {
      if (err instanceof ReservationError) {
        return reply.code(err.status).send({ error: err.message, code: err.code });
      }
      throw err;
    }
  });
}
