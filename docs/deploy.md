# 部署（Docker / Dokploy）

前后端是两个独立部署的服务，各自一个域名：

```
浏览器 ──https──▶ 前端（Dokploy Application，前端仓 Dockerfile，nginx）
                   │  /api、/ws 转发（BACKEND_URL）
                   ▼
                 后端（Dokploy Compose，本仓 docker-compose.yml）
                   backend ─┬─ postgres
                            ├─ gateway-sim   消息网关模拟器
                            ├─ agent-sim     Agent 服务模拟器（默认）
                            └─ llm-agent     真实 LLM 版 Agent（Claude / Gemini）
```

浏览器只和前端域名同源通信（前端的 nginx 把 `/api`、`/ws` 转给后端域名），所以后端不用配 CORS，
refresh cookie 也落在前端域名下。后端域名同时可以直接调接口（例如按人工测试手册用 curl）。

后端这一侧：

| 服务 | 作用 | 对外 |
| --- | --- | --- |
| `backend` | API + 全部 worker；启动时前滚迁移、跑幂等种子 | **配域名，端口 8000** |
| `postgres` | 数据库（`postgres:17-alpine`），数据在 `pgdata` 卷 | 只在内网 |
| `gateway-sim` | 消息网关模拟器（状态在内存） | 只在内网 |
| `agent-sim` | Agent 服务模拟器，默认的 `AGENT_URL` | 只在内网 |
| `llm-agent` | 真实 LLM 版 Agent，模型配置存 `llm-data` 卷 | 只在内网 |

四个 Node 服务共用本仓 `Dockerfile` 构建的同一个镜像，只是启动命令不同；运行期是编译后的 `dist/`，不带开发依赖。

## 1. 部署后端（Dokploy Compose）

1. **Create Service → Compose**，类型选 Docker Compose（不是 Stack：Stack 模式不支持 `build`）。
2. **Provider**：Git / GitHub，仓库 `https://github.com/Victor-ChanX/interviewProjects-backend.git`，分支 `main`，
   Compose Path `./docker-compose.yml`。
3. **Environment**：把 [`.env.deploy.example`](../.env.deploy.example) 的内容粘进去，改掉三个 `change-me`：
   `POSTGRES_PASSWORD`、`JWT_SECRET`、`LLM_AGENT_ADMIN_TOKEN`（各自 `openssl rand -hex 32`，彼此不同）。
   缺任何一个，`docker compose` 会直接报错并指出是哪个变量。
4. **Domains**：Add Domain → Service 选 `backend`，Container Port `8000`，填后端域名（如 `api.example.com`），
   HTTPS 选 Let's Encrypt。Dokploy 部署时自己加 Traefik 路由，compose 文件里不用写 labels。
5. **Deploy**。首次要编译镜像，几分钟。验证：`curl https://api.example.com/api/health` → `{"ok":true,…}`。

## 2. 部署前端（Dokploy Application）

1. **Create Service → Application**，仓库 `https://github.com/Victor-ChanX/interviewProjects-frontend.git`，分支 `main`，
   Build Type 选 **Dockerfile**（路径 `./Dockerfile`）。
2. **Environment**：`BACKEND_URL=https://api.example.com`（上一步的后端域名；只写协议和主机，不带路径和末尾 `/`，
   格式不对容器会拒绝启动并在日志里说明）。
3. **Domains**：前端域名（如 `app.example.com`），Container Port `80`，HTTPS 选 Let's Encrypt。
4. **Deploy**，打开前端域名，用 `admin / admin` 登录（只读账号 `viewer / viewer`）。

> 预置账号是题目要求，密码固定。站点公开可访问时，任何人都能用它们登录，注意别放敏感数据。

### 没有 HTTPS 时

refresh token 放在带 `Secure` 的 cookie 里，浏览器只在 https 下保存。前端只用 http 访问（例如先用 IP 试）时，
后端 Environment 里设 `COOKIE_SECURE=0` 再部署，否则刷新页面就会掉登录。配好证书后改回 `1`。

## 接入真实模型（题目 C2）

1. 后端 Environment 里把 `AGENT_URL` 改成 `http://llm-agent:8300`，重新部署后端。
2. 控制台「模型设置」：选服务商 → 填 API Key → 获取模型列表 → 选模型 → 保存 → 测试连接。
   Key 存在 `llm-data` 卷里（文件权限 600），不进镜像，也不进 Environment。
3. 切回模拟器：`AGENT_URL` 改回 `http://agent-sim:8200` 再部署。

## 在部署环境里按人工测试手册操作

[人工测试手册](manual-testing.md) 里调后端接口的命令，把 `localhost:8000` 换成后端域名即可。
`$GW/_sim/*`、`$AG/_sim/*` 要打到模拟器上，而模拟器不对外暴露：在 Dokploy 里打开 `backend` 容器的终端
（镜像里带 `curl`），把变量设成内网地址后照抄：

```bash
GW=http://gateway-sim:8100
AG=http://agent-sim:8200
```

也可以临时给 `gateway-sim`（端口 8100）加一个域名从本机调；**用完删掉**——`/_sim/*` 没有鉴权，
谁拿到地址都能改模拟器的场景、推假消息。

## 重置数据

网关模拟器的状态在内存里，而后端把见过的事件编号记在库里，所以**两边要一起清**（原因见手册 0.2）：

1. Dokploy 里 Stop 后端这个 Compose 应用。
2. 删掉数据卷 `pgdata`（Dokploy 的 Volumes / Advanced 页面，或在服务器上 `docker volume rm <项目名>_pgdata`）。
3. Deploy。新库由后端启动时的迁移和种子重建；模拟器随容器重启清空。前端不用动。

`llm-data`（模型配置）不用删，除非想清掉 API Key。

## 本机用 Docker 跑

```bash
# 后端：本机是 http，.env 里设 COOKIE_SECURE=0；backend 只 expose 了 8000，本机访问要临时加 ports: ["8000:8000"]
cp .env.deploy.example .env
docker compose up -d --build

# 前端（在前端仓）
docker build -t gmp-web . && docker run --rm -p 8080:80 -e BACKEND_URL=http://host.docker.internal:8000 gmp-web
```

打开 http://localhost:8080 。
