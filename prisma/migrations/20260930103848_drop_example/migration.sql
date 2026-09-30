-- #6：删掉脚手架自带的 Example 示例资源（路由 / service / schema / 测试一并删除），
-- 表从未被任何业务表引用（project map：被引用 = 无），也没有种子往里写；DROP 是预期行为。

/*
  Warnings:

  - You are about to drop the `examples` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
DROP TABLE "examples";

-- DropEnum
DROP TYPE "example_status";
