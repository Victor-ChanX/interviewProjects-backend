// 可注入时钟：services / workers 不直接 new Date()，而是从 Clock 拿「现在」。
// 为什么：测试里用 vi.useFakeTimers 或假 Clock 控制时间，不写死年月、不真 sleep。

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};
