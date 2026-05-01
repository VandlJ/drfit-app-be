import Stripe from 'stripe';
import { prisma } from '../lib/prisma';
import { ensureStripe } from '../lib/stripe';
import { PACKAGES, PackageId, config } from '../lib/config';

export class CreditsError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export async function getBalance(userId: string): Promise<number> {
  const account = await prisma.creditAccount.findUnique({ where: { userId } });
  return account?.balance ?? 0;
}

export async function getHistory(userId: string, limit: number, offset: number) {
  const account = await prisma.creditAccount.findUnique({ where: { userId } });
  if (!account) return [];
  return prisma.creditTransaction.findMany({
    where: { creditAccountId: account.id },
    orderBy: { createdAt: 'desc' },
    take: limit,
    skip: offset,
  });
}

export function findPackage(packageId: string) {
  return PACKAGES.find((p) => p.id === packageId);
}

export async function createTopupIntent(userId: string, packageId: string) {
  const pkg = findPackage(packageId);
  if (!pkg) {
    throw new CreditsError(400, 'INVALID_PACKAGE', 'Unknown package');
  }
  const stripe = ensureStripe();
  const intent = await stripe.paymentIntents.create({
    amount: pkg.priceKc * 100, // haléře
    currency: 'czk',
    automatic_payment_methods: { enabled: true },
    metadata: {
      userId,
      packageId: pkg.id,
    },
  });
  return { clientSecret: intent.client_secret };
}

/**
 * Apply a successful payment to a user's credit account.
 * Idempotent: skips if a TOPUP transaction with the same referenceId exists.
 */
export async function applyPaymentSuccess(intent: Stripe.PaymentIntent) {
  const userId = intent.metadata?.userId;
  const packageId = intent.metadata?.packageId as PackageId | undefined;
  if (!userId || !packageId) {
    throw new CreditsError(400, 'INVALID_INTENT', 'PaymentIntent metadata missing');
  }
  const pkg = findPackage(packageId);
  if (!pkg) {
    throw new CreditsError(400, 'INVALID_PACKAGE', 'Unknown package in metadata');
  }
  const account = await prisma.creditAccount.findUnique({ where: { userId } });
  if (!account) {
    throw new CreditsError(404, 'NO_CREDIT_ACCOUNT', 'Credit account not found');
  }

  const existing = await prisma.creditTransaction.findFirst({
    where: { referenceId: intent.id, type: 'TOPUP' },
  });
  if (existing) return; // already applied

  await prisma.$transaction(async (tx) => {
    await tx.creditAccount.update({
      where: { id: account.id },
      data: { balance: { increment: pkg.credits } },
    });
    await tx.creditTransaction.create({
      data: {
        creditAccountId: account.id,
        amount: pkg.credits,
        type: 'TOPUP',
        referenceId: intent.id,
        description: `Top-up balíček ${pkg.id} (${pkg.credits} kreditů)`,
      },
    });

    if (pkg.bonusCredits > 0) {
      await tx.creditAccount.update({
        where: { id: account.id },
        data: { balance: { increment: pkg.bonusCredits } },
      });
      await tx.creditTransaction.create({
        data: {
          creditAccountId: account.id,
          amount: pkg.bonusCredits,
          type: 'BONUS',
          referenceId: intent.id,
          description: `Bonusové kredity k balíčku ${pkg.id}`,
        },
      });
    }
  });
}
