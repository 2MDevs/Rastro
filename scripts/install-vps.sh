#!/usr/bin/env bash
# =============================================================================
# RASTRO — instalação na VPS (rodar UMA vez, como root, dentro da pasta do projeto)
#
#   cd /var/www/rastro && sudo bash scripts/install-vps.sh
#
# Cria SÓ o que é do RASTRO:
#   - usuário e banco PostgreSQL "rastro" / "rastro_db"
#   - arquivo .env (com chaves geradas na hora)
#   - serviço systemd "rastro.service"
#   - site Nginx "/etc/nginx/sites-available/rastro" + certificado HTTPS (certbot)
#   - botão "Atualizar sistema" (scripts/install-auto-update.sh)
# Não altera serviços, pastas, portas, bancos ou sites de outros projetos.
# Se algo der errado, o script para e diz o que fazer.
#
# Opções (variáveis antes do comando):
#   DOMAIN=rastro.gestaohummm.com.br  PORT=3150  APP_USER=www-data  SKIP_HTTPS=1
# =============================================================================
set -euo pipefail

die()  { echo -e "\n\033[1;31m[erro]\033[0m $*\n"; exit 1; }
ok()   { echo -e "\033[1;32m[ok]\033[0m $*"; }
info() { echo -e "\033[1;33m[..]\033[0m $*"; }

[ "$(id -u)" -eq 0 ] || die "Rode como root: sudo bash scripts/install-vps.sh"
APP_DIR=$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)
cd "$APP_DIR"
[ -f package.json ] && grep -q '"name": "rastro"' package.json || die "Rode dentro da pasta do RASTRO."
DOMAIN=${DOMAIN:-rastro.gestaohummm.com.br}
APP_USER=${APP_USER:-$(stat -c %U "$APP_DIR")}
[ "$APP_USER" = "root" ] && info "A pasta pertence ao root. Recomendado: um usuário próprio (ex.: APP_USER=www-data)."
ok "Pasta: $APP_DIR | usuário da aplicação: $APP_USER | domínio: $DOMAIN"

# ------------------------------------------------------------------ 1. pré-requisitos
for c in git curl psql openssl nginx systemctl; do command -v "$c" >/dev/null || die "Comando '$c' não encontrado. Instale antes de continuar."; done
NODE=$(command -v node || true)
[ -n "$NODE" ] || die "Node.js não encontrado (precisa da versão 20 ou mais nova)."
NODE_MAJOR=$("$NODE" -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || die "Node.js $("$NODE" -v) é antigo. Precisa da versão 20 ou mais nova."
NODE_BIN=$(dirname "$NODE")
ok "Node $("$NODE" -v) em $NODE_BIN"
systemctl list-unit-files rastro.service --no-legend 2>/dev/null | grep -q rastro && die "Já existe um serviço 'rastro'. Este script é só para a primeira instalação."
[ -e /etc/nginx/sites-available/rastro ] && die "Já existe /etc/nginx/sites-available/rastro. Confira antes de continuar."

# ------------------------------------------------------------------ 2. porta livre
used_ports() { ss -ltnH | awk '{print $4}' | sed 's/.*://' ; grep -rhoE 'proxy_pass\s+http://[^:;]+:[0-9]+' /etc/nginx 2>/dev/null | sed 's/.*://'; }
if [ -z "${PORT:-}" ]; then
  for p in $(seq 3150 3199); do
    if ! used_ports | grep -qx "$p"; then PORT=$p; break; fi
  done
fi
[ -n "${PORT:-}" ] || die "Não achei porta livre entre 3150 e 3199. Rode de novo informando: PORT=xxxx sudo -E bash scripts/install-vps.sh"
used_ports | grep -qx "$PORT" && die "A porta $PORT já está em uso por outro projeto."
ok "Porta do RASTRO: $PORT (livre)"

# ------------------------------------------------------------------ 3. banco exclusivo
DB_PASS=""
if sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='rastro'" | grep -q 1; then
  info "O usuário de banco 'rastro' já existe: vou manter e usar o DATABASE_URL do .env."
else
  DB_PASS=$(openssl rand -hex 24)
  sudo -u postgres psql -q -c "CREATE ROLE rastro LOGIN PASSWORD '$DB_PASS';"
  ok "Usuário de banco 'rastro' criado"
fi
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='rastro_db'" | grep -q 1; then
  sudo -u postgres psql -q -c "CREATE DATABASE rastro_db OWNER rastro;"
  ok "Banco 'rastro_db' criado"
else
  info "Banco 'rastro_db' já existe: mantido."
fi

# ------------------------------------------------------------------ 4. .env
ADMIN_PASS_SHOWN=""
if [ -f .env ]; then
  info ".env já existe: mantido (confira PORT=$PORT e APP_URL)."
else
  [ -n "$DB_PASS" ] || die "Crie o .env manualmente (o usuário 'rastro' do banco já existia e não sei a senha dele)."
  read -rp "E-mail(s) do desenvolvedor (DEVELOPER_EMAILS, separados por vírgula): " DEV_EMAILS
  read -rp "E-mail do administrador inicial (ADMIN_EMAIL): " ADMIN_EMAIL
  [ -n "$DEV_EMAILS" ] && [ -n "$ADMIN_EMAIL" ] || die "Os dois e-mails são obrigatórios."
  ADMIN_PASS="Rastro$(openssl rand -hex 6)9"
  ADMIN_PASS_SHOWN=$ADMIN_PASS
  umask 077
  cat > .env <<ENV
DATABASE_URL=postgresql://rastro:${DB_PASS}@127.0.0.1:5432/rastro_db
PORT=${PORT}
APP_URL=https://${DOMAIN}
NODE_ENV=production
SETTINGS_ENCRYPTION_KEY=$(openssl rand -base64 32)
DEVELOPER_EMAILS=${DEV_EMAILS}
ADMIN_EMAIL=${ADMIN_EMAIL}
ADMIN_INITIAL_PASSWORD=${ADMIN_PASS}
SESSION_TTL_HOURS=8
LOCK_IDLE_MINUTES=10
PIN_MAX_ATTEMPTS=5
ENV
  umask 022
  ok ".env criado (somente leitura do dono)"
fi
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"
chmod 600 .env

# ------------------------------------------------------------------ 5. dependências e build
as_app() { runuser -u "$APP_USER" -- env PATH="$NODE_BIN:$PATH" HOME="$APP_DIR" "$@"; }
info "Instalando dependências (pode levar alguns minutos)..."
if [ -f package-lock.json ]; then as_app npm ci --no-audit --no-fund || die "Falha no 'npm ci'. Copie as mensagens acima e envie para o Claude."
else as_app npm install --no-audit --no-fund || die "Falha no 'npm install'. Copie as mensagens acima e envie para o Claude."; fi
ok "Dependências instaladas"
info "Gerando a versão de produção..."
as_app npm run build || die "Falha no build. Copie as mensagens acima e envie para o Claude."
ok "Build gerado em dist/"

# ------------------------------------------------------------------ 6. serviço systemd próprio
cat > /etc/systemd/system/rastro.service <<UNIT
[Unit]
Description=RASTRO - Inteligencia em movimento
After=network.target postgresql.service

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
Environment=PATH=${NODE_BIN}:/usr/bin:/bin
ExecStart=${NODE_BIN}/node ${APP_DIR}/node_modules/tsx/dist/cli.mjs server.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now rastro >/dev/null 2>&1
info "Aguardando o RASTRO responder..."
for i in $(seq 1 30); do curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1 && break; sleep 2; done
curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1 || {
  journalctl -u rastro -n 40 --no-pager
  die "O RASTRO não respondeu. Envie as mensagens acima para o Claude. (O serviço fica parado: systemctl stop rastro)"
}
ok "RASTRO respondendo em http://127.0.0.1:${PORT}"

# ------------------------------------------------------------------ 7. Nginx (site próprio) e HTTPS
cat > /etc/nginx/sites-available/rastro <<NGINX
server {
  listen 80;
  server_name ${DOMAIN};
  location / {
    proxy_pass http://127.0.0.1:${PORT};
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_buffering off;
    proxy_read_timeout 1h;
    client_max_body_size 30m;
  }
}
NGINX
ln -sf /etc/nginx/sites-available/rastro /etc/nginx/sites-enabled/rastro
if ! nginx -t 2>/dev/null; then
  rm -f /etc/nginx/sites-enabled/rastro
  nginx -t || true
  die "A configuração do Nginx não passou no teste. O site do RASTRO foi retirado (os outros sites não foram tocados)."
fi
systemctl reload nginx
ok "Site Nginx do RASTRO ativo (http://${DOMAIN})"

if [ "${SKIP_HTTPS:-0}" != "1" ]; then
  SERVER_IP=$(curl -fsS --max-time 5 https://api.ipify.org || true)
  DNS_IP=$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || true)
  if [ -z "$DNS_IP" ]; then
    info "O domínio ${DOMAIN} ainda não aponta para nenhum IP. Crie o registro DNS tipo A para ${SERVER_IP:-o IP desta VPS} e depois rode: sudo certbot --nginx -d ${DOMAIN}"
  elif [ -n "$SERVER_IP" ] && [ "$DNS_IP" != "$SERVER_IP" ]; then
    info "O DNS de ${DOMAIN} aponta para ${DNS_IP}, mas esta VPS é ${SERVER_IP}. Corrija o DNS e rode: sudo certbot --nginx -d ${DOMAIN}"
  elif command -v certbot >/dev/null; then
    certbot --nginx -d "$DOMAIN" --redirect --non-interactive --agree-tos --register-unsafely-without-email || info "O certbot falhou. Rode depois: sudo certbot --nginx -d ${DOMAIN}"
  else
    info "certbot não instalado. Instale (apt install certbot python3-certbot-nginx) e rode: sudo certbot --nginx -d ${DOMAIN}"
  fi
fi

# ------------------------------------------------------------------ 8. botão "Atualizar sistema"
bash "$APP_DIR/scripts/install-auto-update.sh" "$APP_DIR" || info "Instale depois: sudo bash scripts/install-auto-update.sh"

echo
echo "=============================================================="
echo " RASTRO instalado."
echo "   Endereço:  https://${DOMAIN}"
echo "   Porta local: ${PORT} | serviço: systemctl status rastro"
if [ -n "$ADMIN_PASS_SHOWN" ]; then
echo
echo "   Administrador inicial: ${ADMIN_EMAIL}"
echo "   Senha provisória:      ${ADMIN_PASS_SHOWN}"
echo "   (anote agora; no primeiro acesso o sistema obriga a trocar)"
fi
echo
echo " Próximos passos no sistema:"
echo "   1. Entrar com o administrador inicial e trocar a senha"
echo "   2. Usuários › cadastrar o desenvolvedor (e-mail de DEVELOPER_EMAILS)"
echo "   3. Desenvolvedor › Integração › E-mail (SMTP) › enviar e-mail de teste (ativa o 2FA)"
echo "   4. Gerar o mapa de fundo da região (docs/mapa-de-fundo.md)"
echo "=============================================================="
