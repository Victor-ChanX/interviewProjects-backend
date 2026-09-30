# 部署（Docker / Dokploy）

整套服务用仓库根目录的 [`docker-compose.yml`](../docker-compose.yml) 一次拉起：

| 服务 | 镜像 | 作用 | 对外 |
| --- | --- | --- | --- |
| `web` | 前端仓 `Dockerfile`（从 GitHub 直接构建） | nginx 托管控制台静态页；`/api`、`/ws` 反代到 `backend` | **给它配域名，端口 80** |
| `backend` | 本仓 `Dockerfile` | API + 全部 worker；启动时前滚迁移、跑幂等种子 | 只在内网 |
| `gateway-sim` | 同上，`node dist/sim/gateway/main.js` | 消息网关模拟器（状态在内存） | 只在内网 |
| `agent-sim` | 同上，`node dist/sim/agent/main.js` | Agent 服务模拟器（默认的 `AGENT_URL`） | 只在内网 |
| `llm-agent` | 同上，`node dist/llm-agent/main.js` | 真实 LLM 版 Agent（Claude / Gemini），配置存 `llm-data` 卷 | 只在内网 |
| `postgres` | `postgres:17-alpine` | 数据库，数据在 `pgdata` 卷 | 只在内网 |

四个 Node 服务共用一个镜像，只是启动命令不同；运行期是编译后的 `dist/`，不带开发依赖。

## 在 Dokploy 上部署

1. **Create Service → Compose**（类型选 Docker Compose，不是 Stack：Stack 模式不支持 `build`）。
2. **Provider**：Git / GitHub，仓库 `https://github.com/Victor-ChanX/interviewProjects-backend.git`，分支 `main`，
   Compose Path `./docker-compose.yml`。
3. **Environment**：把 [`.env.deploy.example`](../.env.deploy.example) 的内容粘进去，改掉三个 `change-me`：
   `POSTGRES_PASSWORD`、`JWT_SECRET`、`LLM_AGENT_ADMIN_TOKEN`（各自 `openssl rand -hex 32`，彼此不同）。
   缺任何一个，`docker compose` 会直接报错并指出是哪个变量。
4. **Domains**：Add Domain → Service 选 `web`，Container Port `80`，填域名，HTTPS 选 Let's Encrypt。
   Dokploy 部署时自己给 `web` 加 Traefik 路由和网络，compose 文件里不用写 labels。
5. **Deploy**。首次部署要编译两个镜像，几分钟；`backend` 健康检查通过后 `web` 才启动。
6. 打开域名，用 `admin / admin` 登录（只读账号 `viewer / viewer`）。

> 预置账号是题目要求，密码固定。站点公开可访问时，任何人都能用它们登录，注意别放敏感数据。

### 没有 HTTPS 时

refresh token 放在带 `Secure` 的 cookie 里，浏览器只在 https 下保存。只用 http 访问（例如先用 IP 试）时，
Environment 里设 `COOKIE_SECURE=0` 再部署，否则刷新页面就会掉登录。配好证书后改回 `1`。

## 接入真实模型（题目 C2）

1. Environment 里把 `AGENT_URL` 改成 `http://llm-agent:8300`，重新部署。
2. 控制台「模型设置」：选服务商 → 填 API Key → 获取模型列表 → 选模型 → 保存 → 测试连接。
   Key 存在 `llm-data` 卷里（文件权限 600），不进镜像，也不进 Environment。
3. 切回模拟器：`AGENT_URL` 改回 `http://agent-sim:8200` 再部署。

## 在部署环境里按人工测试手册操作

[人工测试手册](manual-testing.md) 里的 `$GW/_sim/*`、`$AG/_sim/*` 命令要打到模拟器上。模拟器不对外暴露，
在 Dokploy 里打开 `backend` 容器的终端（镜像里带 `curl`），把变量设成内网地址即可照抄：

```bash
GW=http://gateway-sim:8100
AG=http://agent-sim:8200
```

也可以临时给 `gateway-sim`（端口 8100）加一个域名从本机调；**用完删掉**——`/_sim/*` 没有鉴权，
谁拿到地址都能改模拟器的场景、推假消息。

## 重置数据

网关模拟器的状态在内存里，而后端把见过的事件编号记在库里，所以**两边要一起清**（原因见手册 0.2）：

1. Dokploy 里 Stop 这个 Compose 应用。
2. 删掉数据卷 `pgdata`（Dokploy 的 Volumes / Advanced 页面，或在服务器上 `docker volume rm <项目名>_pgdata`）。
3. Deploy。新库由后端启动时的迁移和种子重建；模拟器随容器重启清空。

`llm-data`（模型配置）不用删，除非想清掉 API Key。

## 本机用 Docker 跑

```bash
cp .env.deploy.example .env     # 改掉三个 change-me；本机是 http，设 COOKIE_SECURE=0
docker compose up -d --build
docker compose ps               # 等 backend 变 healthy
```

`web` 在 compose 里只 `expose` 了 80（Dokploy 经 Traefik 访问它）。本机要从浏览器打开，临时在 `web` 下加
`ports: ["8080:80"]`，再访问 http://localhost:8080 。
