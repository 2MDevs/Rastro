# Integração de rastreamento: app Android e equipamento GPS dedicado

Todas as formas de coleta (Modo campo no navegador, futuro app Android e equipamento dedicado) usam **a mesma API** e as mesmas regras. Assim, trocar ou acrescentar uma forma de coleta não muda o núcleo do RASTRO.

## Situação

| Forma de coleta | Situação |
| --- | --- |
| Modo campo (navegador) | **Pronto.** Funciona com a tela ligada e a página aberta. Guarda os pontos sem internet e envia depois. |
| App Android | **Não existe ainda.** Recomendação técnica: app nativo em Kotlin com serviço em primeiro plano (notificação visível enquanto rastreia), `FusedLocationProviderClient` e fila local (Room). Prazo e responsável: A definir. |
| Equipamento GPS dedicado | **Modelo e protocolo A definir.** O cadastro do equipamento já existe (tela Dispositivos) e a API abaixo recebe os pontos. Falta o **adaptador** do fabricante. |

## Regras comuns (garantidas pelo servidor)

- Rastreamento só em campanha **ativa** e só por quem foi escolhido como **responsável** pela campanha.
- Cada sessão tem um identificador gerado no aparelho (`clientSessionId`): repetir o pedido devolve a mesma sessão (internet instável não cria sessões duplicadas).
- Cada ponto tem um identificador gerado no aparelho (`id`): reenviar o mesmo ponto não duplica (`ON CONFLICT DO NOTHING`).
- O servidor guarda o **horário de captura** (do aparelho) e o **horário de recebimento** (do servidor) separadamente.
- Pontos impossíveis não são descartados: ficam guardados como **recusados**, com o motivo.
- Aparelho bloqueado ou revogado tem os pontos recusados e as sessões em andamento interrompidas.
- Uma pessoa só tem um rastreamento em andamento por vez.
- Sessão sem comunicação por mais de 12 horas é marcada como **Interrompida** automaticamente.

## API

Autenticação: o app usa a mesma sessão do login (cookie). Um adaptador de equipamento usa uma **chave de API** com o escopo `tracking:write`, criada em Sistema › API & Webhooks; ele age em nome da pessoa que criou a chave.

### 1. Registrar o aparelho (app e navegador)

`POST /api/tracking/devices/register`

```json
{ "kind": "ANDROID_APP", "installId": "identificador-aleatorio-da-instalacao", "name": "Celular da equipe", "appVersion": "1.0.0" }
```

O `installId` é aleatório, gerado na instalação; o servidor guarda só o hash. Equipamentos dedicados são cadastrados pela administração (tela Dispositivos › Aparelhos de rastreamento).

### 2. Campanhas da pessoa

`GET /api/tracking/my-campaigns` → campanhas em que a pessoa é responsável e a sessão em andamento, se houver.

### 3. Iniciar

`POST /api/tracking/sessions`

```json
{ "clientSessionId": "uuid-gerado-no-aparelho", "campaignId": "cmp_...", "trackerDeviceId": "apr_...", "startedAt": "2026-11-03T13:00:00-03:00" }
```

### 4. Enviar pontos (lotes de até 500)

`POST /api/tracking/sessions/{id}/points`

```json
{
  "points": [
    { "id": "uuid-do-ponto", "lat": -22.9, "lng": -43.18, "accuracy": 8.5, "altitude": 12, "speed": 1.3, "heading": 90, "capturedAt": "2026-11-03T13:00:05-03:00" }
  ],
  "pendingPoints": 0
}
```

Resposta: `{ "received": 1, "inserted": 1, "duplicates": 0, "rejected": 0 }`. `pendingPoints` informa quantos pontos ainda estão no aparelho (a tela mostra "Sincronizando").

Motivos de recusa: coordenada inválida, horário no futuro (mais de 5 min), antes do início da sessão (mais de 10 min), depois do encerramento (mais de 2 min).

### 5. Encerrar

`POST /api/tracking/sessions/{id}/finish`

```json
{ "reason": "USER", "finishedAt": "2026-11-03T15:10:00-03:00", "pendingPoints": 0 }
```

`reason` pode ser `USER` (encerrada pela pessoa) ou `INTERRUPTED` (o app detectou interrupção: GPS desligado, permissão retirada etc.).

## Adaptador para equipamento dedicado (a fazer quando o modelo for definido)

1. Receber os dados no formato do fabricante (TCP/UDP/HTTP, conforme o protocolo).
2. Identificar o equipamento pelo identificador cadastrado (IMEI/série) e a pessoa responsável.
3. Abrir a sessão na campanha correta (regra a definir com a operação: campanha escolhida pela gestão antes da saída, por exemplo).
4. Converter cada posição para o formato do item 4 e enviar em lotes, com um `id` estável por posição.
5. Encerrar a sessão no fim do expediente ou quando o equipamento parar.

O adaptador deve rodar como serviço próprio, separado do RASTRO, sem alterar outros projetos da VPS.
