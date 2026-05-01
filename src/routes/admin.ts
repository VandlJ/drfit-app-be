import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Prisma, ReservationStatus, TransactionType } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { requireAdmin } from '../middleware/auth';
import { sendPushNotification } from '../lib/expoPush';

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}
function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}
function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
}
function dateOnlyUTC(s: string): Date {
  return new Date(`${s}T00:00:00.000Z`);
}

const dateRangeQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

// ────────────────────────────────────────────────────────────────────────────
// Routes
// ────────────────────────────────────────────────────────────────────────────

export async function adminRoutes(app: FastifyInstance) {
  // Apply admin guard to every route in this scope.
  app.addHook('preHandler', requireAdmin);

  // ── Dashboard ────────────────────────────────────────────────────────────
  const dashboardQuery = z.object({ centerId: z.string().optional() });

  app.get('/dashboard/stats', {
    schema: {
      tags: ['admin'],
      summary: 'Dashboard stats (optionally scoped by center)',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: { centerId: { type: 'string' } },
      },
    },
  }, async (req) => {
    const { centerId } = dashboardQuery.parse(req.query);
    const now = new Date();
    const todayStart = startOfDay(now);
    const todayEnd = endOfDay(now);
    const monthStart = startOfMonth(now);
    const todayDateUTC = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));

    const reservationCenterFilter: Prisma.ReservationWhereInput = centerId
      ? { slot: { centerId } }
      : {};
    const slotCenterFilter: Prisma.SlotWhereInput = centerId ? { centerId } : {};

    const [
      totalUsers,
      totalReservationsToday,
      totalReservationsThisMonth,
      topupAgg,
      creditsAgg,
      slotsToday,
      reservedSlotsToday,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.reservation.count({
        where: { ...reservationCenterFilter, createdAt: { gte: todayStart, lte: todayEnd } },
      }),
      prisma.reservation.count({
        where: { ...reservationCenterFilter, createdAt: { gte: monthStart } },
      }),
      // Revenue is global (top-ups aren't tied to a center).
      prisma.creditTransaction.aggregate({
        where: { type: 'TOPUP', createdAt: { gte: monthStart } },
        _sum: { amount: true },
      }),
      prisma.creditAccount.aggregate({ _sum: { balance: true } }),
      prisma.slot.count({ where: { ...slotCenterFilter, date: todayDateUTC } }),
      prisma.slot.count({
        where: {
          ...slotCenterFilter,
          date: todayDateUTC,
          reservation: { status: 'ACTIVE' },
        },
      }),
    ]);

    const revenueThisMonth = topupAgg._sum.amount ?? 0;
    return {
      centerId: centerId ?? null,
      totalUsers,
      totalReservationsToday,
      totalReservationsThisMonth,
      revenueThisMonth,
      creditsInCirculation: creditsAgg._sum.balance ?? 0,
      occupancyRateToday: slotsToday > 0 ? reservedSlotsToday / slotsToday : 0,
    };
  });

  // ── Users ────────────────────────────────────────────────────────────────
  const usersListQuery = paginationQuery.extend({
    search: z.string().optional(),
  });

  app.get('/users', {
    schema: {
      tags: ['admin'],
      summary: 'List users',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', default: 20, minimum: 1, maximum: 200 },
          offset: { type: 'integer', default: 0, minimum: 0 },
          search: { type: 'string' },
        },
      },
    },
  }, async (req) => {
    const { limit, offset, search } = usersListQuery.parse(req.query);
    const where: Prisma.UserWhereInput = search
      ? {
          OR: [
            { email: { contains: search, mode: 'insensitive' } },
            { name: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {};
    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        include: {
          creditAccount: { select: { balance: true } },
          _count: { select: { reservations: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.user.count({ where }),
    ]);
    return {
      users: users.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        creditBalance: u.creditAccount?.balance ?? 0,
        totalReservations: u._count.reservations,
        createdAt: u.createdAt,
      })),
      total,
    };
  });

  app.get('/users/:id', {
    schema: {
      tags: ['admin'],
      summary: 'User detail',
      security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    },
  }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const user = await prisma.user.findUnique({
      where: { id },
      include: {
        creditAccount: {
          include: {
            transactions: { orderBy: { createdAt: 'desc' }, take: 10 },
          },
        },
        reservations: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          include: { slot: true },
        },
      },
    });
    if (!user) {
      return reply.code(404).send({ error: 'User not found', code: 'NOT_FOUND' });
    }
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      createdAt: user.createdAt,
      creditBalance: user.creditAccount?.balance ?? 0,
      reservations: user.reservations.map((r) => ({
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
        },
      })),
      creditTransactions: user.creditAccount?.transactions ?? [],
    };
  });

  const creditsAdjustSchema = z.object({
    amount: z.number().int().refine((n) => n !== 0, 'amount must be non-zero'),
    description: z.string().min(1).max(500),
  });

  app.patch('/users/:id/credits', {
    schema: {
      tags: ['admin'],
      summary: 'Manually adjust user credits',
      security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: {
        type: 'object',
        required: ['amount', 'description'],
        properties: {
          amount: { type: 'integer' },
          description: { type: 'string', minLength: 1, maxLength: 500 },
        },
      },
    },
  }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = creditsAdjustSchema.parse(req.body);

    const result = await prisma.$transaction(async (tx) => {
      const account = await tx.creditAccount.findUnique({ where: { userId: id } });
      if (!account) {
        return { error: 'NOT_FOUND' as const };
      }
      if (account.balance + body.amount < 0) {
        return { error: 'INSUFFICIENT_BALANCE' as const };
      }
      const updated = await tx.creditAccount.update({
        where: { id: account.id },
        data: { balance: { increment: body.amount } },
      });
      await tx.creditTransaction.create({
        data: {
          creditAccountId: account.id,
          amount: body.amount,
          type: body.amount > 0 ? TransactionType.TOPUP : TransactionType.REFUND,
          description: body.description,
        },
      });
      return { newBalance: updated.balance };
    });

    if ('error' in result) {
      if (result.error === 'NOT_FOUND') {
        return reply.code(404).send({ error: 'Credit account not found', code: 'NOT_FOUND' });
      }
      return reply
        .code(400)
        .send({ error: 'Adjustment would result in negative balance', code: 'INSUFFICIENT_BALANCE' });
    }
    return { newBalance: result.newBalance };
  });

  app.patch('/users/:id/role', {
    schema: {
      tags: ['admin'],
      summary: 'Change user role',
      security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: {
        type: 'object',
        required: ['role'],
        properties: { role: { type: 'string', enum: ['client', 'admin'] } },
      },
    },
  }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { role } = z.object({ role: z.enum(['client', 'admin']) }).parse(req.body);
    try {
      await prisma.user.update({ where: { id }, data: { role } });
    } catch {
      return reply.code(404).send({ error: 'User not found', code: 'NOT_FOUND' });
    }
    return { success: true };
  });

  // ── Slots ────────────────────────────────────────────────────────────────
  const slotsListQuery = dateRangeQuery.extend({ centerId: z.string().optional() });

  app.get('/slots', {
    schema: {
      tags: ['admin'],
      summary: 'List slots in date range',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          centerId: { type: 'string' },
        },
      },
    },
  }, async (req) => {
    const { from, to, centerId } = slotsListQuery.parse(req.query);
    const where: Prisma.SlotWhereInput = {};
    if (from || to) {
      where.date = {};
      if (from) (where.date as Prisma.DateTimeFilter).gte = dateOnlyUTC(from);
      if (to) (where.date as Prisma.DateTimeFilter).lte = dateOnlyUTC(to);
    }
    if (centerId) where.centerId = centerId;
    const slots = await prisma.slot.findMany({
      where,
      orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
      include: {
        center: { select: { id: true, name: true } },
        reservation: {
          include: { user: { select: { id: true, name: true, email: true } } },
        },
      },
    });
    return {
      slots: slots.map((s) => ({
        id: s.id,
        date: s.date.toISOString().slice(0, 10),
        startTime: s.startTime,
        endTime: s.endTime,
        priceCredits: s.priceCredits,
        isAvailable: s.isAvailable,
        center: s.center,
        reservation: s.reservation
          ? {
              id: s.reservation.id,
              status: s.reservation.status,
              user: s.reservation.user,
            }
          : null,
      })),
    };
  });

  const slotCreateSchema = z.object({
    centerId: z.string().min(1),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    startTime: z.string().regex(/^\d{2}:\d{2}$/),
    endTime: z.string().regex(/^\d{2}:\d{2}$/),
    priceCredits: z.number().int().positive(),
  });

  app.post('/slots', {
    schema: {
      tags: ['admin'],
      summary: 'Create slot',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['centerId', 'date', 'startTime', 'endTime', 'priceCredits'],
        properties: {
          centerId: { type: 'string' },
          date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          startTime: { type: 'string', pattern: '^\\d{2}:\\d{2}$' },
          endTime: { type: 'string', pattern: '^\\d{2}:\\d{2}$' },
          priceCredits: { type: 'integer', minimum: 1 },
        },
      },
    },
  }, async (req, reply) => {
    const body = slotCreateSchema.parse(req.body);
    const slot = await prisma.slot.create({
      data: {
        centerId: body.centerId,
        date: dateOnlyUTC(body.date),
        startTime: body.startTime,
        endTime: body.endTime,
        priceCredits: body.priceCredits,
        isAvailable: true,
      },
    });
    return reply.code(201).send({
      slot: {
        id: slot.id,
        centerId: slot.centerId,
        date: slot.date.toISOString().slice(0, 10),
        startTime: slot.startTime,
        endTime: slot.endTime,
        priceCredits: slot.priceCredits,
      },
    });
  });

  const bulkSchema = z.object({
    centerId: z.string().min(1),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    weekdays: z.array(z.number().int().min(0).max(6)).min(1),
    times: z
      .array(
        z.object({
          startTime: z.string().regex(/^\d{2}:\d{2}$/),
          endTime: z.string().regex(/^\d{2}:\d{2}$/),
        }),
      )
      .min(1),
    priceCredits: z.number().int().positive(),
  });

  app.post('/slots/bulk', {
    schema: {
      tags: ['admin'],
      summary: 'Bulk create slots',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['centerId', 'from', 'to', 'weekdays', 'times', 'priceCredits'],
        properties: {
          centerId: { type: 'string' },
          from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          weekdays: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 } },
          times: {
            type: 'array',
            items: {
              type: 'object',
              required: ['startTime', 'endTime'],
              properties: {
                startTime: { type: 'string', pattern: '^\\d{2}:\\d{2}$' },
                endTime: { type: 'string', pattern: '^\\d{2}:\\d{2}$' },
              },
            },
          },
          priceCredits: { type: 'integer', minimum: 1 },
        },
      },
    },
  }, async (req) => {
    const body = bulkSchema.parse(req.body);
    const fromD = dateOnlyUTC(body.from);
    const toD = dateOnlyUTC(body.to);
    if (toD.getTime() < fromD.getTime()) {
      return { created: 0, skipped: 0 };
    }
    const weekdays = new Set(body.weekdays);

    let created = 0;
    let skipped = 0;
    const cursor = new Date(fromD);
    while (cursor.getTime() <= toD.getTime()) {
      if (weekdays.has(cursor.getUTCDay())) {
        const date = new Date(cursor);
        for (const t of body.times) {
          const exists = await prisma.slot.findFirst({
            where: { date, startTime: t.startTime, centerId: body.centerId },
          });
          if (exists) {
            skipped++;
          } else {
            await prisma.slot.create({
              data: {
                centerId: body.centerId,
                date,
                startTime: t.startTime,
                endTime: t.endTime,
                priceCredits: body.priceCredits,
                isAvailable: true,
              },
            });
            created++;
          }
        }
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return { created, skipped };
  });

  const slotPatchSchema = z.object({
    priceCredits: z.number().int().positive().optional(),
    isAvailable: z.boolean().optional(),
  });

  app.patch('/slots/:id', {
    schema: {
      tags: ['admin'],
      summary: 'Update slot',
      security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: {
        type: 'object',
        properties: {
          priceCredits: { type: 'integer', minimum: 1 },
          isAvailable: { type: 'boolean' },
        },
      },
    },
  }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = slotPatchSchema.parse(req.body);
    const slot = await prisma.slot.findUnique({
      where: { id },
      include: { reservation: true },
    });
    if (!slot) {
      return reply.code(404).send({ error: 'Slot not found', code: 'NOT_FOUND' });
    }
    if (
      body.isAvailable === false &&
      slot.reservation &&
      slot.reservation.status === 'ACTIVE'
    ) {
      return reply
        .code(409)
        .send({ error: 'Slot has an active reservation', code: 'SLOT_HAS_RESERVATION' });
    }
    const updated = await prisma.slot.update({
      where: { id },
      data: body,
    });
    return {
      slot: { id: updated.id, priceCredits: updated.priceCredits, isAvailable: updated.isAvailable },
    };
  });

  app.delete('/slots/:id', {
    schema: {
      tags: ['admin'],
      summary: 'Delete slot',
      security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    },
  }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const slot = await prisma.slot.findUnique({
      where: { id },
      include: { reservation: true },
    });
    if (!slot) {
      return reply.code(404).send({ error: 'Slot not found', code: 'NOT_FOUND' });
    }
    if (slot.reservation && slot.reservation.status === 'ACTIVE') {
      return reply
        .code(409)
        .send({ error: 'Slot has an active reservation', code: 'SLOT_HAS_RESERVATION' });
    }
    await prisma.slot.delete({ where: { id } });
    return { success: true };
  });

  // ── Reservations ─────────────────────────────────────────────────────────
  const reservationsListQuery = paginationQuery.extend({
    status: z.enum(['ACTIVE', 'COMPLETED', 'CANCELLED']).optional(),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    userId: z.string().optional(),
    centerId: z.string().optional(),
  });

  app.get('/reservations', {
    schema: {
      tags: ['admin'],
      summary: 'List reservations (filterable)',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['ACTIVE', 'COMPLETED', 'CANCELLED'] },
          from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          userId: { type: 'string' },
          centerId: { type: 'string' },
          limit: { type: 'integer', default: 20, minimum: 1, maximum: 200 },
          offset: { type: 'integer', default: 0, minimum: 0 },
        },
      },
    },
  }, async (req) => {
    const { status, from, to, userId, centerId, limit, offset } = reservationsListQuery.parse(req.query);
    const where: Prisma.ReservationWhereInput = {};
    if (status) where.status = status as ReservationStatus;
    if (userId) where.userId = userId;
    if (from || to || centerId) {
      where.slot = {};
      if (centerId) where.slot.centerId = centerId;
      if (from || to) {
        where.slot.date = {};
        if (from) (where.slot.date as Prisma.DateTimeFilter).gte = dateOnlyUTC(from);
        if (to) (where.slot.date as Prisma.DateTimeFilter).lte = dateOnlyUTC(to);
      }
    }
    const [reservations, total] = await Promise.all([
      prisma.reservation.findMany({
        where,
        include: {
          slot: { include: { center: { select: { id: true, name: true } } } },
          user: { select: { id: true, name: true, email: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.reservation.count({ where }),
    ]);
    return {
      reservations: reservations.map((r) => ({
        id: r.id,
        status: r.status,
        creditsSpent: r.creditsSpent,
        createdAt: r.createdAt,
        cancelledAt: r.cancelledAt,
        user: r.user,
        slot: {
          id: r.slot.id,
          date: r.slot.date.toISOString().slice(0, 10),
          startTime: r.slot.startTime,
          endTime: r.slot.endTime,
          priceCredits: r.slot.priceCredits,
          center: r.slot.center,
        },
      })),
      total,
    };
  });

  app.get('/reservations/:id', {
    schema: {
      tags: ['admin'],
      summary: 'Reservation detail (includes PIN)',
      security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    },
  }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const r = await prisma.reservation.findUnique({
      where: { id },
      include: {
        slot: { include: { center: { select: { id: true, name: true } } } },
        user: { select: { id: true, name: true, email: true } },
      },
    });
    if (!r) return reply.code(404).send({ error: 'Reservation not found', code: 'NOT_FOUND' });
    return {
      id: r.id,
      status: r.status,
      creditsSpent: r.creditsSpent,
      pin: r.pin,
      createdAt: r.createdAt,
      cancelledAt: r.cancelledAt,
      user: r.user,
      slot: {
        id: r.slot.id,
        date: r.slot.date.toISOString().slice(0, 10),
        startTime: r.slot.startTime,
        endTime: r.slot.endTime,
        priceCredits: r.slot.priceCredits,
        center: r.slot.center,
      },
    };
  });

  app.delete('/reservations/:id', {
    schema: {
      tags: ['admin'],
      summary: 'Force-cancel reservation (full refund)',
      security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    },
  }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const result = await prisma.$transaction(async (tx) => {
      const r = await tx.reservation.findUnique({ where: { id } });
      if (!r) return { error: 'NOT_FOUND' as const };
      if (r.status !== 'ACTIVE') return { error: 'NOT_ACTIVE' as const };

      const account = await tx.creditAccount.findUnique({ where: { userId: r.userId } });

      await tx.reservation.update({
        where: { id: r.id },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });
      const refund = r.creditsSpent;
      if (account && refund > 0) {
        await tx.creditAccount.update({
          where: { id: account.id },
          data: { balance: { increment: refund } },
        });
        await tx.creditTransaction.create({
          data: {
            creditAccountId: account.id,
            amount: refund,
            type: 'REFUND',
            referenceId: r.id,
            description: 'Refund – administrative cancellation',
          },
        });
      }
      await tx.slot.update({ where: { id: r.slotId }, data: { isAvailable: true } });
      return { refundedCredits: refund };
    });

    if ('error' in result) {
      if (result.error === 'NOT_FOUND') {
        return reply.code(404).send({ error: 'Reservation not found', code: 'NOT_FOUND' });
      }
      return reply
        .code(409)
        .send({ error: 'Reservation is not active', code: 'RESERVATION_NOT_ACTIVE' });
    }
    return { refundedCredits: result.refundedCredits };
  });

  // ── Credits & Revenue ────────────────────────────────────────────────────
  const txQuery = paginationQuery.extend({
    type: z.enum(['TOPUP', 'SPEND', 'REFUND', 'BONUS']).optional(),
    userId: z.string().optional(),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  });

  app.get('/credits/transactions', {
    schema: {
      tags: ['admin'],
      summary: 'Cross-user credit transaction log',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['TOPUP', 'SPEND', 'REFUND', 'BONUS'] },
          userId: { type: 'string' },
          from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          limit: { type: 'integer', default: 20, minimum: 1, maximum: 200 },
          offset: { type: 'integer', default: 0, minimum: 0 },
        },
      },
    },
  }, async (req) => {
    const { type, userId, from, to, limit, offset } = txQuery.parse(req.query);
    const where: Prisma.CreditTransactionWhereInput = {};
    if (type) where.type = type as TransactionType;
    if (userId) where.creditAccount = { userId };
    if (from || to) {
      where.createdAt = {};
      if (from) (where.createdAt as Prisma.DateTimeFilter).gte = startOfDay(new Date(from));
      if (to) (where.createdAt as Prisma.DateTimeFilter).lte = endOfDay(new Date(to));
    }
    const [transactions, total] = await Promise.all([
      prisma.creditTransaction.findMany({
        where,
        include: {
          creditAccount: {
            include: { user: { select: { id: true, name: true, email: true } } },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.creditTransaction.count({ where }),
    ]);
    return {
      transactions: transactions.map((t) => ({
        id: t.id,
        amount: t.amount,
        type: t.type,
        description: t.description,
        referenceId: t.referenceId,
        createdAt: t.createdAt,
        user: t.creditAccount.user,
      })),
      total,
    };
  });

  const revenueQuery = z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    groupBy: z.enum(['day', 'month']).default('day'),
  });

  app.get('/credits/revenue', {
    schema: {
      tags: ['admin'],
      summary: 'Aggregated revenue (TOPUP)',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          groupBy: { type: 'string', enum: ['day', 'month'], default: 'day' },
        },
      },
    },
  }, async (req) => {
    const { from, to, groupBy } = revenueQuery.parse(req.query);
    const where: Prisma.CreditTransactionWhereInput = { type: 'TOPUP' };
    if (from || to) {
      where.createdAt = {};
      if (from) (where.createdAt as Prisma.DateTimeFilter).gte = startOfDay(new Date(from));
      if (to) (where.createdAt as Prisma.DateTimeFilter).lte = endOfDay(new Date(to));
    }
    const txs = await prisma.creditTransaction.findMany({
      where,
      select: { amount: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });

    const buckets = new Map<string, { amountKc: number; transactions: number }>();
    for (const t of txs) {
      const d = t.createdAt;
      const key =
        groupBy === 'day'
          ? d.toISOString().slice(0, 10)
          : d.toISOString().slice(0, 7);
      const cur = buckets.get(key) ?? { amountKc: 0, transactions: 0 };
      cur.amountKc += t.amount;
      cur.transactions += 1;
      buckets.set(key, cur);
    }

    const revenue = Array.from(buckets.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([period, v]) => ({ period, ...v }));
    const totalKc = revenue.reduce((s, r) => s + r.amountKc, 0);
    return { revenue, totalKc };
  });

  // ── Feedback ─────────────────────────────────────────────────────────────
  const feedbackQuery = paginationQuery.extend({
    minRating: z.coerce.number().int().min(1).max(5).default(1),
    maxRating: z.coerce.number().int().min(1).max(5).default(5),
  });

  app.get('/feedback', {
    schema: {
      tags: ['admin'],
      summary: 'List feedback',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', default: 20, minimum: 1, maximum: 200 },
          offset: { type: 'integer', default: 0, minimum: 0 },
          minRating: { type: 'integer', minimum: 1, maximum: 5, default: 1 },
          maxRating: { type: 'integer', minimum: 1, maximum: 5, default: 5 },
        },
      },
    },
  }, async (req) => {
    const { limit, offset, minRating, maxRating } = feedbackQuery.parse(req.query);
    const where: Prisma.FeedbackWhereInput = {
      rating: { gte: minRating, lte: maxRating },
    };
    const [items, total, agg] = await Promise.all([
      prisma.feedback.findMany({
        where,
        include: { user: { select: { name: true, email: true } } },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.feedback.count({ where }),
      prisma.feedback.aggregate({ where, _avg: { rating: true } }),
    ]);
    return {
      feedback: items.map((f) => ({
        id: f.id,
        rating: f.rating,
        comment: f.comment,
        user: f.user,
        reservationId: f.reservationId,
        createdAt: f.createdAt,
      })),
      total,
      averageRating: agg._avg.rating ? Number(agg._avg.rating.toFixed(2)) : 0,
    };
  });

  // ── Notifications broadcast ──────────────────────────────────────────────
  const broadcastSchema = z.object({
    title: z.string().min(1).max(100),
    body: z.string().min(1).max(500),
    userIds: z.array(z.string()).optional(),
  });

  app.post('/notifications/broadcast', {
    schema: {
      tags: ['admin'],
      summary: 'Broadcast push notification',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['title', 'body'],
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 100 },
          body: { type: 'string', minLength: 1, maxLength: 500 },
          userIds: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  }, async (req) => {
    const body = broadcastSchema.parse(req.body);
    const where: Prisma.PushTokenWhereInput = body.userIds
      ? { userId: { in: body.userIds } }
      : {};
    const tokens = await prisma.pushToken.findMany({ where, select: { token: true } });
    const tokenList = tokens.map((t) => t.token);
    await sendPushNotification(tokenList, body.title, body.body, { broadcast: true });
    return { sent: tokenList.length };
  });

  // ── Centers ──────────────────────────────────────────────────────────────
  app.get('/centers', {
    schema: {
      tags: ['admin'],
      summary: 'List all centers (incl. inactive) with stats',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const centers = await prisma.fitnessCenter.findMany({
      orderBy: { createdAt: 'asc' },
      include: {
        _count: { select: { slots: true } },
      },
    });
    const ids = centers.map((c) => c.id);
    const activeReservations = await prisma.reservation.groupBy({
      by: ['slotId'],
      where: { status: 'ACTIVE', slot: { centerId: { in: ids } } },
      _count: { _all: true },
    });
    // We need active reservations per center; group via slot lookup.
    const slots = await prisma.slot.findMany({
      where: { id: { in: activeReservations.map((a) => a.slotId) } },
      select: { id: true, centerId: true },
    });
    const slotToCenter = new Map(slots.map((s) => [s.id, s.centerId]));
    const activeByCenter = new Map<string, number>();
    for (const a of activeReservations) {
      const c = slotToCenter.get(a.slotId);
      if (c) activeByCenter.set(c, (activeByCenter.get(c) ?? 0) + a._count._all);
    }
    return {
      centers: centers.map((c) => ({
        id: c.id,
        name: c.name,
        address: c.address,
        description: c.description,
        imageUrl: c.imageUrl,
        isActive: c.isActive,
        stats: {
          totalSlots: c._count.slots,
          activeReservations: activeByCenter.get(c.id) ?? 0,
        },
      })),
    };
  });

  const centerCreateSchema = z.object({
    name: z.string().min(1).max(200),
    address: z.string().min(1).max(500),
    description: z.string().max(2000).optional(),
    imageUrl: z.string().url().max(1000).optional(),
  });

  app.post('/centers', {
    schema: {
      tags: ['admin'],
      summary: 'Create center',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['name', 'address'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 200 },
          address: { type: 'string', minLength: 1, maxLength: 500 },
          description: { type: 'string', maxLength: 2000 },
          imageUrl: { type: 'string', format: 'uri', maxLength: 1000 },
        },
      },
    },
  }, async (req, reply) => {
    const body = centerCreateSchema.parse(req.body);
    const center = await prisma.fitnessCenter.create({ data: body });
    return reply.code(201).send({
      center: {
        id: center.id,
        name: center.name,
        address: center.address,
        description: center.description,
        imageUrl: center.imageUrl,
        isActive: center.isActive,
      },
    });
  });

  const centerPatchSchema = z.object({
    name: z.string().min(1).max(200).optional(),
    address: z.string().min(1).max(500).optional(),
    description: z.string().max(2000).optional(),
    imageUrl: z.string().url().max(1000).optional(),
    isActive: z.boolean().optional(),
  });

  app.patch('/centers/:id', {
    schema: {
      tags: ['admin'],
      summary: 'Update center',
      security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 200 },
          address: { type: 'string', minLength: 1, maxLength: 500 },
          description: { type: 'string', maxLength: 2000 },
          imageUrl: { type: 'string', format: 'uri', maxLength: 1000 },
          isActive: { type: 'boolean' },
        },
      },
    },
  }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = centerPatchSchema.parse(req.body);

    const existing = await prisma.fitnessCenter.findUnique({ where: { id } });
    if (!existing) {
      return reply.code(404).send({ error: 'Center not found', code: 'NOT_FOUND' });
    }
    if (body.isActive === false) {
      const activeCount = await prisma.reservation.count({
        where: { status: 'ACTIVE', slot: { centerId: id } },
      });
      if (activeCount > 0) {
        return reply
          .code(409)
          .send({ error: 'Center has active reservations', code: 'CENTER_HAS_RESERVATIONS' });
      }
    }
    const center = await prisma.fitnessCenter.update({ where: { id }, data: body });
    return {
      center: {
        id: center.id,
        name: center.name,
        address: center.address,
        description: center.description,
        imageUrl: center.imageUrl,
        isActive: center.isActive,
      },
    };
  });
}
