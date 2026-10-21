# La Grieta del Persa

Web de pronósticos para la comunidad de El Persa. Los viewers entran con Kick o Twitch, pronostican gratis qué pasa en sus partidas de League of Legends, juntan fichas y las canjean por premios. Las fichas también se cargan con puntos de canal: **100 puntos = 1 ficha**.

Para ver cómo queda sin instalar nada, abrí `public/index.html?demo` con un servidor local (ver "Probar en tu PC").

## Qué hay en esta carpeta

| Carpeta | Qué es |
|---|---|
| `public/` | La web: página de viewers (`index.html`), panel del streamer (`panel.html`), overlays para OBS (`overlay.html`) y la app descargable (`descargas/GrietaConector.exe`). |
| `worker/` | El servidor (Cloudflare Worker + base D1): logins, fichas, pronósticos, canjes de puntos, API de Riot. |
| `conector/` | Código fuente de la app de PC (Go). Ya viene compilada en `public/descargas/`. |

## Cómo funciona

1. **Login**: el viewer entra con Kick o Twitch. Recibe 50 fichas de bienvenida. Puede vincular las dos cuentas.
2. **Pronósticos**: cuando El Persa entra a una partida, se abren solos:
   - De partida (cierran al minuto 4): gana o pierde, kills, muertes, duración.
   - De primeros minutos (requieren la app de PC): primera sangre, muere antes del minuto 10, primer dragón.
   - Especiales: los crea El Persa desde el panel.
   Pronosticar es gratis. Si acertás, cobrás `premio base × cuota`. Las opciones menos elegidas pagan más.
3. **Fichas por puntos de canal**: el panel crea en Kick y Twitch las recompensas "Cargar 1 ficha" (100 pts), "Cargar 10 fichas" (1.000 pts) y "Cargar 50 fichas" (5.000 pts). Cuando un viewer las canjea, las fichas llegan solas. Si todavía no se registró, se le guardan hasta que entre.
4. **Tienda**: comodines (Doble premio, Escudo) y premios que El Persa cumple en el stream. Los canjes aparecen en el panel para marcarlos como cumplidos o devolver las fichas.
5. **Anti-delay**: si algo pasa en la partida con un pronóstico todavía abierto, se anulan los picks de los 30 segundos anteriores.

## Puesta en marcha (una sola vez, unos 30 minutos)

Necesitás una cuenta de [Cloudflare](https://dash.cloudflare.com) y [Node.js](https://nodejs.org) 20 o superior.

### 1. Base de datos y servidor

```bash
cd worker
npx wrangler login
npx wrangler d1 create persa
```

Copiá el `database_id` que aparece y pegalo en `wrangler.toml`. Después:

```bash
npx wrangler d1 execute persa --remote --file=schema.sql
npx wrangler secret put ADMIN_PASSWORD        # la contraseña del panel
npx wrangler deploy
```

Te da una dirección `https://grieta-del-persa.<tu-usuario>.workers.dev`. Conviene usar un dominio propio (Cloudflare > Workers > tu worker > Settings > Domains). Poné esa dirección en `PUBLIC_URL` dentro de `wrangler.toml` y volvé a hacer `npx wrangler deploy`.

### 2. App de Kick

1. Activá la verificación en dos pasos en tu cuenta de Kick.
2. Entrá a [kick.com/settings/developer](https://kick.com/settings/developer) y creá una app.
3. Redirect URL: `https://TU-DOMINIO/auth/kick/callback`
4. Activá **Enable Webhooks** con la URL `https://TU-DOMINIO/webhooks/kick`
5. Copiá el Client ID en `KICK_CLIENT_ID` (dentro de `wrangler.toml`) y cargá el secreto:

```bash
npx wrangler secret put KICK_CLIENT_SECRET
```

### 3. App de Twitch (opcional, si también hace stream en Twitch)

Los puntos de canal de Twitch solo existen en canales Afiliados o Partners.

1. Entrá a [dev.twitch.tv/console](https://dev.twitch.tv/console) y registrá una app (categoría "Website Integration").
2. OAuth Redirect URL: `https://TU-DOMINIO/auth/twitch/callback`
3. Copiá el Client ID en `TWITCH_CLIENT_ID` y cargá los secretos. El segundo es una clave que inventás vos (entre 10 y 100 caracteres):

```bash
npx wrangler secret put TWITCH_CLIENT_SECRET
npx wrangler secret put TWITCH_EVENTSUB_SECRET
```

### 4. Riot Games (opcional)

Sirve para detectar partidas aunque la app de PC esté cerrada y para confirmar resultados si la app se corta.

1. Registrá el producto en [developer.riotgames.com](https://developer.riotgames.com). Describilo como lo que es: **pronósticos gratuitos, sin apuestas ni premios en dinero**. Riot no aprueba productos con apuestas.
2. Cargá la clave: `npx wrangler secret put RIOT_API_KEY`

Después de cargar todo: `npx wrangler deploy`.

### 5. Panel del streamer

Entrá a `https://TU-DOMINIO/panel.html` con la contraseña del paso 1. La sección **Resumen** muestra qué falta. En **Conexiones**:

1. **Conectar canal de Kick** (con la cuenta de El Persa) y después **Crear recompensas**.
2. Lo mismo con Twitch, si corresponde.
3. **Generar código de conexión** y **Descargar GrietaConector.exe**.
4. Cargar el Riot ID (nombre y tag), si configuraste la clave.

### 6. App de PC (GrietaConector.exe)

No se instala: se abre con doble clic. La primera vez pide el código de conexión del panel; después funciona sola.

- Lee la partida en vivo directo de League of Legends (`127.0.0.1:2999`) y manda los eventos a la web.
- Se puede cerrar la ventana: sigue funcionando. Para verla otra vez, se abre el .exe de nuevo.
- Tiene la opción **Abrir con Windows** para no tener que acordarse.
- Usa Microsoft Edge (viene con Windows 10 y 11) para mostrar la ventana.

La primera vez, Windows puede mostrar "Windows protegió su PC" porque el programa no está firmado. Se habilita con **Más información > Ejecutar de todas formas**. Para sacar ese aviso hay que comprar un certificado de firma de código.

### 7. Overlays para OBS o Streamlabs

En el panel, sección **Overlays**, están los links. En OBS: Fuentes > + > Navegador, pegá la URL, ancho 1920, alto 1080. El fondo es transparente.

- `overlay.html?tipo=pronostico`: el pronóstico abierto, con cuenta regresiva y votos.
- `overlay.html?tipo=alertas`: avisos cuando alguien carga fichas o canjea un premio.
- `overlay.html?tipo=ranking`: top 5 del mes.
- `overlay.html?tipo=completo`: todo junto.

## Probar en tu PC (sin Cloudflare)

```bash
node --no-warnings worker/test/servidor-local.mjs
```

Abrí `http://localhost:8788`. Para entrar sin Kick ni Twitch: `http://localhost:8788/auth/dev?name=Ana`. Panel: `http://localhost:8788/panel.html`, contraseña `local`.

Simular una partida completa (necesita Python 3, OpenSSL y Go):

```bash
python3 conector/test/liga_falsa.py 20          # partida falsa, 20 veces más rápida
cd conector && go run . -liga https://127.0.0.1:29990/liveclientdata/allgamedata
```

Pruebas automáticas del servidor (58 casos):

```bash
node --no-warnings worker/test/run-tests.mjs
```

## Volver a compilar la app de PC

```bash
cd conector
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-H=windowsgui -s -w" -o ../public/descargas/GrietaConector.exe .
```

El ícono y el manifiesto ya están en `rsrc_windows_amd64.syso` (se generan con [rsrc](https://github.com/akavel/rsrc) a partir de `icono.ico` y `app.manifest`).

## Costos

- Cloudflare gratis alcanza para probar y para pocos viewers. La web consulta el estado cada 4 segundos, y el plan gratis tiene un límite de 100.000 pedidos por día. Con más de 50 viewers mirando a la vez durante horas conviene el plan Workers Paid (5 USD por mes).
- Kick, Twitch y Riot: gratis.

## Reglas a tener en cuenta

- **Riot**: prohíbe apuestas en productos que usan su API. Por eso pronosticar es gratis y no se arriesgan fichas.
- **Twitch**: su política de puntos de canal no permite cambiarlos por monedas virtuales ni por cosas con valor real. Convertir puntos en fichas queda en zona gris. Si Twitch lo objeta, la alternativa es que las recompensas de puntos den comodines directos en lugar de fichas.
- **Kick**: revisá sus términos para desarrolladores antes de lanzar.
- **Premios**: mantenelos sin valor monetario (saludos, elegir campeón, jugar juntos, roles). Nada de dinero, juegos de Steam ni productos que se puedan revender. Para regalar algo de valor, hacé un sorteo aparte con entrada gratis.
- **Legal**: en Argentina el juego de azar online está regulado por provincia. El diseño evita apuestas, pero conviene que el streamer lo consulte con un abogado.
