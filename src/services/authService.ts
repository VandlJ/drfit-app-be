import bcrypt from 'bcrypt';
import { prisma } from '../lib/prisma';
import {
  generateRefreshToken,
  refreshTokenExpiryDate,
  signAccessToken,
} from '../lib/jwt';
import { publicUserShape } from './userService';

export class AuthError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export async function registerUser(email: string, password: string, name: string) {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new AuthError(409, 'EMAIL_TAKEN', 'Email already in use');
  }
  const passwordHash = await bcrypt.hash(password, 12);
  const user = await prisma.user.create({
    data: {
      email,
      name,
      passwordHash,
      creditAccount: { create: { balance: 0 } },
    },
  });
  return issueTokens(user);
}

export async function loginUser(email: string, password: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    throw new AuthError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    throw new AuthError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  }
  return issueTokens(user);
}

async function issueTokens(user: {
  id: string;
  email: string;
  name: string;
  role: string;
  defaultCenterId: string | null;
  dateOfBirth: Date | null;
  avatarUrl: string | null;
  createdAt: Date;
}) {
  const accessToken = signAccessToken({ sub: user.id, email: user.email, role: user.role });
  const refreshToken = generateRefreshToken();
  await prisma.refreshToken.create({
    data: {
      token: refreshToken,
      userId: user.id,
      expiresAt: refreshTokenExpiryDate(),
    },
  });
  return {
    accessToken,
    refreshToken,
    user: publicUserShape(user),
  };
}

export async function refreshAccessToken(refreshToken: string) {
  const stored = await prisma.refreshToken.findUnique({
    where: { token: refreshToken },
    include: { user: true },
  });
  if (!stored) {
    throw new AuthError(401, 'INVALID_REFRESH_TOKEN', 'Invalid refresh token');
  }
  if (stored.expiresAt < new Date()) {
    await prisma.refreshToken.delete({ where: { id: stored.id } }).catch(() => {});
    throw new AuthError(401, 'REFRESH_TOKEN_EXPIRED', 'Refresh token expired');
  }
  const accessToken = signAccessToken({
    sub: stored.user.id,
    email: stored.user.email,
    role: stored.user.role,
  });
  return { accessToken };
}

export async function logoutUser(refreshToken: string) {
  await prisma.refreshToken
    .delete({ where: { token: refreshToken } })
    .catch(() => undefined);
}
