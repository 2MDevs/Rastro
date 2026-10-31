# App Android do RASTRO

O app é uma "casca" leve: abre o Modo campo do site (`/campo`) e, quando o divulgador toca em **Iniciar**, liga um serviço do Android que continua registrando a localização com a tela apagada. A notificação "RASTRO · Registrando o seu percurso" fica visível o tempo todo enquanto rastreia.

## Como o divulgador recebe o app

1. O gestor (ou gerente) toca em **Enviar app** ao lado do divulgador (Usuários ou Painel da loja) e escolhe a conversa no WhatsApp. Ou envia o link: `https://rastro.gestaohummm.com.br/app`.
2. No celular, o divulgador toca em **Baixar o app**, abre o arquivo `rastro.apk` e, se o Android pedir, ativa **Permitir desta fonte** e toca em **Instalar**.
3. Abre o RASTRO, entra com e-mail e senha (e o código por e-mail no primeiro acesso).
4. Permite **localização** (de preferência "o tempo todo") e **notificações**.
5. Se aparecer o aviso de bateria, toca em **Permitir uso sem restrição de bateria**.
6. No Modo campo, toca em **Iniciar** na campanha. Para terminar, abre o app e toca em **Encerrar rastreamento**.

## Como o APK é gerado

- Arquivo: `.github/workflows/android.yml`. Roda sozinho quando algo muda na pasta `android/` na branch principal, ou manualmente em GitHub › Actions › "App Android (APK)" › **Run workflow**.
- Publica uma *Release* `app-v1.0.N` com `rastro.apk` e o arquivo de conferência `rastro.apk.sha256`.
- O link `https://rastro.gestaohummm.com.br/app/rastro.apk` sempre leva à versão mais nova (pode ser trocado pela variável `ANDROID_APK_URL` no `.env`, se um dia o APK ficar em outro lugar).

## Chave de assinatura (fazer uma vez)

Sem a chave, o GitHub assina com uma chave de teste: o app funciona, mas **cada nova versão pode exigir desinstalar a anterior**. Para as atualizações instalarem por cima, crie uma chave fixa:

1. Num computador com Java instalado, rode:
   `keytool -genkeypair -v -keystore rastro.jks -alias rastro -keyalg RSA -keysize 2048 -validity 10000`
   (anote a senha que você escolher; guarde o arquivo `rastro.jks` em local seguro — se perder, o app precisa ser reinstalado em todos os celulares).
2. Transforme o arquivo em texto: `base64 -w0 rastro.jks > rastro.jks.txt` (no Mac: `base64 -i rastro.jks -o rastro.jks.txt`).
3. No GitHub, em **2MDevs/Rastro › Settings › Secrets and variables › Actions › New repository secret**, crie:
   - `RASTRO_KEYSTORE_BASE64` = conteúdo do `rastro.jks.txt`
   - `RASTRO_KEYSTORE_PASSWORD` = a senha da chave
   - `RASTRO_KEY_ALIAS` = `rastro`
   - `RASTRO_KEY_PASSWORD` = a senha da chave (a mesma, se você não escolheu outra)
4. Rode o workflow de novo (Actions › "App Android (APK)" › Run workflow).

Nunca envie a chave ou as senhas por chat ou e-mail.

## Detalhes técnicos

- Pacote `br.com.gestaohummm.rastro`, Android 8.0 ou mais novo (minSdk 26), sem bibliotecas externas.
- GPS: a cada 3 s ou 4 m, guardado numa fila SQLite e enviado em lotes de até 200 pontos a cada 10 s para `POST /api/tracking/sessions/:id/points`, com o mesmo login do site (cookie da sessão).
- Ao encerrar, o GPS para na hora e o serviço continua só enviando o que faltou; depois se desliga.
- O envio de pontos continua mesmo com a tela de PIN do RASTRO bloqueada (só as rotas de pontos e encerramento).
- Ponte com o site: `window.RastroApp` (`info`, `start`, `stop`, `status`, `openAppSettings`, `openLocationSettings`, `requestBatteryExemption`).
- Endereço do site embutido no app: variável `RASTRO_BASE_URL` no build (padrão `https://rastro.gestaohummm.com.br`).
