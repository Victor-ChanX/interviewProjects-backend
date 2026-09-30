// 业务时区与「今日」口径（#22 工作台概览）。
//
// 工作台的「今日入站 / 出站 / finished / failed」按运营所在地的自然日算，不按 UTC 日 ——
// 按 UTC 算的话北京时间 00:00–08:00 的记录会被算进「昨天」，早班看到的数整整少了 8 小时。
// 常量放 core：service 与测试从同一处取（测试造「今日边界」的数据要与被测代码同一口径，不在测试里复制一份）。
//
// 只用标准库 Intl 求时区偏移，不引依赖；Asia/Shanghai 当前无夏令时，但实现不假定固定 +08:00，
// 换成有夏令时的时区也按当天零点那一刻的偏移算（夏令时恰在零点切换的极端情况不处理）。

/** 业务时区（IANA 名）：工作台「今日」的自然日边界按它算 */
export const BUSINESS_TIME_ZONE = "Asia/Shanghai";

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
 * now 所在的业务自然日的起点（该时区当天 00:00 对应的 UTC 时刻）。
 * 「今日」= [startOfBusinessDay(now), now]；例：北京时间 07:00 的记录在 UTC 是前一天 23:00，仍算今日。
 */
export function startOfBusinessDay(
  now: Date,
  timeZone: string = BUSINESS_TIME_ZONE,
): Date {
  const local = wallClockAsUtcMs(now, timeZone);
  const localMidnight =
    local - (((local % 86_400_000) + 86_400_000) % 86_400_000);
  // 先用 now 的偏移估一个零点，再按那个时刻的偏移校正一次（跨夏令时的日子两者不同）
  const guess = localMidnight - offsetMs(now, timeZone);
  return new Date(localMidnight - offsetMs(new Date(guess), timeZone));
}
