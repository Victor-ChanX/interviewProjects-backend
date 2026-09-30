-- CreateEnum
CREATE TYPE "example_status" AS ENUM ('active', 'archived');

-- CreateTable
CREATE TABLE "examples" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "status" "example_status" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "examples_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "examples_name_key" ON "examples"("name");
