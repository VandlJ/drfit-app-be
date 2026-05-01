import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash('test1234', 12);

  const users = [
    { email: 'test1@drfit.app', name: 'Test User One' },
    { email: 'test2@drfit.app', name: 'Test User Two' },
  ];

  for (const u of users) {
    await prisma.user.upsert({
      where: { email: u.email },
      update: {},
      create: {
        email: u.email,
        name: u.name,
        passwordHash,
        creditAccount: {
          create: { balance: 1000 },
        },
      },
    });
  }

  await prisma.user.upsert({
    where: { email: 'admin@fitness.cz' },
    update: { role: 'admin' },
    create: {
      email: 'admin@fitness.cz',
      name: 'Admin',
      passwordHash: await bcrypt.hash('admin1234', 12),
      role: 'admin',
      creditAccount: { create: { balance: 0 } },
    },
  });

  // Create 10 slots across next 7 days (2 per day for first 5 days)
  const slotsTimes = [
    { startTime: '10:00', endTime: '11:00' },
    { startTime: '16:00', endTime: '17:00' },
  ];

  for (let dayOffset = 1; dayOffset <= 5; dayOffset++) {
    const date = new Date();
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() + dayOffset);

    for (const t of slotsTimes) {
      const exists = await prisma.slot.findFirst({
        where: { date, startTime: t.startTime },
      });
      if (!exists) {
        await prisma.slot.create({
          data: {
            date,
            startTime: t.startTime,
            endTime: t.endTime,
            priceCredits: 200,
            isAvailable: true,
          },
        });
      }
    }
  }

  console.log('Seed complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
