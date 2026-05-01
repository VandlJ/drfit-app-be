import 'dotenv/config';

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: required('JWT_SECRET'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '15m',
  refreshTokenExpiresDays: Number(process.env.REFRESH_TOKEN_EXPIRES_DAYS ?? 30),
  stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
  adminSecret: required('ADMIN_SECRET', 'change-me'),
  cancellationPolicyHours: Number(process.env.CANCELLATION_POLICY_HOURS ?? 2),
  cancellationRefundPercent: Number(process.env.CANCELLATION_REFUND_PERCENT ?? 100),
};

export const PACKAGES = [
  { id: 'starter', credits: 500, bonusCredits: 0, priceKc: 500 },
  { id: 'standard', credits: 1000, bonusCredits: 0, priceKc: 1000 },
  { id: 'premium', credits: 2000, bonusCredits: 200, priceKc: 2000 },
  { id: 'pro', credits: 5000, bonusCredits: 750, priceKc: 5000 },
] as const;

export type PackageId = (typeof PACKAGES)[number]['id'];
