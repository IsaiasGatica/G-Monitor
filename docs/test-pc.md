# Probar G Monitor en otra PC

Este paquete portable de prueba es para **Windows x64**. Incluye la ventana, el servicio serie, Node.js y las dependencias de ejecución. No requiere instalar Node.js, npm, Rust ni descargar el código fuente. Todavía no es un instalador ni una versión estable.

## Descargar y abrir

1. En [Releases de GitHub](https://github.com/IsaiasGatica/G-Monitor/releases), abrir la versión de prueba y descargar el archivo `G-Monitor-test-…-win-x64.zip` de **Assets**. Los archivos automáticos **Source code** contienen el código, no la aplicación lista para usar.
2. Extraer **todo** el ZIP en una carpeta estable y escribible de tu usuario, por ejemplo `C:\Herramientas\G-Monitor-test`. No ejecutar desde el ZIP ni guardar en `Program Files`.
3. Ejecutar `Abrir-G-Monitor.cmd`. Mantener juntos todos los archivos y subcarpetas.
4. Elegir el COM y el baud rate de tu placa y pulsar **Open**. Podés elegir **mock** para probar sin hardware. No abrir un mismo COM en otro monitor serie al mismo tiempo.
5. Para cerrar el servicio completo y todas las ventanas, ejecutar `Detener-G-Monitor.cmd`. Cerrar solamente una ventana libera su COM, pero deja el servicio disponible.

La ventana necesita **Microsoft Edge WebView2 Runtime**. Si Windows informa que falta, instalarlo desde [Microsoft](https://developer.microsoft.com/microsoft-edge/webview2/). El dispositivo puede necesitar su driver USB/serie. Para grabar firmware siguen siendo necesarias las herramientas propias del proyecto, como PlatformIO o Python.

## Conectar un agente en esta PC

Abrir **Agent settings**, el botón con el robot en la cabecera, elegir el agente y pulsar **Configure integration**. Se configuran las rutas y credenciales de esta PC; no se deben copiar las de otra instalación.

- **Codex Desktop:** reconectar MCP o reiniciar la aplicación si se solicita. Desde el chat destinatario, pedir «Abrí G Monitor para este proyecto».
- **Claude Code:** seguir las indicaciones del panel para instalar el plugin `g-monitor` del marketplace `g-monitor-local`. El flujo de Desktop se utiliza en **Code → Local**; la CLI es opcional. Después de instalar o actualizar el plugin, ejecutar `/reload-plugins` en el chat y pedir que abra G Monitor.
- **Antigravity App:** reiniciar la App tras configurar y comprobar que el sidecar `g-monitor` esté habilitado. Pedir al mismo chat que abra G Monitor. El envío desde la ventana en una sesión real de App sigue pendiente de validación; CLI e IDE tienen acceso MCP sin ese envío.

Una ventana abierta mediante el `.cmd` todavía no está vinculada a un chat. Para **Enviar a agente**, abrirla desde el chat que debe recibir los registros. Seleccionar unas líneas, hacer clic derecho, elegir **Enviar a agente**, revisar y confirmar.

No mover ni renombrar la carpeta después de configurar las integraciones: sus rutas deben seguir siendo válidas. Los detalles están en [la guía de agentes](hybrid-test.md).

## Probar varias ventanas

El botón **+** crea otra ventana con una copia del proyecto y el chat vinculados, log vacío y ningún COM seleccionado. Cada COM pertenece a una sola ventana; el dispositivo **mock** admite varias. Cambiar el chat del padre no cambia el del hijo.

## Actualizar a otro paquete de prueba

1. Ejecutar `Detener-G-Monitor.cmd` de la versión anterior.
2. Extraer la nueva versión en una carpeta nueva y estable. No mezclar archivos de dos versiones.
3. Abrir la nueva versión y volver a ejecutar **Configure integration** para actualizar las rutas de los agentes. En Claude, actualizar el plugin y ejecutar `/reload-plugins`.
4. Pedir al chat destinatario que abra el monitor otra vez.

No copiar `.session` ni `.sessions` desde la versión anterior ni desde otra PC. La aplicación genera sus propios datos al iniciarse. Conservar la carpeta anterior hasta comprobar que la nueva funciona.

## Compartir el paquete y reportar problemas

Compartir el ZIP original, sin abrirlo ni configurarlo previamente. No reenviar una carpeta que ya se usó con su `.session`: puede contener tokens, configuraciones y respaldos locales. El paquete de distribución tampoco incluye `.git`, logs, respaldos ni herramientas de desarrollo.

Al reportar un problema, indicar el nombre del paquete o adjuntar `BUILD.json`, la versión de Windows, el agente utilizado, los pasos y el mensaje de error. Quitar los datos privados de capturas y logs. Si no abre, ejecutar `Abrir-G-Monitor.cmd` desde una terminal para ver el error; comprobar que se extrajo todo y que está instalado WebView2.

## Generar el paquete desde el código

En una PC de desarrollo Windows x64 con los requisitos de compilación:

```powershell
npm ci
npm test
npm run build
npm run build:desktop
npm run prepare:test-pc -- --name G-Monitor-test-FECHA-win-x64
```

El último comando crea una carpeta nueva dentro de `test-pc/`; falla si el destino ya existe. Usa los binarios compilados previamente, por lo que es necesario completar las compilaciones antes de empaquetar. Incluye las dependencias de producción y rechaza sesiones, credenciales generadas y enlaces simbólicos inesperados. Comprimir la carpeta completa antes de ejecutarla. Publicar el ZIP como archivo adjunto de una **prerelease** en GitHub, junto con su SHA-256; no agregar los binarios al historial Git.
