/*
  Warnings:

  - Added the required column `centerId` to the `Slot` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Slot" ADD COLUMN     "centerId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "defaultCenterId" TEXT;

-- CreateTable
CREATE TABLE "FitnessCenter" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "description" TEXT,
    "imageUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FitnessCenter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Slot_centerId_idx" ON "Slot"("centerId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_defaultCenterId_fkey" FOREIGN KEY ("defaultCenterId") REFERENCES "FitnessCenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Slot" ADD CONSTRAINT "Slot_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "FitnessCenter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
