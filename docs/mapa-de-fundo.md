# Mapa de fundo (OpenStreetMap em arquivo PMTiles)

O RASTRO desenha as informações da operação (lojas, territórios, ruas, percursos) sobre um mapa de fundo. Para não depender do servidor público do OpenStreetMap (que não pode ser usado em produção) nem pagar por acesso, o mapa fica num **arquivo único `.pmtiles`** dentro da pasta `basemap/` do próprio RASTRO.

Enquanto o arquivo não existir, o sistema funciona normalmente: as camadas aparecem sobre um fundo neutro e a tela avisa que o mapa de fundo não foi configurado.

## Gerar o arquivo da região (comandos para o Marcos rodar na VPS)

1. Instale a ferramenta `pmtiles` (programa único, sem dependências) na pasta do projeto:

```bash
cd /var/www/rastro && mkdir -p basemap && cd basemap
# baixe a versão para Linux em https://github.com/protomaps/go-pmtiles/releases e extraia o executável "pmtiles" aqui
```

2. Escolha o retângulo da região de operação (oeste, sul, leste, norte) e extraia do mapa mundial público da Protomaps. Exemplo de formato (ajuste para as cidades das lojas):

```bash
./pmtiles extract https://build.protomaps.com/AAAAMMDD.pmtiles regiao.pmtiles --bbox=OESTE,SUL,LESTE,NORTE --maxzoom=15
```

Use uma data de versão que exista na lista de https://maps.protomaps.com/builds/. Para uma região metropolitana, o arquivo costuma ter de algumas dezenas a poucas centenas de MB (confira o espaço livre na tela Sistema).

3. No RASTRO, entre como Desenvolvedor → **Integração › Mapas** e informe o nome do arquivo (`regiao.pmtiles`). Pronto: o mapa aparece para todos.

Para atualizar o mapa (novas ruas), repita a extração com uma data mais nova e troque o arquivo.

## Alternativa: provedor contratado

Se a empresa preferir contratar um provedor de mapas, informe o endereço do estilo (https) em **Integração › Mapas**. O endereço substitui o arquivo .pmtiles. Custos, limites e licença do provedor: A definir antes de contratar.

## Créditos

Dados © colaboradores do OpenStreetMap (licença ODbL), exibidos no canto do mapa. Fontes dos rótulos: Noto Sans (licença SIL OFL, em `public/map-assets/fonts/OFL.txt`).
