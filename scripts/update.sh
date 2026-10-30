#!/usr/bin/env bash
# =============================================================================
# RASTRO — atualizador executado pelo serviço systemd `rastro-update`
# (disparado quando o botão "Atualizar sistema" grava .update/request).
#
# Fluxo: baixa o código do GitHub → instala dependências → gera o build numa
# pasta separada → troca o build → reinicia → testa /api/health.
# Se qualquer etapa falhar, volta para a versão anterior automaticamente.
#
# Configuração: /etc/rastro-update.conf (criado por install-auto-update.sh)
#
# Observação: as migrações do banco rodam quando o sistema reinicia. Elas só
# acrescentam (nunca apagam) estruturas, por isso a versão anterior continua
# funcionando se for preciso voltar.
# =============================================================================

# Todo o script fica dentro de main(): o bash lê a função inteira antes de
# executar, então o "git reset" abaixo pode atualizar este próprio arquivo
# sem quebrar a execução em andamento.
main() {
  set -uo pipefail

  local CONF=/etc/rastro-update.conf
  [ -f "$CONF" ] || { echo "Arquivo $CONF não encontrado."; exit 1; }
  # shellcheck disable=SC1090
  source "$CONF"

  : "${APP_DIR:?}" "${BRANCH:=main}" "${APP_OWNER:=root}" "${RESTART_CMD:?}" "${HEALTH_URL:?}"
  [ -n "${NODE_BIN_DIR:-}" ] && export PATH="$NODE_BIN_DIR:$PATH"

  local STATE_DIR="$APP_DIR/.update"
  local REQUEST="$STATE_DIR/request"
  local STATUS="$STATE_DIR/status.json"
  local LOG="$STATE_DIR/update.log"
  mkdir -p "$STATE_DIR"

  # Lê quem pediu e apaga a solicitação (senão o systemd dispara de novo)
  local REQUESTED_BY="painel"
  if [ -f "$REQUEST" ]; then
    REQUESTED_BY=$(sed -n 's/.*"requestedBy":"\([^"]*\)".*/\1/p' "$REQUEST")
    rm -f "$REQUEST"
  fi
  [ -n "$REQUESTED_BY" ] || REQUESTED_BY="painel"

  : > "$LOG"
  exec > >(tee -a "$LOG") 2>&1

  local STARTED_AT FROM TO=""
  STARTED_AT=$(date -Is)

  git_() { git -c safe.directory="$APP_DIR" -C "$APP_DIR" "$@"; }
  as_owner() {
    if [ "$APP_OWNER" = "root" ]; then "$@"; else runuser -u "$APP_OWNER" -- env PATH="$PATH" HOME="$APP_DIR" "$@"; fi
  }
  write_status() { # state message
    local msg=${2//\"/\'}
    cat > "$STATUS.tmp" <<JSON
{"state":"$1","message":"$msg","requestedBy":"$REQUESTED_BY","startedAt":"$STARTED_AT","finishedAt":"$( [ "$1" = running ] || date -Is )","fromCommit":"$FROM","toCommit":"$TO"}
JSON
    mv "$STATUS.tmp" "$STATUS"
    chown "$APP_OWNER" "$STATUS" 2>/dev/null || true
  }
  step() { echo; echo "==> $(date '+%H:%M:%S') $*"; write_status running "$*"; }

  health_ok() {
    local i
    for i in $(seq 1 30); do
      curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1 && return 0
      sleep 2
    done
    return 1
  }

  build() { # gera o build em dist-next e troca pelo dist atual
    cd "$APP_DIR" || return 1
    if [ -f package-lock.json ]; then as_owner npm ci --no-audit --no-fund || return 1
    else as_owner npm install --no-audit --no-fund || return 1; fi
    rm -rf dist-next
    as_owner npx vite build --outDir dist-next --emptyOutDir || return 1
    [ -f dist-next/index.html ] || return 1
    rm -rf dist-prev
    [ -d dist ] && mv dist dist-prev
    mv dist-next dist
  }

  rollback() { # reason
    echo; echo "!!! $1 — voltando para a versão anterior ($FROM)"
    write_status running "Falhou: $1. Restaurando a versão anterior..."
    git_ reset --hard -q "$FROM"
    chown -R "$APP_OWNER" "$APP_DIR" 2>/dev/null || true
    cd "$APP_DIR" && { if [ -f package-lock.json ]; then as_owner npm ci --no-audit --no-fund; else as_owner npm install --no-audit --no-fund; fi; }
    if [ "${2:-}" = "restore_dist" ] && [ -d "$APP_DIR/dist-prev" ]; then
      rm -rf "$APP_DIR/dist" && mv "$APP_DIR/dist-prev" "$APP_DIR/dist"
    fi
    if [ "${3:-}" = "restart" ]; then
      bash -c "$RESTART_CMD"
      health_ok || { write_status failed "Falhou: $1. A versão anterior foi restaurada, mas o sistema não respondeu. Verifique a VPS."; exit 1; }
    fi
    write_status failed "Falhou: $1. O sistema continua na versão anterior."
    exit 1
  }

  FROM=$(git_ rev-parse HEAD)
  echo "Atualização solicitada por $REQUESTED_BY em $STARTED_AT"
  echo "Versão atual: $(git_ log -1 --format='%h - %s')"

  step "Baixando atualizações do GitHub"
  git_ fetch -q origin "$BRANCH" || { write_status failed "Não foi possível acessar o GitHub."; exit 1; }
  TO=$(git_ rev-parse "origin/$BRANCH")

  if [ "$FROM" = "$TO" ]; then
    echo "O sistema já está na versão mais recente."
    write_status up_to_date "O sistema já está na versão mais recente."
    exit 0
  fi
  echo "Nova versão: $(git_ log -1 --format='%h - %s' "$TO")"
  git_ log --format='  • %h %s' "$FROM..$TO" | head -20

  git_ reset --hard -q "$TO"
  chown -R "$APP_OWNER" "$APP_DIR" 2>/dev/null || true

  step "Instalando dependências e gerando o build"
  build || rollback "erro ao instalar dependências ou gerar o build"

  step "Reiniciando o sistema"
  bash -c "$RESTART_CMD" || rollback "erro ao reiniciar o serviço" restore_dist restart

  step "Verificando se o sistema voltou"
  health_ok || rollback "o sistema não respondeu após reiniciar" restore_dist restart

  rm -rf "$APP_DIR/dist-prev"
  echo; echo "Atualizado com sucesso para $(git_ log -1 --format='%h - %s')"
  write_status success "Sistema atualizado com sucesso."
  exit 0
}

main "$@"; exit
