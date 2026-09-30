// 异常中心（#22；题目 A2「写库失败 … 推 inconsistency 事件，让操作员看到」）。
//
// 不一致记录由各写入方落库（src/services/inbound-service.ts、src/services/group-job-service.ts，同一事务里推
// ws inconsistency），这里只负责「看」与「标记已处理」：
// - 列表：keyset 游标分页 { items, nextCursor }，排序键 (createdAt desc, id desc)，可按 resolved 筛；不带 payload。
// - 详情：带 payload（事件原文 / 对账差集）。不存在 → 404 INCONSISTENCY_NOT_FOUND。
// - resolve：置 resolvedAt + resolvedBy（登录用户名），同一事务里推 ws inconsistency_resolved。
//   幂等：条件更新 `WHERE id = ? AND resolved_at IS NULL`，只有真正从未处理变成已处理的那一次写库、推事件；
//   已处理的再 resolve 返回 200 与原记录（resolvedAt / resolvedBy 保持第一次的值），不是 409 ——
//   前端重试、两个人同时点「已处理」都是同一个意图，结果一致即可。并发两次只有一次 count = 1。
//
// 数据范围：只有 admin / viewer 两种角色，登录用户都看全部记录；写入口（resolve）由路由挂 requireRole("admin")。
import type { Clock } from "../core/clock.js";
import { systemClock } from "../core/clock.js";
import { NotFound } from "../core/errors.js";
import { getDb } from "../db/client.js";
import type { Inconsistency, Prisma } from "../db/generated/client.js";
import type {
  InconsistencyDetail,
  InconsistencyPage,
  InconsistencyRead,
} from "../schemas/inconsistency.js";
import {
  clampLimit,
  decodeTimeCursor,
  encodeTimeCursor,
  sliceCursorPage,
} from "./cursor.js";
import { emitWsEvent } from "./ws-events.js";

export type ListInconsistenciesOptions = {
  /** true = 只看已处理，false = 只看未处理，不给 = 全部 */
  resolved?: boolean;
  before?: string;
  limit?: number;
};

export function toInconsistencyRead(row: Inconsistency): InconsistencyRead {
  return {
    id: row.id,
    kind: row.kind,
    ref: row.ref,
    message: row.message,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolvedBy: row.resolvedBy,
  };
}

/** payload 列是任意 JSON；写入方都写对象，万一不是对象就包一层 { value }，内容不丢 */
function payloadOf(row: Inconsistency): Record<string, unknown> | null {
  const p = row.payload;
  if (p === null) return null;
  if (typeof p === "object" && !Array.isArray(p)) {
    return p;
  }
  return { value: p };
}

function notFound(id: string): NotFound {
  return new NotFound("INCONSISTENCY_NOT_FOUND", "该异常记录不存在", {
    inconsistencyId: id,
  });
}

export async function listInconsistencies(
  opts: ListInconsistenciesOptions = {},
): Promise<InconsistencyPage> {
  const limit = clampLimit(opts.limit);
  const cursor =
    opts.before === undefined ? null : decodeTimeCursor(opts.before);
  const where: Prisma.InconsistencyWhereInput = {
    ...(opts.resolved === undefined
      ? {}
      : { resolvedAt: opts.resolved ? { not: null } : null }),
    ...(cursor
      ? {
          OR: [
            { createdAt: { lt: cursor.at } },
            { createdAt: cursor.at, id: { lt: cursor.id } },
          ],
        }
      : {}),
  };
  const rows = await getDb().inconsistency.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const { page, nextCursor } = sliceCursorPage(rows, limit, (last) =>
    encodeTimeCursor({ at: last.createdAt, id: last.id }),
  );
  return { items: page.map(toInconsistencyRead), nextCursor };
}

export async function getInconsistency(
  id: string,
): Promise<InconsistencyDetail> {
  const row = await getDb().inconsistency.findUnique({ where: { id } });
  if (!row) throw notFound(id);
  return { ...toInconsistencyRead(row), payload: payloadOf(row) };
}

export type ResolveInconsistencyDeps = { clock?: Clock };

/**
 * 标记已处理（幂等，见文件头）。resolvedBy 记登录用户名：控制台直接显示，不用再关联 users。
 * 返回记录的当前状态；不存在 → 404 INCONSISTENCY_NOT_FOUND。
 */
export async function resolveInconsistency(
  id: string,
  resolvedBy: string,
  deps: ResolveInconsistencyDeps = {},
): Promise<InconsistencyRead> {
  const now = (deps.clock ?? systemClock).now();
  const row = await getDb().$transaction(async (tx) => {
    const { count } = await tx.inconsistency.updateMany({
      where: { id, resolvedAt: null },
      data: { resolvedAt: now, resolvedBy },
    });
    if (count === 1) {
      await emitWsEvent(tx, "inconsistency_resolved", {
        id,
        resolvedAt: now.toISOString(),
        resolvedBy,
      });
    }
    return tx.inconsistency.findUnique({ where: { id } });
  });
  if (!row) throw notFound(id);
  return toInconsistencyRead(row);
}
