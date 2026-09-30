-- #22 异常中心：记录谁把一条不一致标记为已处理。可空列，存量行保持 null（未处理 / 历史上无人记录），无需回填。
-- AlterTable
ALTER TABLE "inconsistencies" ADD COLUMN     "resolved_by" TEXT;
