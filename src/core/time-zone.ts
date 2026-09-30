// 按时区求「今日」起点（工作台概览：后端 #22、#47）。
//
// 工作台的「今日入站 / 出站 / finished / failed」按**查看者所在时区**的自然日算：控制台把浏览器时区作为
// `timeZone` 查询参数传上来，不传按 UTC。写死某个业务时区的话，不在那个时区的人看到的「今日」和他的今天对不上。
//
// 只用标准库 Intl 求时区偏移，不引依赖；不假定固定偏移，有夏令时的时区也按当天零点那一刻的偏移算
// （夏令时恰在零点切换的极端情况不处理）。

/** 不传时区时的「今日」口径 */
export const DEFAULT_TIME_ZONE = "UTC";

/** 是不是运行时认得的时区名（IANA 名，如 Asia/Shanghai、America/New_York） */
export function isTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** instant 在 timeZone 里的挂钟时间，按 UTC 编码成毫秒（即 Date.UTC(当地年, 月, 日, 时, 分, 秒)） */
function wallClockAsUtcMs(instant: Date, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, number> = {};
  for (const p of fmt.formatToParts(instant)) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return Date.UTC(
    parts.year ?? 0,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
}

/** instant 时刻 timeZone 相对 UTC 的偏移（毫秒；东八区为 +8h） */
function offsetMs(instant: Date, timeZone: string): number {
  const wholeSeconds = Math.floor(instant.getTime() / 1000) * 1000;
  return wallClockAsUtcMs(instant, timeZone) - wholeSeconds;
}

/**
 * now 在 timeZone 里所在自然日的起点（该时区当天 00:00 对应的 UTC 时刻）。
 * 「今日」= [startOfDay(now, tz), now]；例：北京时间 07:00 的记录在 UTC 是前一天 23:00，按 Asia/Shanghai 仍算今日。
 */
export function startOfDay(now: Date, timeZone: string): Date {
  const local = wallClockAsUtcMs(now, timeZone);
  const localMidnight =
    local - (((local % 86_400_000) + 86_400_000) % 86_400_000);
  // 先用 now 的偏移估一个零点，再按那个时刻的偏移校正一次（跨夏令时的日子两者不同）
  const guess = localMidnight - offsetMs(now, timeZone);
  return new Date(localMidnight - offsetMs(new Date(guess), timeZone));
}
