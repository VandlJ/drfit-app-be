import cron from 'node-cron';
import { NotificationType, ReservationStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { sendPushNotification } from '../lib/expoPush';
import { slotDateTime } from '../lib/slotTime';

type ActiveReservation = Awaited<ReturnType<typeof loadActiveReservations>>[number];

async function loadActiveReservations() {
  // Look at upcoming/active reservations within the next ~24h to keep query small.
  const horizon = new Date(Date.now() + 36 * 60 * 60 * 1000);
  const horizonDateOnly = new Date(
    Date.UTC(horizon.getUTCFullYear(), horizon.getUTCMonth(), horizon.getUTCDate()),
  );
  return prisma.reservation.findMany({
    where: {
      status: ReservationStatus.ACTIVE,
      slot: { date: { lte: horizonDateOnly } },
    },
    include: {
      slot: true,
      user: { include: { pushTokens: true } },
      sentNotifications: true,
    },
  });
}

async function markSent(reservationId: string, type: NotificationType): Promise<boolean> {
  try {
    await prisma.sentNotification.create({ data: { reservationId, type } });
    return true;
  } catch {
    // unique constraint violation = already sent
    return false;
  }
}

function tokensFor(r: ActiveReservation): string[] {
  return r.user.pushTokens.map((t) => t.token);
}

function alreadySent(r: ActiveReservation, type: NotificationType): boolean {
  return r.sentNotifications.some((s) => s.type === type);
}

async function run60MinReminder(now: number, reservations: ActiveReservation[]) {
  for (const r of reservations) {
    if (alreadySent(r, 'REMINDER_60')) continue;
    const start = slotDateTime(r.slot.date, r.slot.startTime).getTime();
    const minutes = (start - now) / (1000 * 60);
    if (minutes >= 55 && minutes <= 65) {
      const claimed = await markSent(r.id, 'REMINDER_60');
      if (!claimed) continue;
      await sendPushNotification(
        tokensFor(r),
        'Připomenutí',
        'Nezapomeň – máš fitko za hodinu 💪',
        { reservationId: r.id, type: 'REMINDER_60' },
      );
    }
  }
}

async function runPinNotification(now: number, reservations: ActiveReservation[]) {
  for (const r of reservations) {
    if (alreadySent(r, 'PIN_5')) continue;
    const start = slotDateTime(r.slot.date, r.slot.startTime).getTime();
    const minutes = (start - now) / (1000 * 60);
    if (minutes >= 4 && minutes <= 6) {
      const claimed = await markSent(r.id, 'PIN_5');
      if (!claimed) continue;
      await sendPushNotification(
        tokensFor(r),
        'PIN je tady 🔑',
        `Tvůj PIN: ${r.pin} – Hodně zdaru!`,
        { reservationId: r.id, pin: r.pin, type: 'PIN_5' },
      );
    }
  }
}

async function runEndWarning(now: number, reservations: ActiveReservation[]) {
  for (const r of reservations) {
    if (alreadySent(r, 'END_WARNING_10')) continue;
    const end = slotDateTime(r.slot.date, r.slot.endTime).getTime();
    const minutes = (end - now) / (1000 * 60);
    if (minutes >= 9 && minutes <= 11) {
      const claimed = await markSent(r.id, 'END_WARNING_10');
      if (!claimed) continue;
      await sendPushNotification(
        tokensFor(r),
        'Konec slotu se blíží',
        'Za 10 minut ti končí slot, čas se jít převléct 👕',
        { reservationId: r.id, type: 'END_WARNING_10' },
      );
    }
  }
}

async function runMarkCompleted(now: number) {
  const reservations = await prisma.reservation.findMany({
    where: { status: ReservationStatus.ACTIVE },
    include: { slot: true },
  });
  for (const r of reservations) {
    const end = slotDateTime(r.slot.date, r.slot.endTime).getTime();
    if (end <= now) {
      await prisma.reservation.update({
        where: { id: r.id },
        data: { status: ReservationStatus.COMPLETED },
      });
    }
  }
}

let isRunning = false;

export async function tick(): Promise<void> {
  if (isRunning) return;
  isRunning = true;
  try {
    const now = Date.now();
    const reservations = await loadActiveReservations();
    await run60MinReminder(now, reservations);
    await runPinNotification(now, reservations);
    await runEndWarning(now, reservations);
    await runMarkCompleted(now);
  } catch (err) {
    console.error('[notificationJobs] tick failed', err);
  } finally {
    isRunning = false;
  }
}

export function startNotificationJobs(): void {
  cron.schedule('* * * * *', () => {
    void tick();
  });
}
