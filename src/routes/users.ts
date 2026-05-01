import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/auth';
import {
  UserError,
  changePassword,
  deleteUserAvatar,
  getUserProfile,
  setUserAvatar,
  updateUserProfile,
} from '../services/userService';

const updateBody = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  email: z.string().email().optional(),
  defaultCenterId: z.string().min(1).nullable().optional(),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD')
    .nullable()
    .optional(),
});

const passwordBody = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

const MAX_AVATAR_BYTES = 5 * 1024 * 1024; // 5 MB
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

export async function userRoutes(app: FastifyInstance) {
  app.get('/me', {
    preHandler: authenticate,
    schema: {
      tags: ['users'],
      summary: 'Get my profile',
      security: [{ bearerAuth: [] }],
    },
  }, async (req, reply) => {
    try {
      const user = await getUserProfile(req.userId!);
      return reply.send({ user });
    } catch (err) {
      if (err instanceof UserError) return reply.code(err.status).send({ error: err.message, code: err.code });
      throw err;
    }
  });

  app.patch('/me', {
    preHandler: authenticate,
    schema: {
      tags: ['users'],
      summary: 'Update my profile',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          email: { type: 'string', format: 'email' },
          defaultCenterId: { type: ['string', 'null'] },
          dateOfBirth: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        },
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    const body = updateBody.parse(req.body);
    try {
      const user = await updateUserProfile(req.userId!, body);
      return reply.send({ user });
    } catch (err) {
      if (err instanceof UserError) return reply.code(err.status).send({ error: err.message, code: err.code });
      throw err;
    }
  });

  app.post('/me/password', {
    preHandler: authenticate,
    schema: {
      tags: ['users'],
      summary: 'Change my password (revokes all refresh tokens)',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['currentPassword', 'newPassword'],
        properties: {
          currentPassword: { type: 'string' },
          newPassword: { type: 'string', minLength: 8 },
        },
      },
    },
  }, async (req, reply) => {
    const body = passwordBody.parse(req.body);
    try {
      await changePassword(req.userId!, body.currentPassword, body.newPassword);
      return reply.send({ ok: true });
    } catch (err) {
      if (err instanceof UserError) return reply.code(err.status).send({ error: err.message, code: err.code });
      throw err;
    }
  });

  app.post('/me/avatar', {
    preHandler: authenticate,
    // Skip body validation: multipart bodies don't populate req.body in a way
    // the JSON-schema validator can handle. We read the file via req.file().
    validatorCompiler: () => () => true,
    schema: {
      tags: ['users'],
      summary: 'Upload avatar (multipart/form-data, field "file", max 5MB)',
      security: [{ bearerAuth: [] }],
      consumes: ['multipart/form-data'],
      body: {
        type: 'object',
        required: ['file'],
        properties: {
          file: { type: 'string', format: 'binary' },
        },
      },
    },
  }, async (req, reply) => {
    const data = await req.file({ limits: { fileSize: MAX_AVATAR_BYTES, files: 1 } });
    if (!data) {
      return reply.code(400).send({ error: 'Missing "file" field', code: 'NO_FILE' });
    }
    if (!ALLOWED_MIME.has(data.mimetype)) {
      return reply.code(415).send({
        error: `Unsupported mime: ${data.mimetype}`,
        code: 'UNSUPPORTED_MEDIA_TYPE',
      });
    }

    let buffer: Buffer;
    try {
      buffer = await data.toBuffer();
    } catch (err: any) {
      if (err?.code === 'FST_REQ_FILE_TOO_LARGE') {
        return reply.code(413).send({ error: 'File too large (max 5MB)', code: 'FILE_TOO_LARGE' });
      }
      throw err;
    }

    try {
      const user = await setUserAvatar(req.userId!, buffer);
      return reply.send({ user });
    } catch (err: any) {
      if (err instanceof UserError) return reply.code(err.status).send({ error: err.message, code: err.code });
      // sharp throws on invalid images
      if (err?.message?.includes('Input') || err?.message?.includes('unsupported')) {
        return reply.code(400).send({ error: 'Invalid image', code: 'INVALID_IMAGE' });
      }
      throw err;
    }
  });

  app.delete('/me/avatar', {
    preHandler: authenticate,
    schema: {
      tags: ['users'],
      summary: 'Delete my avatar',
      security: [{ bearerAuth: [] }],
    },
  }, async (req, reply) => {
    try {
      const user = await deleteUserAvatar(req.userId!);
      return reply.send({ user });
    } catch (err) {
      if (err instanceof UserError) return reply.code(err.status).send({ error: err.message, code: err.code });
      throw err;
    }
  });
}
