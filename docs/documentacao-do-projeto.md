# RASTRO — Documentação do projeto

**Inteligência em movimento.** Plataforma de inteligência geográfica e rastreabilidade de operações externas da Hummm! Pizzas.

Versão do documento: 0.1.0 · Responsável técnico: Marcos Monteiro — TI da Hummm! Pizzas · Repositório: github.com/2MDevs/Rastro · Domínio planejado: rastro.gestaohummm.com.br (a configurar)

## 1. Visão geral

O RASTRO ajuda a administração a planejar e acompanhar a distribuição de panfletos (e outras operações externas) das lojas, usando mapas e GPS.

Ele relaciona quatro informações:

1. **Território planejado**: a área de atuação de cada loja (um raio a partir da loja ou um perímetro desenhado).
2. **Ruas anunciadas**: as ruas escolhidas para receber panfletagem numa campanha.
3. **Percurso realizado**: o caminho registrado pelo GPS do aparelho de quem foi a campo.
4. **Cobertura estimada**: quanto das ruas planejadas foi percorrido.

O GPS mostra o deslocamento do aparelho. Ele **não comprova, sozinho, a entrega** dos panfletos. Por isso o sistema usa sempre as expressões "percurso realizado", "rua percorrida" e "cobertura estimada".

## 2. Perfis e permissões

Todas as permissões são verificadas **no servidor**, em cada operação. Esconder um botão na tela não é a proteção: mesmo chamando o servidor diretamente, a pessoa não acessa o que não pode.

| Perfil | Enxerga | Pode |
| --- | --- | --- |
| Desenvolvedor (TI) | Todas as lojas | Tudo, inclusive Integração, atualização do sistema e substituição de artefatos |
| Administrador | Todas as lojas (Painel Matriz) | Lojas, territórios, campanhas, usuários, dispositivos, auditoria, Sistema, chaves de API. Não altera a infraestrutura |
| Diretor | Todas as lojas (Painel Matriz) | O mesmo que o Administrador |
| Gestor da franquia | Todas as lojas e todos os percursos (Painel Matriz) | Cadastra lojas, abre o painel de cada loja, cadastra e vincula as pessoas das lojas (gerentes e divulgadores), territórios, campanhas e relatórios. É cadastrado pelo Administrador. Não vê auditoria, Sistema nem Integração |
| Coordenador | Todas as lojas (Painel Matriz) | Territórios, campanhas, percursos e relatórios. Não gerencia usuários |
| Gerente de loja | Só as lojas vinculadas a ele | Painel da loja, registro da localização da loja pelo GPS, territórios, campanhas, percursos e relatórios das suas lojas |
| Divulgador | Só as campanhas em que é responsável | Modo campo (iniciar e encerrar o rastreamento) e os próprios percursos |

Regras importantes:

- Um gerente nunca vê dados de outra loja. Se tentar abrir um endereço de outra loja, o sistema responde como se ela não existisse.
- Uma pessoa pode trabalhar em mais de uma loja, se a administração vincular.
- Ninguém cria usuário com perfil acima do seu.
- Os e-mails listados em `DEVELOPER_EMAILS` (no servidor) sempre têm o perfil Desenvolvedor.
- Bloquear um usuário encerra todas as sessões dele na hora.

## 3. Telas e funções

### 3.1 Login e acesso

- **Login** com e-mail e senha. Senha com pelo menos 10 caracteres, letras e números, guardada só como hash (bcrypt).
- **Código por e-mail (2FA)** em todo aparelho novo: 6 números, válido por 10 minutos, reenvio liberado depois de 60 segundos, cancelado depois de 5 erros.
- **Confiar neste dispositivo por 30 dias**: depois do código, a pessoa pode marcar o aparelho como confiável. Em aparelho compartilhado, deve deixar desmarcado.
- **5 senhas erradas** bloqueiam a conta por 15 minutos. Cada endereço de internet tem no máximo 10 tentativas a cada 15 minutos nas telas de login, código e senha.
- **Esqueci minha senha**: link de uso único por e-mail, válido por 30 minutos.
- **Bloqueio por inatividade**: depois de 10 minutos sem uso, a tela bloqueia e só libera com PIN (ou senha). 5 erros encerram a sessão. Enquanto a tela está bloqueada, o servidor recusa qualquer ação. Exceção: durante um rastreamento ativo no Modo campo a tela não bloqueia, para não interromper o registro do GPS.

### 3.2 Painel

- **Painel Matriz** (Administrador, Diretor, Coordenador, Desenvolvedor): lojas cadastradas e em operação, campanhas ativas, quem está em campo agora, percursos e tempo em campo no período, cobertura estimada consolidada, mapa com as lojas e as posições ao vivo, e a **comparação entre lojas**.
- **Painel da loja** (Gerente): os mesmos indicadores só das suas lojas.
- "Loja cadastrada" não é "loja em operação": em operação é a loja com pelo menos uma campanha ativa.
- Todos os números vêm do banco. Sem dados, a tela explica o que falta.

### 3.3 Mapa

O mapa é o centro do sistema. Painel lateral **Camadas de exibição**, cada uma ligada e desligada separadamente:

| Camada | Como aparece | O que representa |
| --- | --- | --- |
| Unidade (loja) | Marcador amarelo com o símbolo RASTRO | Localização cadastrada da loja |
| Área de cobertura | Amarelo translúcido com borda tracejada | Alcance configurado (raio ou perímetro) |
| Ruas anunciadas | Amarelo (não percorrida), laranja (parcial), verde (percorrida) | Ruas planejadas e a situação no último cálculo |
| Percursos realizados | Linha roxa grossa | Caminho feito pelo divulgador do início ao fim do rastreamento (falhas de sinal não são ligadas). Aparece no Mapa, no Painel da loja e no detalhe do percurso, e vai sendo desenhado ao vivo |
| Pontos de interesse | Círculo roxo | Condomínios, comércios, pontos de apoio etc. |
| Em campo agora | Ponto roxo (cinza = sem comunicação) | Última posição de quem está rastreando |

A legenda muda conforme as camadas ligadas. Ao clicar numa loja, rua, percurso, área ou ponto, abre um painel de detalhes (um de cada vez). Na Matriz, o usuário escolhe quais lojas detalhar, para não mostrar tudo de todas as lojas ao mesmo tempo. Filtros: campanha e período dos percursos. Com uma loja escolhida, a faixa do topo mostra área de cobertura, percurso realizado e tempo em campo.

### 3.4 Unidades e Painel da loja

**Fluxo de cadastro:** o Administrador cadastra o **Gestor da franquia**; o Gestor cadastra as **lojas**; em cada loja, o Gestor cria ou vincula as **pessoas** (gerente e divulgadores); no **Painel da loja**, a localização da loja é registrada pelo GPS do celular, de dentro da loja.

- **Unidades**: lista de lojas (código, nome, endereço, situação, origem da localização). Quem tem uma loja só vai direto para o painel dela.
- **Painel da loja**: mapa com a loja e os territórios, campanhas ativas, quem está em campo, distância percorrida e cobertura dos últimos 30 dias, atalhos para o mapa e as campanhas da loja.
- **Registrar localização (GPS dentro da loja)**: a tela orienta a pessoa a estar dentro da loja, usar o celular com a localização precisa ligada e ficar perto da porta ou do balcão. O GPS é lido por até 30 segundos e a leitura mais precisa é usada. A pessoa confere o marcador no mapa e confirma que está dentro da loja. Precisão acima de 100 m não é aceita. Fica registrado quem registrou, quando e com qual precisão (também na auditoria). A localização só é lida nesse momento; nada é rastreado depois.
- A localização também pode ser marcada no mapa (busca de endereço ou clique) pelo Gestor/Administração ao editar a loja; nesse caso aparece como "Marcada no mapa", com a recomendação de registrar pelo GPS.
- **Pessoas da loja** (Gestor e Administração): lista de quem está vinculado, "Nova pessoa" (já vinculada à loja) e "Vincular pessoa já cadastrada". Desvincular tira o acesso da pessoa à loja na hora; a última loja de uma pessoa não pode ser removida (bloqueie o acesso em Usuários).

### 3.5 Territórios

- **Raio da loja**: alcance em metros a partir da loja, ajustado com um controle deslizante e pré-visualizado no mapa.
- **Perímetro desenhado**: o usuário clica os cantos da área no mapa. O sistema recusa perímetros com bordas cruzadas, pequenos ou grandes demais.
- O raio é uma aproximação; para seguir os limites reais do bairro, o perímetro é melhor.
- **Pontos de interesse**: marcados no mapa com nome, categoria e observações.
- Territórios são arquivados (não apagados), preservando o histórico das campanhas.

### 3.6 Campanhas

Uma campanha reúne: loja, nome, descrição, território, datas (vazio = A definir), responsáveis, ruas planejadas, percursos e o resultado da cobertura.

- **Situações**: Rascunho, Planejada, Ativa, Pausada, Concluída, Cancelada. O rastreamento só começa em campanha **Ativa**. Cancelar é definitivo. Concluída pode ser reaberta.
- **Planejamento de ruas**: "Buscar ruas do território" consulta o OpenStreetMap e recorta as ruas pela área. O usuário escolhe as ruas (por nome, todas de uma vez ou clicando no mapa) e salva. Rua planejada nunca é considerada percorrida automaticamente.
- **Cobertura**: resultado por rua e total, com a explicação da metodologia e o botão "Recalcular agora".
- **Histórico**: todas as alterações, com pessoa e data.

### 3.7 Modo campo (Divulgador)

- Mostra as campanhas em que a pessoa é responsável.
- **Iniciar**: o sistema avisa claramente que a localização será registrada só durante o rastreamento e pede a permissão do navegador. Não existe rastreamento oculto.
- Durante o rastreamento: precisão do GPS, pontos registrados, pontos aguardando envio, último envio e situação da internet.
- **Sem internet**, os pontos ficam guardados no aparelho e são enviados quando a conexão voltar, sem duplicar.
- **Encerrar** envia o que falta; se estiver sem internet, o encerramento é enviado depois.
- **Limitação**: no navegador, o GPS pode parar se a tela apagar ou se a pessoa trocar de aplicativo. O sistema mantém a tela acesa quando o navegador permite e mostra "Continuar rastreamento" ao voltar. O app Android (próxima etapa) vai rastrear com a tela apagada.

### 3.8 Percursos

Lista de sessões de rastreamento com filtros (loja, situação, período). Situações: Aguardando, Em andamento, Sem comunicação, Sincronizando, Concluída, Interrompida. O detalhe mostra o percurso no mapa junto com as ruas planejadas, a distância válida, a duração, pontos válidos e descartados (imprecisos, saltos, recusados), precisão mediana e atraso médio de envio. Consultar o percurso de outra pessoa fica registrado na auditoria. Gestores podem encerrar uma sessão esquecida aberta.

### 3.9 Relatórios

Cobertura por campanha, histórico de percursos e comparação entre lojas, com filtros de loja, situação e período. Exportação em **CSV** (abre no Excel) e **impressão/PDF** pelo navegador. Toda exportação respeita as permissões e fica na auditoria.

### 3.10 Telas de administração

- **Usuários**: criar (a pessoa recebe por e-mail um link para criar a própria senha), editar perfil e lojas, bloquear, reenviar acesso.
- **Dispositivos**: aparelhos que acessam o sistema (Confiável, Pendente, Bloqueado, Revogado; aprovar, bloquear, revogar, remover; bloquear ou revogar encerra as sessões do aparelho na hora) e **aparelhos de rastreamento** (modo campo, app Android, equipamento GPS dedicado). Cada pessoa vê os próprios; a administração vê todos.
- **Auditoria**: registro imutável de tudo (login, falhas, 2FA, saída, bloqueios, consultas de percursos, exportações, usuários, lojas, territórios, campanhas, dispositivos, chaves, configurações, atualizações), com data e hora, pessoa, perfil, loja, ação, item, detalhes, resultado, IP e dispositivo. Filtros, busca, exportação CSV e **Conferir integridade** (refaz a corrente de hashes SHA-256).
- **Sistema**: recursos usados pelo RASTRO comparados com a VPS inteira (disco por tipo e por loja, memória, processador), dados reais do servidor e do banco, **API & Webhooks** com o guia "Como conectar outro sistema", e **Artefatos da plataforma** (esta documentação, manual rápido, roteiro de testes e notas de versão, com visualizar e baixar).
- **Integração** (só Desenvolvedor): atualização do sistema (automática depois de cada merge na main), e-mail (SMTP) com teste, segurança e sessão, administrador principal, mapas, parâmetros de cobertura e variáveis do `.env` (somente leitura, sem mostrar segredos).
- **Segurança da conta** (todos): trocar senha, criar/alterar/remover PIN, ver e encerrar as próprias sessões.

## 4. Segurança e proteção de dados (LGPD)

- **Em trânsito**: só HTTPS em produção; cabeçalhos de segurança (helmet, política de conteúdo), sem `x-powered-by`.
- **Em repouso**: senhas, PIN, códigos, tokens de sessão e de dispositivo e chaves de API guardados só como hash. Senha do e-mail e segredos de webhook criptografados com AES-256-GCM; a chave fica só no `.env` do servidor.
- **Isolamento por loja** em todas as consultas, exportações e eventos em tempo real.
- **Localização é dado pessoal**: coletada só durante o rastreamento iniciado pela pessoa, com aviso claro; acesso restrito por perfil; consultas de percursos de outras pessoas ficam na auditoria; aparelhos podem ser revogados.
- **Telefone** aparece mascarado nas listas.
- **Retenção** dos dados de localização: A definir após avaliação jurídica e operacional. Até lá, nada é apagado automaticamente.
- **Erros** nunca mostram detalhes técnicos na tela; ficam no log do servidor.
- **Chaves de API**: geradas no servidor (`rst_live_` + 64 caracteres), mostradas uma vez, guardadas só como hash, limitadas por escopo (só leitura, exceto `tracking:write`), revogáveis, com último uso e IP. Telas de login, sistema, integração e chaves nunca aceitam chave de API.
- **Webhooks**: só HTTPS público, assinados com HMAC-SHA256.

## 5. Guia técnico

### 5.1 Arquitetura

- Interface React + Vite + Tailwind (PWA instalável, tema escuro e claro).
- Servidor Node.js + Express + TypeScript (`tsx`).
- PostgreSQL com migrações versionadas (`server/migrations`), aplicadas sozinhas ao iniciar.
- Geometrias em GeoJSON; cálculos geográficos no servidor (`server/services/geo.ts`).
- Mapa de fundo em PMTiles hospedado no servidor (docs/mapa-de-fundo.md).
- Tempo real por SSE (`/api/events`), filtrado por loja.

### 5.2 Instalação e variáveis

Passo a passo e tabela completa de variáveis no `README.md`. Resumo: banco exclusivo `rastro_db`, `.env` com `DATABASE_URL`, `PORT`, `APP_URL`, `SETTINGS_ENCRYPTION_KEY`, `DEVELOPER_EMAILS`, `ADMIN_EMAIL`, `ADMIN_INITIAL_PASSWORD`; serviço systemd próprio; site próprio no Nginx com `proxy_buffering off`.

### 5.3 Atualização

1. Pull Request aprovado e mesclado na `main` pelo Marcos.
2. Integração › Atualização do sistema › **Verificar** mostra o que muda.
3. **Atualizar** (pede a senha) grava o pedido em `.update/request`.
4. O serviço `rastro-update` baixa a versão, instala, gera a versão nova em pasta separada, troca, reinicia e testa `/api/health`. Se falhar, **volta sozinho** para a versão anterior.
5. As telas abertas recarregam com a versão nova (exceto durante um rastreamento ativo no Modo campo).

Instalação do mecanismo: uma vez, `sudo bash scripts/install-auto-update.sh`.

### 5.4 Backup e restauração

- Banco: `pg_dump -Fc rastro_db > rastro_AAAAMMDD.dump` (agendar diariamente, guardar fora da VPS). Restaurar: `pg_restore -d rastro_db --clean rastro_AAAAMMDD.dump`.
- Guardar também o `.env` (principalmente a `SETTINGS_ENCRYPTION_KEY`) em local seguro: sem ela, os segredos salvos pela tela não podem ser lidos.
- Pasta `storage/` (artefatos substituídos) e o arquivo do mapa de fundo (pode ser gerado de novo).
- Política de backup (frequência, onde guardar, teste de restauração): A definir.

### 5.5 Solução de problemas

| Sintoma | O que verificar |
| --- | --- |
| Indicador "Desconectado" | `curl http://127.0.0.1:PORT/api/health`; serviço `rastro` ativo; banco no ar |
| Ninguém recebe o código por e-mail | Integração › E-mail: enviar e-mail de teste; conferir porta/segurança/remetente |
| Só o desenvolvedor consegue entrar | O e-mail de teste ainda não foi enviado com sucesso (modo de configuração inicial) |
| Mapa sem ruas/bairros de fundo | Arquivo .pmtiles não gerado ou nome errado em Integração › Mapas |
| "Buscar ruas" falha | Serviço Overpass ocupado ou fora do ar: tentar depois ou trocar o endereço em Integração |
| Posições ao vivo não atualizam | Nginx com `proxy_buffering off` para o RASTRO |
| Rastreamento parou no celular | Tela apagou ou trocou de aplicativo (limitação do navegador): voltar à página e tocar em "Continuar" |
| "Sem comunicação" | Aparelho sem internet (os pontos chegam depois) ou rastreamento parado |
| Atualização falhou | Integração › Atualização › Ver registro; o sistema já voltou para a versão anterior |

## 6. Situação e pendências

| Item | Situação |
| --- | --- |
| Fundação (login, 2FA, sessões, PIN, perfis, isolamento por loja, auditoria) | Implementado; testes automáticos escritos, **execução pendente** |
| Lojas, territórios, pontos de interesse, campanhas, planejamento de ruas | Implementado |
| Modo campo no navegador, sessões, pontos, sincronização sem duplicar | Implementado; testes automáticos escritos, **execução e homologação em campo pendentes** |
| Cobertura estimada (metodologia v1) | Implementado; núcleo geográfico testado; **calibração no piloto pendente** |
| Painel Matriz, mapa com camadas, relatórios | Implementado |
| Sistema, Integração, Dispositivos, Segurança da conta, API & Webhooks, atualização | Implementado; **instalação e teste do rollback na VPS pendentes** |
| App Android nativo | **A fazer** (prazo e responsável: A definir) |
| Adaptador de equipamento GPS dedicado | **A fazer** quando o modelo for definido |
| Mapa de fundo da região | **A gerar** na VPS |
| Domínio rastro.gestaohummm.com.br e HTTPS | **A configurar** |
| Retenção dos dados de localização | **A definir** (avaliação jurídica) |
| Cronograma e custos | **A definir** |

Nada foi homologado em produção. "Implementado" significa código pronto. Os testes automáticos (pasta tests/) ainda não foram executados com as dependências instaladas: a primeira execução (`npm install` e `npm test`) é o próximo passo antes do merge. Só o núcleo geográfico (percurso, recorte de ruas e cobertura) foi testado durante o desenvolvimento.
