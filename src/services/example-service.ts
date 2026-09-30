// 业务逻辑 + 数据访问（Prisma）。拒绝一律 throw src/core/errors 的领域异常，
// 不 import fastify / src/api（eslint no-restricted-imports 守着）。
// 需要 FOR UPDATE SKIP LOCKED / 部分唯一索引这类 Prisma 查询 API 表达不了的东西时，
// 用 db.$queryRaw / db.$transaction；唯一冲突判 Prisma.PrismaClientKnownRequestError 的 code === "P2002"。
import { Conflict, NotFound } from "../core/errors.js";
import { getDb } from "../db/client.js";
import { Prisma, type Example } from "../db/generated/client.js";
import type { ExampleRead } from "../schemas/example.js";

function toRead(row: Example): ExampleRead {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listExamples(input: {
  page: number;
  pageSize: number;
}): Promise<{
  items: ExampleRead[];
  total: number;
  page: number;
  pageSize: number;
}> {
  const db = getDb();
  const skip = (input.page - 1) * input.pageSize;
  const [rows, total] = await Promise.all([
    db.example.findMany({
      orderBy: { id: "asc" },
      take: input.pageSize,
      skip,
    }),
    db.example.count(),
  ]);
  return {
    items: rows.map(toRead),
    total,
    page: input.page,
    pageSize: input.pageSize,
  };
}

export async function getExample(id: number): Promise<ExampleRead> {
  const db = getDb();
  const row = await db.example.findUnique({ where: { id } });
  if (!row) {
    throw new NotFound("EXAMPLE_NOT_FOUND", `示例 ${id} 不存在`, { id });
  }
  return toRead(row);
}

export async function createExample(input: {
  name: string;
}): Promise<ExampleRead> {
  const db = getDb();
  // 不先查再插：并发下两次「查无 → 插入」都会通过；靠唯一约束兜底，把 P2002 翻译成 409。
  try {
    const row = await db.example.create({ data: { name: input.name } });
    return toRead(row);
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      throw new Conflict(
        "EXAMPLE_NAME_TAKEN",
        `名称「${input.name}」已被使用`,
        { name: input.name },
      );
    }
    throw err;
  }
}

/** 给 worker 的 tick 用：统计当前活跃条数（示例性质） */
export async function countActiveExamples(): Promise<number> {
  const db = getDb();
  return db.example.count({ where: { status: "active" } });
}
