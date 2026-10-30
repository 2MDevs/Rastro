# RASTRO — Roteiro de testes (homologação)

Marque cada item só depois de testar de verdade. Para cada teste, registre: **data, aparelho/navegador, versão (Sistema › Artefatos › Notas de versão), loja, o que fez, o que esperava, o que aconteceu, print** e quem testou.

## Como registrar uma sugestão ou problema

| Campo | Exemplo |
| --- | --- |
| O que você fez | Abri a campanha "Bairro X" e cliquei em Buscar ruas |
| O que esperava | Ver as ruas do território |
| O que aconteceu | Apareceu "O serviço de ruas não respondeu a tempo" |
| Print | (anexar) |
| Aparelho e navegador | Celular Android, Chrome |

## 1. Acesso e segurança

- [ ] Primeiro acesso do administrador inicial obriga a trocar a senha
- [ ] Enquanto o e-mail não foi testado, só desenvolvedor e administrador inicial entram
- [ ] E-mail de teste enviado em Integração; depois disso o código por e-mail é pedido em aparelho novo
- [ ] Código errado 5 vezes cancela o código
- [ ] "Reenviar código" só libera depois de 60 segundos
- [ ] "Confiar neste dispositivo" dispensa o código no próximo acesso; revogar a confiança volta a pedir
- [ ] 5 senhas erradas bloqueiam por 15 minutos
- [ ] Esqueci minha senha: o link funciona uma vez só
- [ ] Bloqueio por inatividade; desbloqueio com PIN e com senha; 5 erros encerram a sessão
- [ ] Bloquear um usuário derruba a sessão dele na hora
- [ ] Bloquear um dispositivo derruba a sessão daquele aparelho na hora

## 2. Perfis e isolamento entre lojas

- [ ] Gerente da loja A não vê nada da loja B (Painel, Mapa, Campanhas, Percursos, Relatórios, exportações)
- [ ] Gerente da loja A não abre um link de campanha da loja B (aparece "não encontrada")
- [ ] Coordenador vê todas as lojas e não acessa Usuários nem Auditoria
- [ ] Divulgador só vê o Modo campo, os próprios percursos e as campanhas em que é responsável
- [ ] Administrador não acessa Integração

## 3. Lojas, territórios e campanhas

- [ ] Cadastrar loja com busca de endereço e com clique no mapa
- [ ] Criar território por raio e ajustar o alcance
- [ ] Desenhar um perímetro (e ver a recusa ao cruzar as bordas)
- [ ] Criar pontos de interesse
- [ ] Criar campanha com datas "A definir" e responsáveis
- [ ] Buscar ruas do território e escolher as ruas anunciadas
- [ ] Ativar, pausar, concluir e reabrir a campanha; conferir o histórico

## 4. Rastreamento em campo (loja-piloto)

- [ ] Iniciar o rastreamento: aparece o aviso de coleta de localização
- [ ] Caminhar por ruas planejadas: o ponto aparece ao vivo no Mapa e no Painel
- [ ] Ficar sem internet por alguns minutos: os pontos chegam depois, sem duplicar
- [ ] Apagar a tela e voltar: "Continuar rastreamento" funciona
- [ ] Passar por área sem sinal (túnel, prédio): o percurso não liga os pontos distantes
- [ ] Encerrar: a cobertura é calculada sozinha
- [ ] Comparar a cobertura com o que a equipe realmente fez (anotar para calibrar os parâmetros)
- [ ] Bloquear o aparelho de rastreamento: os novos pontos são recusados

## 5. Mapa e interface

- [ ] Ligar e desligar cada camada; a legenda acompanha
- [ ] Clicar em loja, área, rua, percurso e ponto de interesse abre os detalhes
- [ ] Matriz: escolher quais lojas detalhar
- [ ] Tema escuro e claro
- [ ] Uso no celular (todas as telas) e instalação como aplicativo (PWA)
- [ ] Nenhum dado de exemplo: telas vazias explicam o que falta

## 6. Relatórios e auditoria

- [ ] Relatórios de cobertura, percursos e comparação entre lojas, com exportação CSV
- [ ] Imprimir/salvar em PDF
- [ ] Exportações aparecem na Auditoria
- [ ] "Conferir integridade" da Auditoria

## 7. Infraestrutura

- [ ] `/api/health` responde com o banco no ar
- [ ] Sistema › Recursos e Servidor mostram números reais
- [ ] Chave de API: criada, mostrada uma vez, funciona com o escopo e para ao revogar
- [ ] Webhook: teste de envio
- [ ] Atualizar sistema: atualização com sucesso
- [ ] Atualizar sistema: simular falha e conferir a volta automática para a versão anterior
- [ ] Backup do banco e teste de restauração
- [ ] Nenhum outro projeto da VPS foi alterado
