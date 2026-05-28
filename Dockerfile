# syntax=docker/dockerfile:1

# =============================================================================
# Lunar Mission Control - Dockerfile produção-like (multi-stage)
#
# Estratégia de segurança / redução de CVEs (item plus da GS):
#   - Runtime usa imagem Chainguard (Wolfi), continuamente reconstruída e com
#     superfície mínima de pacotes  -> bem menos CVEs que node:debian/node:latest.
#   - NÃO usamos a tag node:latest do Docker Hub.
#   - Build determinístico via `npm ci` + package-lock.json.
#   - Aplicação roda como usuário NÃO-root (uid 65532).
#   - Apenas os artefatos necessários são copiados para a imagem final.
#
# Observação sobre versão do Node:
#   O tier público da Chainguard publica somente as tags `latest` e `latest-dev`
#   (a tag fixa node:22 faz parte do catálogo pago). A `latest` atual entrega
#   Node 26, totalmente compatível com esta aplicação (validado em runtime).
#   Para reprodutibilidade total em produção, fixe a imagem por digest:
#       docker buildx imagetools inspect cgr.dev/chainguard/node:latest
#   e troque a tag por  cgr.dev/chainguard/node@sha256:<digest>.
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1 - dependências: instala node_modules de produção de forma determinística
# A variante "-dev" da Chainguard traz npm e shell para o build.
# -----------------------------------------------------------------------------
FROM cgr.dev/chainguard/node:latest-dev AS deps

# root apenas no estágio de build (descartado); o runtime continua não-root.
USER root
WORKDIR /app

# Copia só os manifestos primeiro para aproveitar o cache de camadas.
COPY package.json package-lock.json ./

# Build determinístico, sem dev deps, sem audit/fund (ruído de rede/log).
RUN npm ci --omit=dev --no-audit --no-fund

# -----------------------------------------------------------------------------
# Stage 2 - runtime: imagem Chainguard mínima, não-root, baixa em CVEs.
# -----------------------------------------------------------------------------
FROM cgr.dev/chainguard/node:latest AS runtime

ENV NODE_ENV=production \
    NPM_CONFIG_CACHE=/tmp/.npm \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app

# Copia apenas o necessário, já com posse do usuário não-root.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json image.png ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public

# Garante execução como usuário não-root (uid 65532).
USER node

# Porta interna da aplicação (apenas exposta na rede Docker, nunca publicada).
EXPOSE 3000

# Healthcheck sem depender de wget/curl: usa o próprio Node para chamar /health.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "require('http').get('http://localhost:3000/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"]

# A imagem Chainguard define ENTRYPOINT ["/usr/bin/node"]; resetamos para que
# o CMD abaixo execute "npm start" tal como pedido na atividade.
# (Alternativa equivalente sem npm: ENTRYPOINT ["node"] + CMD ["src/server.js"].)
ENTRYPOINT []
CMD ["npm", "start"]
