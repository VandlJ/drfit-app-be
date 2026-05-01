import Stripe from 'stripe';
import { config } from './config';

export const stripe = config.stripeSecretKey
  ? new Stripe(config.stripeSecretKey, { apiVersion: '2024-10-28.acacia' as Stripe.LatestApiVersion })
  : (null as unknown as Stripe);

export function ensureStripe(): Stripe {
  if (!config.stripeSecretKey) {
    throw new Error('Stripe is not configured (STRIPE_SECRET_KEY missing)');
  }
  return stripe;
}
