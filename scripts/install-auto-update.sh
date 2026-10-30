#!/usr/bin/env bash
# =============================================================================
# RASTRO — instala o botão "Atualizar sistema" na VPS (rodar UMA vez, como root)
#
#   cd /caminho/do/rastro && sudo bash scripts/install-auto-update.sh
#
# Detecta sozinho a pasta do projeto, o dono dos arquivos, a porta e como o
# sistema é reiniciado (systemd ou PM2). Se quiser forçar algum valor:
#   RESTART_CMD="pm2 restart rastro" BRANCH=main sudo -E bash scripts/install-auto-update.sh
#
# Não altera outros projetos: cria apenas /etc/rastro-update.conf e as
# unidades systemd rastro-update.service / rastro-update.path.
# =============================================================================
set -euo pipefail

die() { echo -e "\033[1;31m[erro] $*\033[0m"; exit 1; }
ok()  { echo -e "\033[1;32m[ok]\033[0m $*"; }

[ "$(id -u)" -eq 0 ] || die "Execute como root (sudo)."

APP_DIR=$(cd "${1:-$(dirname "$(readlink -f "$0")")/..}" && pwd)
cd "$APP_DIR"

# 1. Pré-requisitos ----------------------------------------------------------
[ -d .git ] || die "$APP_DIR não é um clone do Git. O botão precisa que o projeto tenha sido instalado com 'git clone'."
for c in git curl systemctl; do command -v "$c" >/dev/null || die "Comando '$c' não encontrado."; done
ORIGIN=$(git -c safe.directory="$APP_DIR" remote get-url origin)
[[ "$ORIGIN" == *github.com* ]] || die "O remote 'origin' não aponta para o GitHub ($ORIGIN)."
git -c safe.directory="$APP_DIR" ls-remote -q origin >/dev/null 2>&1 \
  || die "A VPS não conseguiu acessar $ORIGIN. Se o repositório for privado, configure uma deploy key."
ok "Projeto: $APP_DIR ($ORIGIN)"

BRANCH=${BRANCH:-$(git -c safe.directory="$APP_DIR" rev-parse --abbrev-ref HEAD)}
[ "$BRANCH" = "HEAD" ] && BRANCH=main
APP_OWNER=$(stat -c %U "$APP_DIR")
ok "Branch: $BRANCH | dono dos arquivos: $APP_OWNER"

# 2. Node.js -----------------------------------------------------------------
if [ -x "$APP_DIR/.node/bin/node" ]; then
  NODE_BIN_DIR="$APP_DIR/.node/bin"
elif command -v node >/dev/null; then
  NODE_BIN_DIR=$(dirname "$(command -v node)")
else
  die "Node.js não encontrado. Rode este script num terminal onde 'node -v' funcione."
fi
ok "Node: $("$NODE_BIN_DIR/node" -v) ($NODE_BIN_DIR)"

# 3. Porta / healthcheck -----------------------------------------------------
PORT=$(grep -E '^PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2 | tr -d '"'"'"' ' || true)
PORT=${PORT:-3000}
HEALTH_URL="http://127.0.0.1:$PORT/api/health"
curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null || die "O sistema não respondeu em $HEALTH_URL. Ele está rodando?"
ok "Sistema respondendo em $HEALTH_URL"

# 4. Como reiniciar ----------------------------------------------------------
if [ -z "${RESTART_CMD:-}" ]; then
  # 4a. Serviço systemd cujo WorkingDirectory é a pasta do projeto
  for unit in $(systemctl list-unit-files --type=service --no-legend 2>/dev/null | awk '{print $1}'); do
    [[ "$unit" == rastro-update.service ]] && continue
    wd=$(systemctl show -p WorkingDirectory --value "$unit" 2>/dev/null || true)
    if [ "$wd" = "$APP_DIR" ] && systemctl is-active --quiet "$unit"; then
      RESTART_CMD="systemctl restart $unit"; break
    fi
  done
fi
if [ -z "${RESTART_CMD:-}" ]; then
  # 4b. Processo do PM2 rodando nesta pasta (PM2 do root ou do dono dos arquivos)
  for pm2user in root "$APP_OWNER"; do
    PM2_BIN=$(command -v pm2 || ls "$NODE_BIN_DIR/pm2" 2>/dev/null || true)
    [ -n "$PM2_BIN" ] || break
    if [ "$pm2user" = root ]; then JL=$(PATH="$NODE_BIN_DIR:$PATH" "$PM2_BIN" jlist 2>/dev/null || true)
    else JL=$(runuser -u "$pm2user" -- env PATH="$NODE_BIN_DIR:$PATH" "$PM2_BIN" jlist 2>/dev/null || true); fi
    NAME=$(printf '%s' "$JL" | "$NODE_BIN_DIR/node" -e '
      let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{
        const p=JSON.parse(d).find(x=>x.pm2_env&&x.pm2_env.pm_cwd&&require("path").resolve(x.pm2_env.pm_cwd)===process.argv[1]);
        if(p)console.log(p.name)}catch{}})' "$APP_DIR")
    if [ -n "$NAME" ]; then
      if [ "$pm2user" = root ]; then RESTART_CMD="PATH=$NODE_BIN_DIR:\$PATH $PM2_BIN restart $NAME --update-env"
      else RESTART_CMD="runuser -u $pm2user -- env PATH=$NODE_BIN_DIR:\$PATH $PM2_BIN restart $NAME --update-env"; fi
      break
    fi
  done
fi
[ -n "${RESTART_CMD:-}" ] || die "Não descobri como o RASTRO é reiniciado. Rode de novo informando, ex.:
  RESTART_CMD=\"systemctl restart rastro\" bash scripts/install-auto-update.sh"
ok "Reinício: $RESTART_CMD"

# 5. Configuração e serviços -------------------------------------------------
{
  echo "# Gerado por scripts/install-auto-update.sh em $(date -Is)"
  printf 'APP_DIR=%q\nBRANCH=%q\nAPP_OWNER=%q\nNODE_BIN_DIR=%q\nHEALTH_URL=%q\nRESTART_CMD=%q\n' \
    "$APP_DIR" "$BRANCH" "$APP_OWNER" "$NODE_BIN_DIR" "$HEALTH_URL" "$RESTART_CMD"
} > /etc/rastro-update.conf
chmod 600 /etc/rastro-update.conf

mkdir -p "$APP_DIR/.update"
rm -f "$APP_DIR/.update/request"
printf '{"branch":"%s","installedAt":"%s"}\n' "$BRANCH" "$(date -Is)" > "$APP_DIR/.update/installed"
chown -R "$APP_OWNER" "$APP_DIR/.update"
chmod 775 "$APP_DIR/.update"

cat > /etc/systemd/system/rastro-update.service <<UNIT
[Unit]
Description=RASTRO - atualizacao solicitada pelo painel

[Service]
Type=oneshot
ExecStart=/bin/bash $APP_DIR/scripts/update.sh
TimeoutStartSec=30min
UNIT

cat > /etc/systemd/system/rastro-update.path <<UNIT
[Unit]
Description=RASTRO - aguarda o botao "Atualizar sistema"

[Path]
PathExists=$APP_DIR/.update/request
Unit=rastro-update.service

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now rastro-update.path >/dev/null 2>&1
systemctl is-active --quiet rastro-update.path || die "Não foi possível ativar rastro-update.path."
ok "Serviço de atualização ativo"

echo
echo "Pronto! Agora, no RASTRO, entre como Desenvolvedor → Integração → \"Atualizar sistema\"."
echo "Log da última atualização: $APP_DIR/.update/update.log  (ou: journalctl -u rastro-update)"
