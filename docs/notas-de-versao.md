# Notas de versão — RASTRO

As notas de cada atualização aparecem dentro do sistema (Sistema › Artefatos da plataforma › Notas de versão), a partir das descrições dos Pull Requests aplicados.

## Versão 0.1.0 — primeira versão (Pull Request inicial)

- Fundação: login com senha e código por e-mail (2FA), dispositivo confiável por 30 dias, bloqueio por inatividade com PIN, perfis e isolamento por loja verificados no servidor, auditoria encadeada por SHA-256.
- Operação geográfica: lojas com localização, territórios por raio ou perímetro desenhado, pontos de interesse, campanhas com responsáveis, situação e histórico.
- Planejamento de ruas: busca das ruas do OpenStreetMap dentro do território e escolha das ruas anunciadas.
- Rastreamento: Modo campo no navegador (com fila sem internet), sessões sem duplicidade, pontos recusados guardados com motivo, acompanhamento ao vivo.
- Análise: percurso sem ligar falhas de sinal, cobertura estimada (metodologia v1), painel Matriz e da loja, relatórios com exportação CSV.
- Infraestrutura: telas Sistema, Integração, Auditoria, Dispositivos e Segurança da conta; chaves de API, webhooks e botão "Atualizar sistema" com volta automática.

## Gestor da franquia e Painel da loja

- Novo perfil **Gestor da franquia**, cadastrado pelo Administrador: vê todas as lojas e todos os percursos, cadastra lojas e as pessoas de cada loja.
- Novo **Painel da loja**, com mapa, indicadores e pessoas da loja.
- **Localização da loja pelo GPS**, registrada de dentro da loja, com orientação na tela, conferência no mapa e precisão mínima.

## App Android do RASTRO (rastreamento em segundo plano)

- Novo **aplicativo Android** para o divulgador: abre o Modo campo, e depois de tocar em **Iniciar** registra o percurso **com a tela apagada e o celular no bolso** (serviço do Android com notificação fixa enquanto rastreia).
- Sem internet, os pontos ficam guardados no celular e são enviados sozinhos quando a conexão volta, inclusive depois de encerrar.
- Avisos no próprio app quando falta permissão de localização, o GPS está desligado ou a economia de bateria pode pausar o GPS, com botões para corrigir.
- Nova página pública **/app** (sem login) com o botão de download e o passo a passo de instalação.
- Botões **Enviar app** (na lista de usuários e nas pessoas da loja) e **Compartilhar app** no Painel da loja: abrem o compartilhamento do celular ou o WhatsApp com o link pronto.
- No navegador de celulares Android, o Modo campo agora sugere instalar o app.
- O APK é gerado automaticamente pelo GitHub a cada atualização da pasta do app e fica sempre no mesmo link: `https://rastro.gestaohummm.com.br/app/rastro.apk`.

## Login, Integração e atualização automática

- Enquanto o e-mail (SMTP) não estiver configurado, **todas as pessoas entram só com a senha** (antes, só o TI entrava e os outros viam "O RASTRO ainda está sendo configurado"). Depois que o e-mail é configurado e testado, o código por e-mail volta a valer para todos.
- A tela **Integração** não pede mais a senha de novo (continua exclusiva do Desenvolvedor). O botão "Atualizar" também não pede senha.
- **Atualização automática**: o sistema confere o GitHub a cada 30 segundos e, quando há versão nova na main (merge de um Pull Request), se atualiza sozinho, com a mesma volta automática se algo falhar. Para desligar: `AUTO_UPDATE=false` no `.env`.
- Depois da atualização, **as telas abertas recarregam sozinhas** e mostram o aviso "O RASTRO foi atualizado". Durante um rastreamento pelo navegador, a tela espera o rastreamento terminar.

## Percurso em roxo no Mapa e no Painel da loja

- O percurso do divulgador agora aparece como uma **linha roxa grossa** (com contorno) do início ao fim do rastreamento, destacando as ruas por onde ele passou.
- **Painel da loja** passou a mostrar os percursos da loja (últimos 30 dias) e quem está em campo agora.
- **Mapa**: já abre com todas as lojas do perfil marcadas (antes, na Matriz, nada aparecia até escolher uma loja) e a linha vai sendo desenhada **ao vivo** enquanto o divulgador anda.
- Correção: percursos iniciados depois das 21h (horário de Brasília) não entravam no filtro "até hoje", porque o banco comparava as datas em UTC. Agora os filtros por dia usam o horário de Brasília (`APP_TIMEZONE` no `.env` para trocar).
- Nova configuração em Integração: **precisão mínima do GPS para desenhar o percurso** (padrão 65 m). A cobertura das ruas continua usando a regra mais rigorosa (30 m).

## Versão para celular

- **Barra de atalhos embaixo** no celular (Painel, Mapa, Percursos, Campanhas e "Mais"; para o divulgador, Campo e Percursos). O "Mais" abre o menu completo em blocos, com o nome da pessoa e o botão Sair.
- **Tabelas viram cartões** no celular (Percursos, Campanhas, Unidades, Usuários, Auditoria...): cada informação aparece com o nome ao lado, sem precisar arrastar para o lado.
- **Mapa no celular**: abre limpo, ocupando a tela; "Camadas e filtros" sobe de baixo e o botão "Ver mapa" fecha. Resumo da loja compacto no topo.
- Filtros de período mais compactos (datas lado a lado), indicadores sem cortar texto, mapas com altura proporcional à tela, janelas que rolam quando o conteúdo é grande e respeito ao entalhe e à barra de gestos do celular.
- Campos com letra de 16 px no celular, para o iPhone não dar zoom ao tocar.
