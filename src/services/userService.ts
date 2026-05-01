import bcrypt from 'bcrypt';
import { promises as fs } from 'fs';
import path from 'path';
import sharp from 'sharp';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { config } from '../lib/config';

export class UserError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

const AVATAR_SIZE = 512;
const AVATAR_FORMAT = 'webp';
const AVATAR_DIR = 'avatars';

function avatarFileName(userId: string) {
  return `${userId}.${AVATAR_FORMAT}`;
}

function avatarFsPath(userId: string) {
  return path.join(config.uploadsDir, AVATAR_DIR, avatarFileName(userId));
}

function avatarPublicUrl(userId: string, version: number) {
  // Cache-busting via ?v= so client refetches after upload.
  return `${config.publicBaseUrl}/uploads/${AVATAR_DIR}/${avatarFileName(userId)}?v=${version}`;
}

export function publicUserShape(u: {
  id: string;
  email: string;
  name: string;
  role: string;
  defaultCenterId: string | null;
  dateOfBirth: Date | null;
  avatarUrl: string | null;
  createdAt: Date;
}) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    defaultCenterId: u.defaultCenterId,
    dateOfBirth: u.dateOfBirth ? u.dateOfBirth.toISOString().slice(0, 10) : null,
    avatarUrl: u.avatarUrl,
    createdAt: u.createdAt,
  };
}

export async function getUserProfile(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new UserError(404, 'USER_NOT_FOUND', 'User not found');
  return publicUserShape(user);
}

export interface UpdateProfileInput {
  name?: string;
  email?: string;
  defaultCenterId?: string | null;
  dateOfBirth?: string | null; // YYYY-MM-DD or null to clear
}

export async function updateUserProfile(userId: string, input: UpdateProfileInput) {
  const data: Prisma.UserUpdateInput = {};

  if (input.name !== undefined) {
    const trimmed = input.name.trim();
    if (trimmed.length < 1) throw new UserError(400, 'INVALID_NAME', 'Name must not be empty');
    data.name = trimmed;
  }

  if (input.email !== undefined) {
    const email = input.email.trim().toLowerCase();
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing && existing.id !== userId) {
      throw new UserError(409, 'EMAIL_TAKEN', 'Email already in use');
    }
    data.email = email;
  }

  if (input.defaultCenterId !== undefined) {
    if (input.defaultCenterId === null) {
      data.defaultCenter = { disconnect: true };
    } else {
      const center = await prisma.fitnessCenter.findUnique({
        where: { id: input.defaultCenterId },
      });
      if (!center || !center.isActive) {
        throw new UserError(404, 'CENTER_NOT_FOUND', 'Fitness center not found');
      }
      data.defaultCenter = { connect: { id: input.defaultCenterId } };
    }
  }

  if (input.dateOfBirth !== undefined) {
    if (input.dateOfBirth === null) {
      data.dateOfBirth = null;
    } else {
      const d = new Date(`${input.dateOfBirth}T00:00:00.000Z`);
      if (Number.isNaN(d.getTime())) {
        throw new UserError(400, 'INVALID_DATE', 'dateOfBirth must be YYYY-MM-DD');
      }
      const now = new Date();
      if (d.getTime() > now.getTime()) {
        throw new UserError(400, 'INVALID_DATE', 'dateOfBirth cannot be in the future');
      }
      data.dateOfBirth = d;
    }
  }

  const updated = await prisma.user.update({ where: { id: userId }, data });
  return publicUserShape(updated);
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
) {
  if (newPassword.length < 8) {
    throw new UserError(400, 'WEAK_PASSWORD', 'New password must be at least 8 characters');
  }
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new UserError(404, 'USER_NOT_FOUND', 'User not found');

  const ok = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!ok) throw new UserError(401, 'INVALID_CURRENT_PASSWORD', 'Current password is incorrect');

  const passwordHash = await bcrypt.hash(newPassword, 12);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash } });

  // Invalidate all existing refresh tokens for this user.
  await prisma.refreshToken.deleteMany({ where: { userId } });
}

export async function setUserAvatar(userId: string, buffer: Buffer) {
  const dir = path.join(config.uploadsDir, AVATAR_DIR);
  await fs.mkdir(dir, { recursive: true });

  const outPath = avatarFsPath(userId);
  await sharp(buffer)
    .rotate() // honor EXIF orientation
    .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover', position: 'centre' })
    .webp({ quality: 85 })
    .toFile(outPath);

  const url = avatarPublicUrl(userId, Date.now());
  const updated = await prisma.user.update({
    where: { id: userId },
    data: { avatarUrl: url },
  });
  return publicUserShape(updated);
}

export async function deleteUserAvatar(userId: string) {
  const outPath = avatarFsPath(userId);
  await fs.rm(outPath, { force: true });
  const updated = await prisma.user.update({
    where: { id: userId },
    data: { avatarUrl: null },
  });
  return publicUserShape(updated);
}
