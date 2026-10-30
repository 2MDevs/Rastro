# RASTRO — Inteligência em movimento.

Plataforma de inteligência geográfica para planejar e acompanhar a distribuição de panfletos e outras operações externas das lojas da Hummm! Pizzas.

O RASTRO relaciona quatro coisas: o **território planejado** de cada loja, as **ruas anunciadas** de cada campanha, o **percurso realizado** registrado pelo GPS e a **cobertura estimada** que resulta disso. A Matriz acompanha todas as lojas; cada loja vê só os próprios dados.

> O GPS comprova o deslocamento registrado pelo aparelho. Ele não comprova, sozinho, a entrega dos panfletos. Por isso o sistema fala em "percurso realizado", "rua percorrida" e "cobertura estimada".

Responsável técnico: Marcos Monteiro — TI da Hummm! Pizzas.
Domínio planejado: `rastro.gestaohummm.com.br` (ainda **não configurado**).

---

## Situação atual

Primeira versão (fundação + operação geográfica + rastreamento + análise). O que já existe e o que falta está detalhado em [docs/documentacao-do-projeto.md](docs/documentacao-do-projeto.md), seção "Situação e pendências". Resumo das pendências:

- **App Android nativo**: ainda não existe. Hoje o rastreamento é feito pelo **Modo campo** no navegador, com a tela ligada (ver limitações).
- **Equipamento GPS dedicado**: modelo e protocolo A definir. A API de recebimento está pronta para um adaptador ([docs/integracao-gps.md](docs/integracao-gps.md)).
- **Mapa de fundo**: precisa gerar o arquivo da região na VPS ([docs/mapa-de-fundo.md](docs/mapa-de-fundo.md)).
- **Retenção dos dados de localização (LGPD)**: A definir, com avaliação jurídica.
- **Calibração da cobertura**: parâmetros iniciais, a ajustar no teste de campo com a loja-piloto.
- Cronograma e custos: A definir.

## Tecnologia

| Parte | Escolha |
| --- | --- |
| Interface | React + Vite + Tailwind CSS, PWA instalável, tema escuro e claro, fonte Poppins |
| Servidor | Node.js + Express + TypeScript executado com `tsx` |
| Banco | PostgreSQL (migrações versionadas em `server/migrations`) |
| Mapas | MapLibre GL + arquivo PMTiles hospedado no próprio servidor (OpenStreetMap) |
| Ruas | Overpass API (OpenStreetMap), recortadas pelo território da campanha |
| Endereços | Nominatim (1 busca por segundo) ou marcação manual no mapa |
| Tempo real | SSE (Server-Sent Events) |
| Autenticação | Padrão dos projetos Hummm! (senha + 2FA por e-mail + sessão no PostgreSQL) |

Decisões e motivos estão em [docs/decisoes-tecnicas.md](docs/decisoes-tecnicas.md).

## Rodar localmente

Requisitos: Node.js 20+ e PostgreSQL 14+.

```bash
cp .env.example .env          # preencha DATABASE_URL, SETTINGS_ENCRYPTION_KEY, DEVELOPER_EMAILS, ADMIN_EMAIL, ADMIN_INITIAL_PASSWORD
npm install
npm run dev                   # http://localhost:PORT (migrações rodam sozinhas ao iniciar)
```

Testes automáticos (usam um banco separado, que é apagado e recriado a cada arquivo de teste):

```bash
createdb rastro_test
TEST_DATABASE_URL=postgresql://USUARIO:SENHA@127.0.0.1:5432/rastro_test npm test
npm run typecheck
```

## Primeiro acesso

1. Com `ADMIN_EMAIL` e `ADMIN_INITIAL_PASSWORD` no `.env`, o sistema cria o **administrador inicial** na primeira inicialização (troca de senha obrigatória).
2. Enquanto o e-mail (SMTP) não for configurado **e testado**, só o desenvolvedor (e-mails em `DEVELOPER_EMAILS`) e o administrador inicial entram, sem código por e-mail.
3. O administrador inicial cadastra o desenvolvedor em **Usuários** (o e-mail que está em `DEVELOPER_EMAILS` vira Desenvolvedor automaticamente).
4. O desenvolvedor abre **Integração**, configura o SMTP e envia o **e-mail de teste**. A partir daí, o código por e-mail (2FA) vale para todos.

## Instalação na VPS (comandos para o Marcos rodar)

A VPS é compartilhada: os comandos abaixo criam só o que é do RASTRO (pasta, banco, usuário do banco, serviço e site) e não mexem em outros projetos. Troque os valores entre `< >`.

```bash
# 1. Código
cd /var/www && sudo git clone https://github.com/2MDevs/Rastro.git rastro && cd rastro
sudo chown -R <usuario_da_app>:<usuario_da_app> /var/www/rastro

# 2. Banco exclusivo do RASTRO
sudo -u postgres psql -c "CREATE ROLE rastro LOGIN PASSWORD '<senha_forte>';"
sudo -u postgres psql -c "CREATE DATABASE rastro_db OWNER rastro;"

# 3. Configuração
cp .env.example .env && nano .env        # PORT livre, DATABASE_URL, chaves etc.
openssl rand -base64 32                  # valor para SETTINGS_ENCRYPTION_KEY

# 4. Instalar, gerar a versão de produção e iniciar
npm ci && npm run build
```

Serviço systemd próprio (`/etc/systemd/system/rastro.service`):

```ini
[Unit]
Description=RASTRO
After=network.target postgresql.service

[Service]
WorkingDirectory=/var/www/rastro
ExecStart=/usr/bin/npx tsx server.ts
Environment=NODE_ENV=production
User=<usuario_da_app>
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now rastro
curl -s http://127.0.0.1:<PORT>/api/health
```

No Nginx, crie um `server` só para o domínio do RASTRO, com HTTPS, apontando para `http://127.0.0.1:<PORT>` e **sem buffer** para o tempo real:

```nginx
location / {
  proxy_pass http://127.0.0.1:<PORT>;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_buffering off;              # necessário para /api/events (tempo real)
  proxy_read_timeout 1h;
  client_max_body_size 30m;
}
```

Botão "Atualizar sistema" (uma vez só):

```bash
sudo bash scripts/install-auto-update.sh
```

Ele cria apenas `/etc/rastro-update.conf` e as unidades `rastro-update.path` / `rastro-update.service`.

## Variáveis de ambiente

Prioridade: **Banco (tela Integração) > .env > padrão**. A tela Integração mostra de onde veio cada valor e nunca mostra segredos.

| Variável | Obrigatória | Padrão | Para que serve |
| --- | --- | --- | --- |
| `DATABASE_URL` | sim | — | Banco exclusivo do RASTRO |
| `PORT` | sim | 3000 | Porta local (confira as portas dos outros projetos) |
| `APP_URL` | sim em produção | — | Endereço público com https (links dos e-mails) |
| `NODE_ENV` | sim | — | `production` na VPS |
| `SETTINGS_ENCRYPTION_KEY` | sim | — | 32 bytes em base64 (AES-256-GCM dos segredos) |
| `DEVELOPER_EMAILS` | sim | — | E-mails que viram perfil Desenvolvedor |
| `ADMIN_EMAIL` | sim no 1º uso | — | Administrador inicial |
| `ADMIN_INITIAL_PASSWORD` | sim no 1º uso | — | Senha provisória do administrador inicial |
| `SESSION_TTL_HOURS` | não | 8 | Validade da sessão |
| `LOCK_IDLE_MINUTES` | não | 10 | Bloqueio da tela por inatividade |
| `PIN_MAX_ATTEMPTS` | não | 5 | Erros de PIN antes de encerrar a sessão |
| `SMTP_HOST` `SMTP_PORT` `SMTP_SECURE` `SMTP_USER` `SMTP_PASS` `SMTP_FROM` | sim para 2FA | 587 / false | Envio de e-mails |
| `BASEMAP_DIR` | não | `./basemap` | Pasta do arquivo .pmtiles |
| `BASEMAP_PMTILES_FILE` | não | — | Nome do arquivo do mapa de fundo |
| `OVERPASS_URL` | não | overpass-api.de | Ruas do OpenStreetMap |
| `NOMINATIM_URL` | não | nominatim.openstreetmap.org | Busca de endereços |
| `STORAGE_DIR` | não | `./storage` | Artefatos substituídos pela tela |
| `AUTH_RATE_LIMIT` | não | 10 | Tentativas por IP a cada 15 min (login, código, senha) |

## Estrutura

```
server.ts                 inicialização (migrações, administrador inicial, rotinas)
server/app.ts             rotas da API e segurança HTTP
server/migrations/        estrutura do banco (versionada)
server/auth/              login, 2FA, sessão, PIN, chaves de API
server/access.ts          perfis, permissões e isolamento por loja
server/audit.ts           auditoria encadeada por SHA-256
server/services/geo.ts    percurso, recorte de ruas e cálculo de cobertura
server/routes/            lojas, territórios, campanhas, rastreamento, relatórios, sistema...
src/                      interface (React)
public/brand/             identidade visual RASTRO (SVG/PNG)
public/map-assets/        fontes dos rótulos do mapa (OFL)
scripts/                  atualização automática e geração dos PDFs
docs/                     documentação e artefatos da plataforma
tests/                    testes automáticos
```

## Fluxo de código

Trabalhar em branch, abrir Pull Request com descrição clara (vira a nota de versão dentro do sistema). O Marcos faz o merge e aplica pelo botão **Atualizar sistema**.
