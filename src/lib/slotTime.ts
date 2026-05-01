/**
 * Combine a Slot date (DateTime @db.Date, stored as YYYY-MM-DD UTC midnight)
 * with a "HH:MM" time string into a full Date in local server time.
 *
 * The fitness center is a single physical location; we treat the time string
 * as wall-clock time in the server's local timezone.
 */
export function slotDateTime(date: Date, time: string): Date {
  const [h, m] = time.split(':').map(Number);
  const d = new Date(date);
  // Prisma returns the @db.Date as midnight UTC. Use UTC y/m/d, apply local hours.
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const day = d.getUTCDate();
  return new Date(year, month, day, h, m, 0, 0);
}

export function generatePin(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}
