import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

// 结构地图的告警报告里 —— 报告里多一行不会挡住任何人，规则等于建议。
//
// 结构地图与这里的分工：地图做 lint 表达不了的分析（端点有没有闸门、路由文件有没有注册、
// worker 有没有被 main 启动、谁引用了谁、环、孤儿）；lint 做「一眼可判」的目录边界。
// 数据语句、路由里手写错误响应 …）。
//
// 取样例的**实际生效配置**（calculateConfigForFile），校验规则真的开着（error 级）、片段在
// 选项里、没被后面的 override 盖掉。每段 override 的注释里写着它守的标签。
//
// flat config 里**同名规则的后一条会整体替换前一条**：no-restricted-imports 在不同目录要禁的
// 集合不同，所以下面按目录各给一段、每段给出**完整**集合（restrict(...) 拼起来）；
// no-restricted-syntax 同理（syntax(...)）。加一条新 pattern / 选择器时，确认它出现在所有
// 应当生效的段里 —— 登记表的 eslint_sample 只核对样例。
//
// no-restricted-imports 的 group 按 gitignore 语义匹配：`**/db/**` 同时匹配 `../db/client.js`
// 与 `../../db/generated/client.js`；裸包名（`fastify`、`@prisma/client`）与带子路径的
// （`@prisma/client/runtime`）要分开写。
//
// + tests。结构不同就改各段的 files；「规则实现者」豁免（src/core/config.ts 读 env、
// src/core/logger.ts 用 console、tests/setup.ts 改 env、scripts/** 是 CLI）按你项目里对应文件
// 的实际路径改。接手存量项目时**先数存量再开规则**：`npx eslint src` 看每条命中多少，不是 0 的
// 先清干净或临时按文件豁免（写明理由、只准变短），否则第一次 lint 就是一片红、规则会被整条关掉。

const restrict = (...groups) => [
  "error",
  { patterns: groups.map(({ group, message }) => ({ group, message })) },
];

// ---- no-restricted-imports 的各组 pattern ----

// [map.route-no-db]：路由不做数据访问，走 service。地图的 route-data-access 告警再报一次，
// 是为了 `npm run map:for` 能看见。`**/db/**` 已经盖住 src/db/client.ts 与生成的
// src/db/generated/**；`**/db/generated/**` 单独再列一条是为了报错信息点名「连类型也不要从
// 生成物拿」—— 路由要的 Read 模型类型在 src/schemas（zod 派生）。
const NO_DB = {
  group: [
    "**/db/**",
    "**/db/generated/**",
    "@prisma/client",
    "@prisma/client/*",
    "@prisma/adapter-pg",
  ],
  message:
    "路由不做数据访问（不 import src/db、src/db/generated、@prisma/client），查询与写入放 src/services，路由只声明 schema、闸门、调 service；响应类型从 src/schemas 的 zod 派生。",
};

// [layer.service-no-http] [layer.import-contracts]：service / worker / schema / db / core 不知道
// HTTP 的存在。拒绝一律 throw src/core/errors 的领域异常，src/app.ts 的 setErrorHandler 统一映射
// 成错误信封；需要请求上下文的东西（当前用户、requestId）由路由取出来当参数传进去。
const NO_HTTP = {
  group: ["fastify", "@fastify/*", "fastify-*", "**/api/**"],
  message:
    "这一层不 import fastify / @fastify/* / fastify-* / src/api：拒绝一律 throw src/core/errors 的领域异常（NotFound / Forbidden / Conflict / Invalid），HTTP 状态码与信封由 src/app.ts 统一产出；请求上下文由路由当参数传入。",
};

// [layer.import-contracts]：被依赖方不能反向依赖上层。
const NO_SERVICES = {
  group: ["**/services/**"],
  message:
    "这一层是被依赖方，不能反向 import src/services。schema / 表定义 / core 里需要的类型自己声明，或由 service 来 import 它们。",
};
const NO_SCHEMAS = {
  group: ["**/schemas/**"],
  message:
    "这一层不 import src/schemas：zod 请求 / 响应 schema 是 HTTP 边界的东西，表定义与 core 不依赖它。",
};
const NO_DB_LAYER = {
  group: [
    "**/db/**",
    "**/db/generated/**",
    "@prisma/client",
    "@prisma/client/*",
    "@prisma/adapter-pg",
  ],
  message:
    "src/core 是最底层，不 import src/db / src/db/generated / @prisma/client：配置、领域异常、logger、时钟不依赖任何上层。",
};
const NO_WORKERS = {
  group: ["**/workers/**"],
  message: "src/core 是最底层，不 import src/workers。",
};

// ---- no-restricted-syntax 的选择器（按作用域分组，每段给完整集合）----

const bans = (message, ...selectors) =>
  selectors.map((selector) => ({ selector, message }));
const syntax = (...groups) => ["error", ...groups.flat()];

// [config.env-in-core]：process.env 只在 src/core/config.ts 读一次、校验一次、导出冻结对象。
// 散落各处会让「哪些配置影响行为」无法一眼看全，测试也没法用注入替代。
const S_ENV = bans(
  "process.env 只在 src/core/config.ts 读（读一次、校验一次、导出冻结对象）；其他地方从 config 拿。",
  "MemberExpression[object.name='process'][property.name='env']",
);
// [state.timers-in-workers]：no-restricted-globals 只认裸标识符，`globalThis.setTimeout` 能绕过，
// 在 api / services 里一起拦。
const S_TIMERS_INDIRECT = bans(
  "定时逻辑放 src/workers 且排期落库（重启后从库里继续）；api / services 里不用 setTimeout / setInterval，包括 globalThis.setTimeout 这种写法。",
  "MemberExpression[object.name='globalThis'][property.name=/^set(Timeout|Interval)$/]",
);

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "coverage/**",
      "node_modules/**",
      // prisma generate 的产物：不进 git，每次 npm install 重生成；里面的写法不归本仓管
      // （services 照常 import 它的类型，tsconfig 不排除它，只是不 lint）。
      "src/db/generated/**",
      // 不 lint；落位完可以整个删掉。
      // Prisma CLI 的配置：config.ts 之外唯一允许读 env 的地方（prisma 自己加载它，
      // 不经过应用）。
      "prisma.config.ts",
    ],
  },

  js.configs.recommended,
  // 类型感知的推荐集：no-floating-promises、no-misused-promises、no-unsafe-* 都在里面。
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // projectService：按每个文件最近的 tsconfig 建类型服务，不用手写 project 列表。
        // 被 lint 的 .ts / .mts 必须在某个 tsconfig 的 include 里（tsconfig.json 含 src / tests /
        // scripts 与根目录的 *.ts / *.mts），否则报「file not included in any project」。
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  // .mjs / .js（本文件、scripts/*.mjs）不做类型感知：它们不在 tsconfig 里，类型规则会报错。
  // no-undef 在 .ts 上由 tsc 兜底（typescript-eslint 关掉了它），在 .mjs 上还开着，所以要告诉它
  // Node 的全局名 —— 不为此多装一个 globals 包，列出脚本会用到的这几个就够。
  {
    files: ["**/*.mjs", "**/*.js"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: Object.fromEntries(
        [
          "process",
          "console",
          "Buffer",
          "URL",
          "URLSearchParams",
          "setTimeout",
          "clearTimeout",
          "setInterval",
          "clearInterval",
          "setImmediate",
          "queueMicrotask",
          "structuredClone",
          "fetch",
          "AbortController",
          "TextEncoder",
          "TextDecoder",
          "performance",
          "crypto",
        ].map((name) => [name, "readonly"]),
      ),
    },
  },

  // ---- 全局 ----
  {
    rules: {
      // [log.no-console]：日志一律走 src/core/logger.ts 的 pino（结构化、带 requestId）。
      "no-console": "error",
      // any 让 no-unsafe-* 全部失效；确实未知的用 unknown 再收窄。
      "@typescript-eslint/no-explicit-any": "error",
      // 未用的 import / 变量：recommended 里就是 error，这里钉住免得被别的 preset 降成 warn
      // （warn 不让 npm run lint 失败）。
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // [config.env-in-core]
      "no-restricted-syntax": syntax(S_ENV),
      // Fastify 的插件（`export default async function (app)`）、preHandler 闸门、路由 handler
      // 都是 Promise 契约：函数体里没有 await 也必须是 async（返回值被 await、抛错走 setErrorHandler）。
      // recommendedTypeChecked 里的 require-await 与这个契约正面冲突，每个路由文件都会红，关掉。
      // 「忘了 await」由 no-floating-promises 拦，不靠这条。
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    files: ["**/*.ts", "**/*.mts"],
    rules: {
      // [async.no-floating-promises] [worker.no-floating-promises]：没人 await 的 Promise 抛错
      // 就是 unhandledRejection，worker 的 tick、路由里的旁路写入都栽过。要「发后不管」写 void。
      "@typescript-eslint/no-floating-promises": "error",
    },
  },

  // ---- src/api/**：HTTP 边界 ----
  {
    files: ["src/api/**"],
    rules: {
      // [map.route-no-db] [layer.import-contracts]
      "no-restricted-imports": restrict(NO_DB),
      // [state.timers-in-workers]
      "no-restricted-globals": [
        "error",
        {
          name: "setInterval",
          message:
            "定时逻辑放 src/workers 且排期落库（重启后从库里继续）；请求处理里不起定时器。",
        },
        {
          name: "setTimeout",
          message:
            "定时逻辑放 src/workers 且排期落库（重启后从库里继续）；请求处理里不起定时器，需要延时的外部副作用写进 outbox 由 worker 派发。",
        },
      ],
      "no-restricted-syntax": syntax(S_ENV, S_TIMERS_INDIRECT),
    },
  },

  // ---- src/services/**：业务逻辑 + 数据访问 ----
  {
    files: ["src/services/**"],
    rules: {
      // [layer.service-no-http] [layer.import-contracts]
      "no-restricted-imports": restrict(NO_HTTP),
      // [state.timers-in-workers] [worker.timers-only-tick]：service 里的「稍后再试」「每隔一段」
      // 都是排期，排期落库、由 worker 按库里的时间戳领取；进程内定时器重启就丢。
      "no-restricted-globals": [
        "error",
        {
          name: "setInterval",
          message:
            "定时逻辑放 src/workers 且排期落库（重启后从库里继续）；service 里不起定时器。",
        },
        {
          name: "setTimeout",
          message:
            "定时逻辑放 src/workers 且排期落库（重启后从库里继续）；service 里不起定时器，退避 / 延时写成 outbox 行的 nextAttemptAt。",
        },
      ],
      "no-restricted-syntax": syntax(S_ENV, S_TIMERS_INDIRECT),
    },
  },

  // ---- src/workers/**：后台循环，只依赖 services / db / core ----
  {
    files: ["src/workers/**"],
    rules: {
      // [layer.service-no-http] [layer.import-contracts]
      "no-restricted-imports": restrict(NO_HTTP),
    },
  },

  // ---- src/schemas/**：zod 请求 / 响应 schema，不 import services / api ----
  {
    files: ["src/schemas/**"],
    rules: {
      // [layer.import-contracts]
      "no-restricted-imports": restrict(NO_HTTP, NO_SERVICES),
    },
  },

  // ---- src/db/**：client（PrismaClient + adapter）、迁移触发、schema 闸。被依赖方 ----
  // 生成物 src/db/generated/** 在 ignores 里，这段只管 client.ts 这类手写文件。
  {
    files: ["src/db/**"],
    rules: {
      // [layer.import-contracts]
      "no-restricted-imports": restrict(NO_HTTP, NO_SERVICES, NO_SCHEMAS),
    },
  },

  // ---- src/core/**：最底层，不 import 任何上层 ----
  // 最底层被上层污染是最难查、最容易连环崩的一类问题，而它恰好是 lint 最容易守住的。
  {
    files: ["src/core/**"],
    rules: {
      // [layer.import-contracts]
      "no-restricted-imports": restrict(
        NO_HTTP,
        NO_SERVICES,
        NO_SCHEMAS,
        NO_DB_LAYER,
        NO_WORKERS,
      ),
    },
  },

  // ---- 规则的实现者本身 ----
  {
    // [config.env-in-core] 的唯一读点。
    files: ["src/core/config.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
  {
    // [log.no-console] 的实现者：pino 实例在这里建；本地开发接 pino-pretty 也在这里。
    files: ["src/core/logger.ts"],
    rules: { "no-console": "off" },
  },
  {
    // tests/setup.ts 在应用加载之前把 DATABASE_URL 指到临时 schema —— 这是测试基础设施，
    // 不是业务代码读配置；其他测试文件仍然不许碰 process.env。
    files: ["tests/setup.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
  {
    // scripts/** 是命令行工具：输出走 console、PROJECT_MAP_BUILD 这类开关直接设 env。
    files: ["scripts/**"],
    rules: { "no-console": "off", "no-restricted-syntax": "off" },
  },

  // 放最后：关掉所有与 prettier 冲突的格式类规则，格式只由 prettier 管。
  prettier,
);
