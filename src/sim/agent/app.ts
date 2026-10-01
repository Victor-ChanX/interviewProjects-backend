// Agent 服务模拟器（题目 2.2）：buildAgentApp(opts) 返回一个独立的 Fastify 实例。
//
// 端点：
//   POST /agent/turn      tool-use 协议的一轮（tools 校验 → 按 runId 会话 → 剧本决定响应）
//   POST /agent/audit     审计（按 groupId 剧本决定 pass / fail / 坏行为）
//   POST /_sim/scenario   设置剧本（某 runId / groupId 或默认），DSL 见 scenario.ts
//   POST /_sim/reset      清空会话、剧本、审计记录
//   GET  /_sim/state      每个 runId 的 messages 历史与轮次、审计调用记录（供应用侧测试断言）
//   GET  /health
//
// 不 import 应用的 src/db / src/services：模拟器是外部服务，只依赖 src/core 的 Clock 类型。
// 延迟与「永不返回」通过可注入的 sleep 与 app 关闭信号实现，测试里不真睡。
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { z } from "zod";

import { systemClock, type Clock } from "../../core/clock.js";
import { beginAudit } from "./audit.js";
import {
  ScenarioRequest,
  type AuditScenario,
  type TurnScenario,
} from "./scenario.js";
import { SimState, beginTurn, validateTools } from "./turn.js";

export type AgentAppOptions = {
  /** false 给测试用 */
  logger?: boolean;
  /** receivedAt 用的时钟；测试注入假时钟 */
  clock?: Clock;
  /** 慢响应的等待实现；测试注入可控的假 sleep，不真等 */
  sleep?: (ms: number) => Promise<void>;
};

type SimErrorCode = "TOOLS_INVALID" | "VALIDATION_ERROR" | "INTERNAL";

/** 模拟器自己的错误信封，形状与应用一致：{ error: { code, message, requestId, ...extra } } */
class SimError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: SimErrorCode,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "SimError";
  }
}

const Block = z.looseObject({ type: z.string() });
const TurnRequest = z.looseObject({
  runId: z.string().min(1),
  tools: z.unknown(),
  messages: z.array(
    z.looseObject({
      role: z.enum(["user", "assistant"]),
      content: z.array(Block),
    }),
  ),
});

const AuditRequest = z.looseObject({
  text: z.string(),
  groupId: z.string().min(1),
});

const StateQuery = z.object({ runId: z.string().min(1).optional() });

const issuesOf = (error: z.ZodError): { path: string; message: string }[] =>
  error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));

export async function buildAgentApp(
  opts: AgentAppOptions = {},
): Promise<FastifyInstance> {
  const clock = opts.clock ?? systemClock;
  const sleep =
    opts.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const state = new SimState();

  // hang 步骤等这个 promise：app 关闭时才放行（真服务里 = 永不返回）
  let releaseHung = (): void => {};
  const closed = new Promise<void>((resolve) => {
    releaseHung = resolve;
  });

  const app = Fastify({
    logger: opts.logger !== false,
    exposeHeadRoutes: false,
    // 请求里可能带触发消息的图片（后端 #61，base64），默认 1 MB 不够
    bodyLimit: 16 * 1024 * 1024,
    // 关闭时掐断挂起的连接（hang 步骤会让请求永远不结束）
    forceCloseConnections: true,
  });
  app.addHook("onClose", async () => {
    releaseHung();
  });

  app.setErrorHandler((err, req, reply) => {
    const requestId = req.id;
    if (err instanceof SimError) {
      void reply.code(err.statusCode).send({
        error: {
          ...err.extra,
          code: err.code,
          message: err.message,
          requestId,
        },
      });
      return;
    }
    // Fastify 自己的错误（JSON 体解析失败等）带 statusCode；其余当 500
    const known = err as { statusCode?: unknown; message?: unknown };
    const statusCode =
      typeof known.statusCode === "number" && known.statusCode >= 400
        ? known.statusCode
        : 500;
    if (statusCode >= 500) {
      req.log.error({ err, requestId }, "模拟器未处理的异常");
    }
    void reply.code(statusCode).send({
      error: {
        code: statusCode >= 500 ? "INTERNAL" : "VALIDATION_ERROR",
        message:
          statusCode >= 500 || typeof known.message !== "string"
            ? "模拟器内部错误"
            : known.message,
        requestId,
      },
    });
  });

  /** 按记录的 hang / delayMs 等待，再原样发出渲染好的响应 */
  const respond = async (
    reply: FastifyReply,
    record: {
      hang: boolean;
      delayMs: number;
      responded: boolean;
      response: { status: number; contentType: string; body: string } | null;
    },
  ): Promise<string> => {
    if (record.hang) {
      await closed;
      record.responded = true;
      void reply.code(503);
      return "";
    }
    if (record.delayMs > 0) await sleep(record.delayMs);
    record.responded = true;
    const response = record.response;
    if (!response)
      throw new SimError(500, "INTERNAL", "剧本步骤没有渲染出响应");
    void reply
      .code(response.status)
      .header("content-type", response.contentType);
    return response.body;
  };

  app.get("/health", async () => ({ status: "ok" }));

  app.post("/agent/turn", async (req, reply) => {
    const parsed = TurnRequest.safeParse(req.body);
    if (!parsed.success) {
      throw new SimError(400, "VALIDATION_ERROR", "请求体不合法", {
        issues: issuesOf(parsed.error),
      });
    }
    const { runId, tools, messages } = parsed.data;
    const issues = validateTools(tools);
    if (issues.length > 0) {
      throw new SimError(
        400,
        "TOOLS_INVALID",
        "tools 必须恰好是题目规定的 4 个工具，且 input_schema 合法、required 覆盖全部入参",
        { issues },
      );
    }
    const { record, step } = beginTurn(state, clock, runId, messages);
    req.log.info(
      {
        runId,
        turn: record.turn,
        kind: step.type,
        delayMs: record.delayMs,
        hang: record.hang,
      },
      "agent turn",
    );
    return respond(reply, record);
  });

  app.post("/agent/audit", async (req, reply) => {
    const parsed = AuditRequest.safeParse(req.body);
    if (!parsed.success) {
      throw new SimError(400, "VALIDATION_ERROR", "请求体不合法", {
        issues: issuesOf(parsed.error),
      });
    }
    const { text, groupId } = parsed.data;
    const { record, step } = beginAudit(state, clock, groupId, text);
    req.log.info(
      {
        groupId,
        seq: record.seq,
        mode: step.mode,
        delayMs: record.delayMs,
        hang: record.hang,
      },
      "agent audit",
    );
    return respond(reply, record);
  });

  app.post("/_sim/scenario", async (req) => {
    const parsed = ScenarioRequest.safeParse(req.body);
    if (!parsed.success) {
      throw new SimError(400, "VALIDATION_ERROR", "剧本不合法", {
        issues: issuesOf(parsed.error),
      });
    }
    const { runId, groupId, turn, audit } = parsed.data;
    const result: {
      ok: true;
      turn?: { runId: string | null; scenario: TurnScenario };
      audit?: { groupId: string | null; scenario: AuditScenario };
    } = { ok: true };
    if (turn) {
      if (runId) state.turnByRun.set(runId, turn);
      else state.turnDefault = turn;
      result.turn = { runId: runId ?? null, scenario: turn };
    }
    if (audit) {
      if (groupId) {
        state.auditByGroup.set(groupId, audit);
        state.auditCallsByGroup.delete(groupId);
      } else {
        state.auditDefault = audit;
        state.auditDefaultCalls = 0;
      }
      result.audit = { groupId: groupId ?? null, scenario: audit };
    }
    return result;
  });

  app.post("/_sim/reset", async () => {
    state.reset();
    return { ok: true };
  });

  app.get("/_sim/state", async (req) => {
    const query = StateQuery.safeParse(req.query);
    if (!query.success) {
      throw new SimError(400, "VALIDATION_ERROR", "查询参数不合法", {
        issues: issuesOf(query.error),
      });
    }
    const runs = [...state.runs.values()].filter(
      (run) => query.data.runId === undefined || run.runId === query.data.runId,
    );
    return {
      runs: runs.map((run) => ({
        runId: run.runId,
        turns: run.turns,
        toolUseIds: run.toolUseIds,
        sendKeys: run.sendKeys,
        seenToolResults: run.seenToolResults,
        pending: run.requests.filter((r) => !r.responded).length,
        requests: run.requests,
      })),
      audits: state.audits,
      scenarios: {
        turnDefault: state.turnDefault,
        turnByRun: Object.fromEntries(state.turnByRun),
        auditDefault: state.auditDefault,
        auditByGroup: Object.fromEntries(state.auditByGroup),
      },
    };
  });

  return app;
}
