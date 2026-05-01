import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash('test1234', 12);

  // Centers
  const center1 = await prisma.fitnessCenter.upsert({
    where: { id: 'seed-center-1' },
    update: {},
    create: {
      id: 'seed-center-1',
      name: 'Fitness Plzeň Centrum',
      address: 'Náměstí Republiky 1, Plzeň',
      description: 'Privátní fitness centrum v centru města.',
      isActive: true,
    },
  });

  await prisma.fitnessCenter.upsert({
    where: { id: 'seed-center-2' },
    update: {},
    create: {
      id: 'seed-center-2',
      name: 'Fitness Plzeň Slovany',
      address: 'Slovanská alej 5, Plzeň',
      description: 'Druhá pobočka na Slovanech.',
      isActive: true,
    },
  });

  // Test users
  const users = [
    { email: 'test1@drfit.app', name: 'Test User One' },
    { email: 'test2@drfit.app', name: 'Test User Two' },
  ];

  for (const u of users) {
    await prisma.user.upsert({
      where: { email: u.email },
      update: { defaultCenterId: center1.id },
      create: {
        email: u.email,
        name: u.name,
        passwordHash,
        defaultCenterId: center1.id,
        creditAccount: { create: { balance: 1000 } },
      },
    });
  }

  // Admin user
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

  // Slots – associate with center1
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
        where: { date, startTime: t.startTime, centerId: center1.id },
      });
      if (!exists) {
        await prisma.slot.create({
          data: {
            date,
            startTime: t.startTime,
            endTime: t.endTime,
            priceCredits: 200,
            isAvailable: true,
            centerId: center1.id,
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
