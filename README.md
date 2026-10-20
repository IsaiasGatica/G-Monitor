# G Monitor

Monitor serie para Windows con logs interactivos, múltiples ventanas e integración con **Codex Desktop**, **Claude Code** y **Antigravity App** mediante MCP.

Conectá tu placa, revisá sus registros y compartí con tu agente el fragmento que necesitás analizar, junto con tu pregunta.

> **En desarrollo.** Disponible como paquete portable de prueba para Windows x64. El instalador público estará disponible con una futura release.

## Descargar para probar

Descargá el ZIP `G-Monitor-test-…-win-x64.zip` desde [GitHub Releases](https://github.com/IsaiasGatica/G-Monitor/releases). Elegí el archivo de **Assets**, no **Source code**.

1. Extraé toda la carpeta en una ubicación estable y escribible de tu usuario.
2. Ejecutá `Abrir-G-Monitor.cmd`, elegí el COM y el baud rate y pulsá **Open**. Para probar sin hardware, elegí **mock**.
3. Para usar un agente, abrí el botón del robot, ejecutá **Configure integration** y pedile al chat destinatario que abra G Monitor.
4. Ejecutá `Detener-G-Monitor.cmd` para detener el servicio y todas las ventanas.

Incluye Node.js y las dependencias: no requiere instalar Node.js, npm ni Rust. Necesita **WebView2**, además del driver de tu placa cuando corresponda. No muevas la carpeta después de configurar los agentes ni copies `.session` o `.sessions` desde otra PC o versión.

[Instrucciones completas, actualización y solución de problemas →](docs/test-pc.md)

## Qué podés hacer

- **Leer y enviar datos serie.** Configurá el COM, la velocidad y el formato de comunicación; trabajá con texto o bytes HEX.
- **Encontrar lo importante.** Filtrá registros, resaltá palabras y pausá la vista sin detener la recepción.
- **Documentar tus pruebas.** Agregá notas a los registros y exportá el log a Markdown.
- **Trabajar con tu agente.** Enviá una selección o el log conservado al chat vinculado. El agente también puede consultar registros y enviar comandos mediante MCP.
- **Abrir varios monitores.** Usá distintas ventanas para distintos puertos, cada una con su propio log y proyecto.
- **Ejecutar acciones del proyecto.** Compilá o grabá firmware y filesystem con las herramientas configuradas para tu placa.

## Conectar un agente

1. Abrí el panel de agentes desde el **ícono del robot** en la cabecera.
2. Elegí **Codex Desktop**, **Claude Code** o **Antigravity App** y pulsá **Configure integration**.
3. Seguí las indicaciones y pedile al chat destinatario: **«Abrí G Monitor para este proyecto»**.
4. Seleccioná las líneas relevantes, hacé clic derecho y elegí **Enviar a agente**. Agregá tu consulta y confirmá el envío.

Cada integración utiliza su conexión local: Codex Desktop se vincula con su chat; Claude Code utiliza el plugin `g-monitor`; Antigravity App utiliza MCP y un puente hacia la conversación existente. Antigravity CLI e IDE permiten acceso MCP, pero el envío desde la ventana requiere la App.

[Ver la configuración de cada agente →](docs/hybrid-test.md)

## Varios monitores, sin mezclar registros

Pulsá **+**, antes del botón de agentes, para abrir otra ventana. Hereda una copia del proyecto y del chat vinculado de la ventana actual, con el log vacío y sin COM seleccionado.

Cambiar o cerrar la ventana padre no modifica el destinatario del hijo. Cada COM puede usarse desde una sola ventana, también mientras se graba firmware. El simulador `mock` admite varias ventanas independientes.

## Empezar desde el código

Requisitos: **Windows**, **Node.js 22 o superior**, **Rust estable con MSVC**, **Microsoft C++ Build Tools** con desarrollo de escritorio C++ y **WebView2**.

Desde la carpeta del proyecto:

```powershell
npm ci
npm run build
npm run build:desktop
npm start
```

La ventana abre con el puerto cerrado. Elegí el COM y la velocidad de tu dispositivo y pulsá **Open**. El botón **↻** actualiza la lista de puertos. También podés elegir **mock** para trabajar con un dispositivo simulado.

## Desarrollo y documentación

El proyecto reúne la aplicación de escritorio, el servicio serie y los plugins de integración. Está desarrollado con **Tauri, React y Node.js/TypeScript**.

Para ejecutar las pruebas del daemon:

```powershell
npm test
```

- [Integraciones y uso de varios monitores](docs/hybrid-test.md)
- [Paquete portable: descarga, uso, actualización y generación](docs/test-pc.md)
- [Arquitectura y contratos MCP/WebSocket](docs/architecture.md)

Podés reportar errores indicando qué intentaste hacer, el resultado esperado y los pasos para reproducirlo. Si adjuntás logs, quitá primero los datos privados.

## Datos locales y seguridad

Los logs no se envían continuamente al chat. El envío desde la ventana ocurre cuando lo confirmás; el agente también puede consultarlos mediante MCP. Ante una entrega sin confirmación, revisá la conversación antes de reenviar.

Las credenciales, configuraciones generadas y datos de sesión son locales al usuario. No publiques `.session`, tokens ni respaldos de configuración.

## Licencia

La licencia del proyecto está pendiente de definición.
