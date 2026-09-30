-- CreateTable
CREATE TABLE "login_throttles" (
    "username" TEXT NOT NULL,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "window_started_at" TIMESTAMPTZ NOT NULL,
    "locked_until" TIMESTAMPTZ,

    CONSTRAINT "login_throttles_pkey" PRIMARY KEY ("username")
);
