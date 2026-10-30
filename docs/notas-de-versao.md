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
