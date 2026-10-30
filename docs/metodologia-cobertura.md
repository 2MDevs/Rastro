# Metodologia de cobertura estimada — versão v1

O RASTRO estima quanto das **ruas planejadas** de uma campanha foi **percorrido** pelo GPS. O resultado é uma estimativa de deslocamento, **não uma prova de entrega** dos panfletos.

## 1. Dados de entrada

- **Ruas planejadas** ("ruas anunciadas"): trechos de rua do OpenStreetMap escolhidos na campanha, já recortados pelo território.
- **Pontos de GPS** de todas as sessões da campanha. Os pontos originais nunca são alterados nem apagados; o cálculo pode ser refeito a qualquer momento com outros parâmetros.

## 2. Limpeza dos pontos (por sessão)

Cada sessão é tratada separadamente: o trajeto de uma pessoa nunca é ligado ao de outra.

1. Ficam de fora os pontos **recusados** no recebimento (coordenada impossível, horário no futuro, antes do início ou depois do fim da sessão).
2. Ficam de fora os pontos com **precisão pior** que `COVERAGE_MAX_ACCURACY_M` (padrão inicial: 30 m) ou sem precisão informada.
3. **Saltos impossíveis** (velocidade acima de `TRACK_MAX_SPEED_KMH`, padrão 60 km/h) são descartados como erro de sinal. Depois de 3 saltos seguidos, o trajeto recomeça do ponto atual (a pessoa pode ter pego um transporte).
4. O trajeto é **interrompido** (não liga os pontos) quando passam mais de `TRACK_MAX_GAP_SECONDS` (padrão 120 s) ou mais de `TRACK_MAX_GAP_METERS` (padrão 150 m) entre dois pontos válidos.

O resultado são **trechos contínuos** de percurso. A distância percorrida é a soma do comprimento desses trechos.

## 3. Cobertura de cada rua

1. Cada rua planejada é amostrada a cada poucos metros (no máximo 5 m).
2. Uma amostra conta como **percorrida** quando algum trecho de percurso válido passou a até `COVERAGE_BUFFER_M` (padrão 25 m) dela.
3. Cobertura da rua = amostras percorridas ÷ amostras da rua.
4. Situação da rua:
   - **Percorrida**: a partir de `COVERAGE_STREET_DONE_PCT` (padrão 80%);
   - **Parcialmente percorrida**: a partir de `COVERAGE_STREET_PARTIAL_PCT` (padrão 20%);
   - **Não percorrida**: abaixo disso.

## 4. Cobertura da campanha

**Cobertura estimada = Σ (comprimento da rua × cobertura da rua) ÷ Σ comprimento das ruas planejadas.**

O resultado não é calculado (fica com uma situação explicada) quando:

| Situação | Quando |
| --- | --- |
| Sem ruas planejadas | A campanha não tem ruas escolhidas |
| Sem dados de GPS | Nenhum ponto válido |
| Inconclusiva | Menos de `COVERAGE_MIN_POINTS` (padrão 10) pontos válidos |

Na Matriz, a cobertura consolidada de uma loja (ou da rede) soma os metros percorridos e planejados do último cálculo de cada campanha ativa, pausada ou concluída.

## 5. Quando é calculada

- Automaticamente alguns segundos depois de cada sessão ser encerrada ou interrompida, e quando chegam pontos atrasados.
- Manualmente, pelo botão **Recalcular agora** na campanha (gestores).
- Cada cálculo fica guardado com a versão da metodologia e os parâmetros usados.

## 6. Limitações conhecidas

- O GPS do celular pode errar de 5 a 30 m ou mais perto de prédios altos; ruas paralelas muito próximas podem ser contadas juntas.
- Passar pela rua não significa que todas as casas receberam panfleto.
- Os parâmetros padrão são **valores iniciais**: devem ser calibrados no teste de campo com a loja-piloto, comparando com o que a equipe realmente fez.
