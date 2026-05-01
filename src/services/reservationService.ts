import { Prisma, ReservationStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { generatePin, slotDateTime } from '../lib/slotTime';
import { config } from '../lib/config';

export class ReservationError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export async function createReservation(userId: string, slotId: string) {
  return prisma.$transaction(async (tx) => {
    const slot = await tx.slot.findUnique({
      where: { id: slotId },
      include: { reservation: true },
    });
    if (!slot) {
      throw new ReservationError(404, 'SLOT_NOT_FOUND', 'Slot not found');
    }
    if (!slot.isAvailable || slot.reservation) {
      throw new ReservationError(409, 'SLOT_UNAVAILABLE', 'Slot is no longer available');
    }
    const start = slotDateTime(slot.date, slot.startTime);
    if (start.getTime() <= Date.now()) {
      throw new ReservationError(400, 'SLOT_IN_PAST', 'Slot is in the past');
    }

    const account = await tx.creditAccount.findUnique({ where: { userId } });
    if (!account) {
      throw new ReservationError(404, 'NO_CREDIT_ACCOUNT', 'Credit account not found');
    }
    if (account.balance < slot.priceCredits) {
      throw new ReservationError(402, 'INSUFFICIENT_CREDITS', 'Not enough credits');
    }

    const pin = generatePin();

    const reservation = await tx.reservation.create({
      data: {
        userId,
        slotId,
        pin,
        creditsSpent: slot.priceCredits,
        status: ReservationStatus.ACTIVE,
      },
    });

    await tx.creditAccount.update({
      where: { id: account.id },
      data: { balance: { decrement: slot.priceCredits } },
    });

    await tx.creditTransaction.create({
      data: {
        creditAccountId: account.id,
        amount: -slot.priceCredits,
        type: 'SPEND',
        referenceId: reservation.id,
        description: `Rezervace slotu ${slot.startTime}-${slot.endTime}`,
      },
    });

    await tx.slot.update({
      where: { id: slot.id },
      data: { isAvailable: false },
    });

    return reservation;
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  });
}

export async function listReservationsForUser(userId: string) {
  const reservations = await prisma.reservation.findMany({
    where: { userId },
    include: { slot: true },
  });

  // Sort: ACTIVE first by slot date ASC, then COMPLETED/CANCELLED by date DESC
  reservations.sort((a, b) => {
    const aActive = a.status === 'ACTIVE';
    const bActive = b.status === 'ACTIVE';
    if (aActive && !bActive) return -1;
    if (!aActive && bActive) return 1;

    const aTime = slotDateTime(a.slot.date, a.slot.startTime).getTime();
    const bTime = slotDateTime(b.slot.date, b.slot.startTime).getTime();
    if (aActive && bActive) return aTime - bTime;
    return bTime - aTime;
  });

  return reservations;
}

export async function cancelReservation(userId: string, reservationId: string) {
  return prisma.$transaction(async (tx) => {
    const reservation = await tx.reservation.findUnique({
      where: { id: reservationId },
      include: { slot: true },
    });
    if (!reservation || reservation.userId !== userId) {
      throw new ReservationError(404, 'RESERVATION_NOT_FOUND', 'Reservation not found');
    }
    if (reservation.status !== 'ACTIVE') {
      throw new ReservationError(409, 'RESERVATION_NOT_ACTIVE', 'Reservation is not active');
    }

    const start = slotDateTime(reservation.slot.date, reservation.slot.startTime);
    const hoursUntil = (start.getTime() - Date.now()) / (1000 * 60 * 60);

    // Cancellations made earlier than CANCELLATION_POLICY_HOURS before slot start
    // get a full refund. Cancellations within that window get CANCELLATION_REFUND_PERCENT.
    const refundPercent =
      hoursUntil >= config.cancellationPolicyHours ? 100 : config.cancellationRefundPercent;

    const refund = Math.floor((reservation.creditsSpent * refundPercent) / 100);

    await tx.reservation.update({
      where: { id: reservation.id },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });

    if (refund > 0) {
      const account = await tx.creditAccount.findUnique({ where: { userId } });
      if (account) {
        await tx.creditAccount.update({
          where: { id: account.id },
          data: { balance: { increment: refund } },
        });
        await tx.creditTransaction.create({
          data: {
            creditAccountId: account.id,
            amount: refund,
            type: 'REFUND',
            referenceId: reservation.id,
            description: `Vrácení kreditů (${refundPercent}%) za zrušenou rezervaci`,
          },
        });
      }
    }

    await tx.slot.update({
      where: { id: reservation.slotId },
      data: { isAvailable: true },
    });

    return { refundedCredits: refund };
  });
}

export async function getReservationPin(userId: string, reservationId: string) {
  const reservation = await prisma.reservation.findUnique({
    where: { id: reservationId },
    include: { slot: true },
  });
  if (!reservation || reservation.userId !== userId) {
    throw new ReservationError(404, 'RESERVATION_NOT_FOUND', 'Reservation not found');
  }
  if (reservation.status !== 'ACTIVE') {
    throw new ReservationError(409, 'RESERVATION_NOT_ACTIVE', 'Reservation is not active');
  }

  const start = slotDateTime(reservation.slot.date, reservation.slot.startTime);
  const end = slotDateTime(reservation.slot.date, reservation.slot.endTime);
  const now = Date.now();
  const minutesUntilStart = (start.getTime() - now) / (1000 * 60);

  const withinWindow = minutesUntilStart <= 30 && now < end.getTime();

  if (!withinWindow) {
    if (now >= end.getTime()) {
      throw new ReservationError(403, 'PIN_EXPIRED', 'PIN no longer available');
    }
    throw new ReservationError(403, 'PIN_TOO_EARLY', 'PIN not available yet');
  }

  return { pin: reservation.pin };
}
