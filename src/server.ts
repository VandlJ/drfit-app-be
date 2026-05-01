import Fastify from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { ZodError } from 'zod';
import { config } from './lib/config';
import { prisma } from './lib/prisma';
import { authRoutes } from './routes/auth';
import { slotRoutes } from './routes/slots';
import { reservationRoutes } from './routes/reservations';
import { creditsRoutes, creditsWebhookRoute } from './routes/credits';
import { notificationRoutes } from './routes/notifications';
import { feedbackRoutes } from './routes/feedback';
import { adminRoutes } from './routes/admin';
import { startNotificationJobs } from './jobs/notificationJobs';

declare module 'fastify' {
  interface FastifyContextConfig {
    rawBody?: boolean;
  }
}

export async function buildServer() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
    },
  });

  await app.register(cors, {
    origin: [
      process.env.MOBILE_ORIGIN ?? '*',
      process.env.ADMIN_DASHBOARD_ORIGIN ?? 'http://localhost:5173',
    ],
  });
  await app.register(sensible);

  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'drfit API',
        description: 'Private fitness center booking API',
        version: '1.0.0',
      },
      servers: [{ url: `http://localhost:${config.port}` }],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          adminSecret: { type: 'apiKey', in: 'header', name: 'x-admin-secret' },
        },
      },
      tags: [
        { name: 'auth' },
        { name: 'slots' },
        { name: 'reservations' },
        { name: 'credits' },
        { name: 'notifications' },
        { name: 'feedback' },
      ],
    },
  });
  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
  });

  // Custom JSON parser: keeps raw body buffer when the route asks for it (Stripe webhook).
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body, done) => {
      const buf = body as Buffer;
      if (req.routeOptions?.config?.rawBody) {
        req.rawBody = buf;
      }
      try {
        const json = buf.length ? JSON.parse(buf.toString('utf8')) : {};
        done(null, json);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  // Global error handler
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: 'Validation failed',
        code: 'VALIDATION_ERROR',
        details: err.flatten(),
      });
    }
    if ((err as any).statusCode && (err as any).statusCode < 500) {
      return reply.code((err as any).statusCode).send({
        error: err.message,
        code: (err as any).code ?? 'BAD_REQUEST',
      });
    }
    app.log.error({ err }, 'Unhandled error');
    return reply.code(500).send({ error: 'Internal Server Error', code: 'INTERNAL_ERROR' });
  });

  app.get('/health', async () => ({ status: 'ok' }));

  await app.register(authRoutes);
  await app.register(slotRoutes);
  await app.register(reservationRoutes);
  await app.register(creditsRoutes);
  await app.register(creditsWebhookRoute);
  await app.register(notificationRoutes);
  await app.register(feedbackRoutes);
  await app.register(adminRoutes, { prefix: '/admin' });

  app.addHook('onClose', async () => {
    await prisma.$disconnect();
  });

  return app;
}

async function start() {
  const app = await buildServer();
  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
    startNotificationJobs();
    app.log.info(`Notification cron started`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

if (require.main === module) {
  void start();
}
