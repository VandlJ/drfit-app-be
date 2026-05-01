import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import Stripe from 'stripe';
import { authenticate } from '../middleware/auth';
import {
  CreditsError,
  applyPaymentSuccess,
  createTopupIntent,
  getBalance,
  getHistory,
} from '../services/creditsService';
import { ensureStripe } from '../lib/stripe';
import { config } from '../lib/config';

const historyQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const topupSchema = z.object({
  packageId: z.string().min(1),
});

export async function creditsRoutes(app: FastifyInstance) {
  app.get('/credits/balance', {
    preHandler: authenticate,
    schema: { tags: ['credits'], summary: 'Get balance', security: [{ bearerAuth: [] }] },
  }, async (req, reply) => {
    const balance = await getBalance(req.userId!);
    return reply.send({ balance });
  });

  app.get('/credits/history', {
    preHandler: authenticate,
    schema: {
      tags: ['credits'],
      summary: 'Transaction history',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          offset: { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
  }, async (req, reply) => {
    const { limit, offset } = historyQuery.parse(req.query);
    const transactions = await getHistory(req.userId!, limit, offset);
    return reply.send({
      transactions: transactions.map((t) => ({
        id: t.id,
        amount: t.amount,
        type: t.type,
        description: t.description,
        referenceId: t.referenceId,
        createdAt: t.createdAt,
      })),
    });
  });

  app.post('/credits/topup', {
    preHandler: authenticate,
    schema: {
      tags: ['credits'],
      summary: 'Create Stripe PaymentIntent for top-up',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['packageId'],
        properties: {
          packageId: { type: 'string', enum: ['starter', 'standard', 'premium', 'pro'] },
        },
      },
    },
  }, async (req, reply) => {
    const body = topupSchema.parse(req.body);
    try {
      const result = await createTopupIntent(req.userId!, body.packageId);
      return reply.send(result);
    } catch (err) {
      if (err instanceof CreditsError) {
        return reply.code(err.status).send({ error: err.message, code: err.code });
      }
      throw err;
    }
  });
}

/**
 * Stripe webhook is registered separately so it can use raw body parsing.
 */
export async function creditsWebhookRoute(app: FastifyInstance) {
  app.post(
    '/credits/webhook',
    {
      config: { rawBody: true },
      schema: {
        tags: ['credits'],
        summary: 'Stripe webhook (raw body, signature-verified)',
        description: 'Public endpoint called by Stripe. Body is the raw event JSON.',
      },
    },
    async (req, reply) => {
      if (!config.stripeWebhookSecret) {
        return reply.code(500).send({ error: 'Webhook not configured', code: 'CONFIG' });
      }

      const sig = req.headers['stripe-signature'];
      if (typeof sig !== 'string') {
        return reply.code(400).send({ error: 'Missing stripe-signature', code: 'BAD_SIGNATURE' });
      }

      const raw = req.rawBody;
      if (!raw) {
        return reply.code(400).send({ error: 'Missing raw body', code: 'BAD_BODY' });
      }

      let event: Stripe.Event;
      try {
        const stripe = ensureStripe();
        event = stripe.webhooks.constructEvent(raw, sig, config.stripeWebhookSecret);
      } catch (err) {
        app.log.warn({ err }, 'Stripe webhook signature verification failed');
        return reply.code(400).send({ error: 'Invalid signature', code: 'BAD_SIGNATURE' });
      }

      // Respond fast; do best-effort processing inline (Stripe expects 2xx within 30s).
      try {
        if (event.type === 'payment_intent.succeeded') {
          const intent = event.data.object as Stripe.PaymentIntent;
          await applyPaymentSuccess(intent);
        }
      } catch (err) {
        app.log.error({ err }, 'Failed to process Stripe event');
        // Still 200 only when verified; otherwise Stripe will retry. We return 500 so it retries.
        return reply.code(500).send({ received: false });
      }

      return reply.code(200).send({ received: true });
    },
  );
}
