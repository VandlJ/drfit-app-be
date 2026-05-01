import 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
    userEmail?: string;
    rawBody?: Buffer;
  }
}
