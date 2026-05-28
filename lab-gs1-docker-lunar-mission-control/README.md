# 🌖 Global Solution — Lunar Mission Control

Painel de telemetria de uma base lunar simulada (energia, oxigênio, temperatura,
comunicação, água e robôs), entregue em uma stack **Docker produção-like** para
rodar em uma instância **EC2**.

> A aplicação Node.js **não foi alterada**. O foco desta entrega é a **infra
> Docker**: Dockerfile, Compose, redes, volumes, segurança, healthchecks e
> redução de CVEs.

---

## 🎯 Objetivo da atividade

Partindo de uma stack que funcionava em desenvolvimento mas expunha **todas** as
portas (app, MySQL, Redis e Nginx) ao host, deixá-la mais próxima de produção:

- **Somente o Nginx** publica porta pública (`80`);
- App, MySQL e Redis ficam acessíveis **apenas pela rede interna** do Docker;
- Imagens com versão fixa, build determinístico e imagem da app **não-root**;
- Healthchecks, ordem de subida controlada, limites de recursos e rotação de logs;
- **Item plus:** redução de vulnerabilidades (CVEs) usando imagem **Chainguard**
  no runtime + scan com **Trivy**.

---

## 🛰️ Arquitetura da stack

```
                         Internet / Navegador
                                  │
                          http://IP_DA_EC2/   (porta 80 — única publicada)
                                  │
                          ┌───────▼────────┐
                          │     nginx      │  reverse proxy / webserver
                          │ 1.27-alpine    │  read-only + tmpfs
                          └───────┬────────┘
                rede: lunar_frontend (bridge)
                                  │  proxy_pass http://app:3000
                          ┌───────▼────────┐
                          │      app       │  Node.js (Chainguard, non-root)
                          │ :1.0.0  :3000  │  expose interno apenas
                          └───┬────────┬───┘
            rede: lunar_backend (internal: true — sem internet)
                  │            │            │
          ┌───────▼──┐  ┌──────▼─────┐  ┌───▼──────────┐
          │  mysql   │  │   redis    │  │ init-media   │ (job one-shot)
          │  8.4     │  │ 7.4-alpine │  │ busybox      │ semeia o volume
          └────┬─────┘  └─────┬──────┘  └──────┬───────┘ de mídia
               │              │                │
        lunar_mysql_data  lunar_redis_data  lunar_media_data  (volumes nomeados)
                                                 ▲
                            nginx monta a mídia (read-only) deste volume
```

| Serviço      | Imagem                          | Porta | Rede(s)            | Publica no host? |
|--------------|---------------------------------|-------|--------------------|------------------|
| `nginx`      | `nginx:1.27-alpine`             | 80    | frontend           | **Sim** (80)     |
| `app`        | `lunar-mission-control-app:1.0.0` | 3000  | frontend + backend | Não (expose)     |
| `mysql`      | `mysql:8.4`                     | 3306  | backend (internal) | Não (expose)     |
| `redis`      | `redis:7.4-alpine`              | 6379  | backend (internal) | Não (expose)     |
| `init-media` | `busybox:1.36.1`                | —     | backend (internal) | Não (one-shot)   |

---

## 🐳 Melhorias no Dockerfile

Arquivo `Dockerfile` — **multi-stage**, build determinístico e runtime mínimo:

- **Não usa `node:latest`** do Docker Hub.
- **Stage `deps`**: `cgr.dev/chainguard/node:latest-dev` roda
  `npm ci --omit=dev --no-audit --no-fund` (instalação determinística via
  `package-lock.json`, sem dependências de desenvolvimento).
- **Stage `runtime`**: `cgr.dev/chainguard/node:latest` (imagem Chainguard/Wolfi,
  superfície mínima e **não-root** por padrão — uid `65532`).
- Copia **apenas o necessário**: `node_modules`, `src`, `public`,
  `package.json`, `package-lock.json` e `image.png` (com `--chown` para o
  usuário não-root).
- `EXPOSE 3000` (porta **interna**; nunca publicada).
- **HEALTHCHECK** sem depender de `wget`/`curl` — usa o próprio Node:
  ```dockerfile
  HEALTHCHECK CMD ["node","-e","require('http').get('http://localhost:3000/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"]
  ```
- Mantém `CMD ["npm", "start"]`. Como a imagem Chainguard define
  `ENTRYPOINT ["/usr/bin/node"]`, fazemos `ENTRYPOINT []` para o `npm start`
  funcionar (a imagem já traz o `npm`).

### Sobre a versão do Node (Chainguard)

O tier **público** da Chainguard publica apenas as tags `latest` e `latest-dev`
(a tag fixa `node:22` faz parte do catálogo pago). A `latest` atual entrega
**Node 26**, validado e **100% funcional** com esta aplicação. Para
reprodutibilidade total em produção, fixe a imagem por **digest**:

```bash
docker buildx imagetools inspect cgr.dev/chainguard/node:latest
# troque a tag por cgr.dev/chainguard/node@sha256:<digest>
```

---

## 🧩 Melhorias no `docker-compose.yml`

- **Sem `:latest`** — todas as imagens com versão fixa
  (`mysql:8.4`, `redis:7.4-alpine`, `nginx:1.27-alpine`, `busybox:1.36.1`) e a
  app versionada (`lunar-mission-control-app:1.0.0`).
- **Exposição mínima**: só o `nginx` tem `ports` (`${PUBLIC_HTTP_PORT:-80}:80`).
  `app`, `mysql` e `redis` usam apenas `expose` (visível só na rede Docker).
- **Subida ordenada** via `depends_on` + `condition`:
  - `app` só inicia com `mysql` e `redis` **`service_healthy`** e o
    `init-media` **`service_completed_successfully`**;
  - `nginx` só inicia com a `app` **`service_healthy`**.
- `restart: unless-stopped` nos serviços de longa duração.
- **Limites de recursos** moderados (`mem_limit` + `cpus`) por serviço.
- **Rotação de logs** (`json-file`, `max-size: 10m`, `max-file: 3`) — evita
  encher o disco da EC2.
- **Labels** em todos os serviços: `project`, `owner: rm564630`, `service`.

---

## 🌐 Redes criadas

| Rede             | Driver | `internal` | Quem participa                          |
|------------------|--------|------------|-----------------------------------------|
| `lunar_frontend` | bridge | não        | `nginx`, `app`                          |
| `lunar_backend`  | bridge | **sim**    | `app`, `mysql`, `redis`, `init-media`   |

- `lunar_backend` é **`internal: true`**: MySQL, Redis e init-media **não têm
  acesso à internet** e não são alcançáveis de fora.
- A `app` participa das **duas** redes: recebe o proxy do Nginx (frontend) e
  conversa com banco/cache (backend).

---

## 💾 Volumes criados

| Volume              | Montado em                                   | Função                         |
|---------------------|----------------------------------------------|--------------------------------|
| `lunar_media_data`  | app: `/app/public/media` · nginx: `/usr/share/nginx/html/media` (**ro**) | imagens persistentes do frontend |
| `lunar_mysql_data`  | `/var/lib/mysql`                             | dados da telemetria (MySQL)    |
| `lunar_redis_data`  | `/data`                                      | persistência do cache (Redis)  |

O job **`init-media`** copia os SVGs de `./media` para o `lunar_media_data` antes
da app subir; o Nginx serve essa mídia diretamente do volume (montado **read-only**).

---

## 🔒 Segurança aplicada

- **App não-root** (uid `65532`) — verificável com `docker exec lunar-app id`.
- **`no-new-privileges:true`** em todos os serviços (impede escalonar privilégios).
- **Nginx com filesystem `read_only: true`** + `tmpfs` apenas nos diretórios
  graváveis (`/var/cache/nginx`, `/var/run`, `/tmp`); logs vão para `stdout/stderr`.
- **Superfície de ataque mínima**: nada além da porta 80 é publicado;
  `backend` é `internal`.
- **Redução de CVEs** com imagem Chainguard (ver *Item plus* abaixo).
- **Segredos**: nesta atividade ficam em `.env` com valores simples. **Em
  produção real** devem vir de um cofre (Docker secrets, AWS Secrets Manager/SSM).

---

## ❤️ Healthchecks

| Serviço | Teste                                                        |
|---------|--------------------------------------------------------------|
| `mysql` | `mysqladmin ping` autenticado                                |
| `redis` | `redis-cli ping`                                             |
| `app`   | `node -e` faz GET em `http://localhost:3000/health` (200=ok) |
| `nginx` | `wget` em `http://127.0.0.1/nginx-health`                    |

Esses healthchecks alimentam o `depends_on ... condition: service_healthy`,
garantindo que a stack suba na ordem certa.

---

## 🛠️ Gestão dos containers

```bash
docker compose ps                 # estado e portas
docker compose logs -f app        # logs de um serviço
docker compose stats              # consumo (ou: docker stats)
docker compose restart app        # reiniciar um serviço
docker compose stop / start       # parar / iniciar mantendo dados
docker compose down               # remover containers (mantém volumes)
docker compose down -v            # remover containers + volumes (zera dados)
```

---

## ▶️ Como executar

Pré-requisitos: Docker + Docker Compose v2.

```bash
# 1) variáveis de ambiente
cp .env.example .env
#    EC2: PUBLIC_HTTP_PORT=80   |   Mac/local com a 80 ocupada: PUBLIC_HTTP_PORT=8080

# 2) (opcional) ambiente limpo
docker compose down -v

# 3) validar e subir
docker compose config
docker compose up -d --build

# 4) conferir
docker compose ps
```

Acesse no navegador: **`http://IP_PUBLICO_DA_EC2/`** (ou `http://localhost/`).

---

## ✅ Como testar

```bash
curl http://localhost                 # HTML da interface
curl -s http://localhost/health       # {"status":"healthy", ...}
curl -s http://localhost/ready        # {"status":"ready"}
curl -s http://localhost/api/status   # telemetria (JSON)
curl -s http://localhost/nginx-health # ok
```

---

## 📸 Evidências obrigatórias

```bash
docker compose ps
docker stats
curl -s http://localhost/health
curl -s http://localhost/ready
curl -s http://localhost/api/status
docker network ls
docker volume ls
```

> Para sair do `docker stats`, use **CTRL + C**.

**Prints/evidências a capturar:**

1. `docker compose ps` — mostrando que **apenas o `lunar-nginx` publica porta**
   (`0.0.0.0:80->80/tcp`); os demais aparecem só como `3000/tcp`, `3306/tcp`,
   `6379/tcp` (sem mapeamento para o host).
2. `docker stats` — consumo de CPU/memória dos containers.
3. `curl -s http://localhost/health` retornando `200` / `"status":"healthy"`.
4. Acesso pelo navegador em `http://IP_PUBLICO_DA_EC2/`.
5. Scan do Trivy (item plus) — ver abaixo.

Saída esperada do `docker compose ps` (resumo das portas):

```text
lunar-nginx   ...   0.0.0.0:80->80/tcp     ✅ única porta pública
lunar-app     ...   3000/tcp               🔒 interno
lunar-mysql   ...   3306/tcp, 33060/tcp    🔒 interno
lunar-redis   ...   6379/tcp               🔒 interno
```

---

## ➕ Item plus escolhido: Vulnerabilidades / CVEs (Chainguard + Trivy)

Escolhemos o item plus **Vulnerabilidade (CVEs)**: o runtime usa imagem
**Chainguard (Wolfi)**, continuamente reconstruída e com pacotes mínimos, o que
**zera os CVEs da camada de sistema operacional** da imagem.

```bash
mkdir -p evidencias
trivy image lunar-mission-control-app:1.0.0 | tee evidencias/trivy-scan.txt
```

**Resultado medido nesta entrega:**

| Imagem                                   | CVEs (camada de SO)         |
|------------------------------------------|-----------------------------|
| `node:latest` (Docker Hub, Debian)       | **1762** (21 CRITICAL, 148 HIGH, …) |
| `lunar-mission-control-app:1.0.0` (Wolfi)| **0**                       |

Os únicos achados do Trivy na nossa imagem (12 no total) estão em **dependências
npm da própria aplicação** (`body-parser`, `path-to-regexp`, `express`, `mysql2`,
`qs`, `send`, `serve-static`, `cookie`), herdadas do `package.json`/`package-lock.json`.
Elas só somem **atualizando essas bibliotecas** — fora do escopo desta entrega,
que **não altera a aplicação**. A escolha da Chainguard elimina toda a carga de
CVEs que viria do sistema base.

> Para uma entrega EC2 sem Trivy instalado:
> `sudo dnf install -y trivy` (Amazon Linux 2023) ou veja
> <https://aquasecurity.github.io/trivy>. Referência da imagem:
> <https://images.chainguard.dev/directory/image/node/vulnerabilities>.

---

## 🔌 Endpoints

```text
GET  /              Interface web
GET  /api/status    Dados da missão
POST /api/simulate  Simula nova telemetria
GET  /health        Healthcheck geral (app + MySQL + Redis)
GET  /ready         Readiness da aplicação
GET  /nginx-health  Health do próprio Nginx (não toca na app)
```

---

## 🧹 Limpeza

```bash
docker compose down -v                      # remove containers + volumes do projeto
docker system prune -a --volumes -f         # limpeza geral da máquina (cuidado!)
```

---

## 📁 Arquivos da entrega

```text
Dockerfile            multi-stage, Chainguard, non-root, healthcheck
.dockerignore         contexto de build enxuto
docker-compose.yml    stack production-like (redes, volumes, healthchecks, limites)
.env.example          variáveis (copiar para .env)
nginx/default.conf    reverse proxy + /nginx-health + logs em stdout/stderr
README.md             esta documentação
evidencias/           saída do Trivy e demais evidências
```

![alt text](image.png)
