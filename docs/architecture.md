# Arquitectura y contratos v1

## Estructura y propietarios

```text
Codex / Claude / Antigravity ── MCP HTTP o stdio ── Node daemon
                                                   ├─ Monitor A ── COM A
                                                   │   └─ WebSocket A ── Tauri A
                                                   └─ Monitor B ── COM B
                                                       └─ WebSocket B ── Tauri B
```

`packages/daemon/src/core.ts`: buffer circular, cola única de escritura, espera y delimitación de líneas.
`config.ts`: validación de entorno. `websocket.ts`: protocolo autenticado.
`connection.ts`: enumeración, apertura/cierre y estado del dispositivo. Las operaciones de control usan la misma cola que TX.
`index.ts`: registro de monitores, herramientas MCP y supervisor de las ventanas. Cada monitor tiene su `SerialConnection`, `SerialHub`, cola, proyecto, selección y vínculo al agente.
`port-reservations.ts`: reserva exclusiva de COM compartida por las instancias, incluida la liberación temporal del descriptor durante una grabación.
`apps/desktop/src`: visor React. `src-tauri`: ventana y lectura del archivo de sesión.

El SDK MCP v1 se usa por su API publicada; las versiones exactas de JavaScript quedan en `package-lock.json`.
La GUI no importa SerialPort, no abre el hardware y no controla DTR/RTS.
Cada COM tiene un único dueño. Dentro del servicio, la reserva impide abrirlo desde dos monitores y responde `El puerto COMx está ocupado por otro monitor`. Un proceso externo también debe respetar el lock del driver. Los clientes MCP y la GUI de una ventana comparten su conexión; ventanas distintas pueden trabajar con COM diferentes. El simulador `mock` es independiente por ventana.

## Registros

```json
{"id":42,"timestamp":"2026-10-09T12:00:00.000Z","source":"hardware","text":"READY"}
```

`id` crece dentro de cada monitor; monitores distintos pueden tener el mismo número de registro. Fuentes: `hardware`, `claude`, `user`, `system`.
RX se decodifica como UTF-8 con estado entre fragmentos. LF delimita registros; se elimina CR final de CRLF.
Una línea sin terminador se divide al alcanzar 4096 caracteres. Los registros TX contienen el payload literal y se emiten después de completar escritura/drain. RX puede llegar antes de ese registro TX.
El visor muestra texto, sin interpretar HTML ni secuencias ANSI. Binarios y terminal ANSI completo quedan fuera de esta versión.

## MCP sobre stdio

No se emiten logs automáticamente. Enviar a agente entrega al vínculo propio de esa ventana mediante las herramientas locales de Codex, el mod de Claude o el puente de Antigravity App. stdout se reserva al protocolo; diagnóstico de arranque va a stderr.
Cada herramienta devuelve contenido MCP `text` con JSON; los fallos operacionales de las herramientas usan `isError: true`.

Todas las herramientas admiten `monitor_id` opcional. Si se omite, actúan sobre el monitor principal. Un ID inexistente o ya cerrado produce error sin redirigir la llamada. `serial_list_monitors` devuelve IDs completos, relación padre/hijo, proyecto y estado. `serial_new_monitor` crea un hijo del monitor seleccionado y devuelve su `monitorId`.

| Herramienta | Entrada | Salida JSON |
|---|---|---|
| `serial_read` | `lines` entero 1–500 (100), `filter` opcional, hasta 512 caracteres | `{records, truncated, status}` |
| `serial_write` | `payload` UTF-8, 1–4096 bytes, literal | `{ok:true}` o error |
| `serial_wait_for` | `pattern` literal 1–512 caracteres, `timeout_ms` 1–60000 (5000) | `{matched:true, record}` o `{matched:false, reason:"timeout"/"shutdown"}` |
| `serial_open_ui` | `project_dir`, `port`, `baud_rate`, `agent` y `monitor_id` opcionales | `monitorId`, apertura/reutilización, carpeta, selección y vínculo |
| `serial_list_monitors` | `monitor_id` opcional | `{monitors:[{monitorId,parentMonitorId?,projectDir,status}]}` |
| `serial_new_monitor` | `monitor_id` del padre, opcional | `{monitorId,parentMonitorId,projectDir,agent}` |

El filtro es substring sensible a mayúsculas, no regex. `serial_read` filtra antes de seleccionar los últimos N y limita los registros devueltos a 32768 bytes JSON. La envoltura agrega unos pocos bytes. `truncated` indica recorte por tamaño; no indica registros ya desalojados del buffer.
`serial_wait_for` observa únicamente NUEVOS registros de hardware a partir del registro de la espera. Para respuestas inmediatas, registrar la espera concurrentemente antes de TX, o escribir y luego consultar `serial_read` con filtro. No asumir que un wait posterior a TX verá una respuesta anterior.
Máximo 32 esperas y 64 escrituras pendientes. Una espera no bloquea las otras herramientas.

## Sesión Tauri

El daemon crea un directorio temporal y token distintos por monitor, con un archivo de este formato:

```json
{"protocolVersion":1,"monitorId":"UUID del monitor","parentMonitorId":"UUID del padre, si existe","wsUrl":"ws://127.0.0.1:49152","token":"64 caracteres hexadecimales"}
```

`serial_open_ui` ejecuta la ruta `SERIAL_UI_EXECUTABLE` sin shell ni argumentos inyectados y pasa `SERIAL_MONITOR_SESSION` por entorno.
El comando nativo `session` lee el archivo y lo entrega al frontend por IPC. El token no se coloca en URLs de navegación ni configuración persistente; autentica la conexión WebSocket mediante query string. El daemon compartido también dispone de un servidor HTTP autenticado.
El directorio temporal y el token son privados por sesión. En Unix se pide modo 0600; en Windows rigen las ACL del directorio temporal del usuario. No constituye aislamiento frente a procesos del mismo usuario.

## WebSocket JSON

Servidor en `127.0.0.1`, puerto efímero por defecto. Los controles mantienen el límite de 8192 bytes; `send_to_agent` admite texto UTF-8 hasta 1 MiB y una envoltura JSON hasta 8 MiB para escapes. URL: `ws://127.0.0.1:PUERTO/?token=TOKEN`.
Se admiten los orígenes locales de Tauri y del frontend de desarrollo, y clientes sin Origin con token válido. Se rechazan otros orígenes y tokens con cierre 1008.

Cliente → servidor:

```json
{"type":"write","requestId":"tx-1","payload":"STATUS","appendNewline":true}
{"type":"ping","requestId":"ping-1"}
{"type":"new_monitor","requestId":"new-1"}
{"type":"list_ports","requestId":"ports-1"}
{"type":"open","requestId":"open-1","port":"COM3","baudRate":115200}
{"type":"open","requestId":"open-7e2","port":"COM3","baudRate":9600,"dataBits":7,"parity":"even","stopBits":2}
{"type":"close","requestId":"close-1"}
{"type":"reset_esp32","requestId":"reset-1"}
{"type":"send_to_agent","requestId":"agent-1","text":"ERROR","scope":"selection","bindingId":"UUID del vínculo capturado"}
```

`appendNewline` agrega LF y vale false si se omite. Para CRLF enviar `payload: "STATUS\r\n"`, sin agregar LF.
`requestId` es una cadena de 1–64 caracteres. `ping` confirma conectividad; no escribe hardware.

`new_monitor` requiere un socket registrado con `ui_attached`; responde con `monitor` que contiene el ID del hijo, el del padre, el proyecto y el vínculo heredado. La GUI lo envía al pulsar **+** antes del botón de agentes. El panel de agentes contiene solo la configuración de integraciones. El hijo copia el proyecto y el destinatario al crear la instancia, inicia con log vacío y sin COM seleccionado, y no sigue los cambios posteriores del padre. El servicio admite hasta 16 monitores, incluidas las creaciones en curso.

`open` admite `dataBits` (5/6/7/8), `parity` (none/even/odd) y `stopBits` (1/2). El formato inicial es 8N1; cada campo omitido conserva el último valor usado por la conexión. Se valida antes de abrir y se pasa al driver. `status.serialFormat` publica los tres valores. La GUI conserva su selección local, permite editarla con el puerto cerrado y la envía completa en `open`; con el puerto abierto refleja el formato del daemon. Una reapertura tras grabar conserva el formato activo.
`list_ports` devuelve `result` con `ports: [{path, manufacturer?, serialNumber?}]` e incluye `mock` para simulación. `open` y `close` devuelven `result` y difunden el estado a todos los clientes. El estado incluye `busy` mientras se abre o cierra. Es necesario cerrar el puerto activo antes de abrir otro. Las escrituras y cambios de puerto se ejecutan en orden en una única cola. Los registros se conservan al cambiar de puerto.

Servidor → cliente:

`reset_esp32` requiere un puerto abierto y comparte la cola exclusiva con TX/open/close. Mantiene DTR=false, activa RTS durante 100 ms y libera ambas señales; publica `busy` durante el pulso. Si falla, intenta liberar las señales; si falla esa liberación, intenta cerrar el descriptor. En `mock` registra una simulación. El equivalente MCP es `serial_reset_esp32({})`. Está destinado al circuito de auto-reset USB–UART del ESP32; no garantiza reset por USB nativo.

```json
{"type":"snapshot","records":[],"status":{"port":"COM3","baudRate":115200,"connected":true,"mock":false}}
{"type":"record","record":{"id":42,"timestamp":"2026-10-09T12:00:00.000Z","source":"hardware","text":"READY"}}
{"type":"status","status":{"port":"COM3","baudRate":115200,"connected":false,"mock":false}}
{"type":"result","requestId":"tx-1","ok":true}
{"type":"result","requestId":"tx-2","ok":false,"error":"Serial port is disconnected; restart the daemon to reopen"}
{"type":"shutdown"}
```

Solicitudes malformadas reciben un resultado sin `requestId` si no pudo validarse. `ok:true` en TX confirma write/drain del host, no aceptación del comando por el firmware.
Se admiten hasta 8 sockets; el consumidor con más de 256 KiB pendientes se cierra con 1013 y puede reconectar para recibir snapshot. Snapshot contiene como máximo 500 registros.
El frontend conserva hasta 2000 registros, agrupa renders por frame y congela la vista al pausar, manteniendo recepción activa. El buffer del daemon es independiente.

## Ciclo de vida

1. Validar entorno; iniciar WebSocket; crear sesión temporal.
2. Si se configuró SERIAL_PORT, abrirlo con exclusión, sin control de flujo RTS/CTS; aplicar DTR/RTS configurados. Si no se configuró, iniciar cerrado y permitir selección desde la GUI. Un error de apertura se registra y deja MCP disponible para diagnóstico.
3. Conectar transporte MCP. En modo simulado, emitir HEARTBEAT y responder `ACK` a TX.
4. `serial_open_ui` reutiliza proceso/conexión existente o crea la ventana. Cerrar la ventana libera COM por la misma cola de operaciones; MCP sigue disponible y permite volver a abrir el puerto. La UI registra `ui_attached` al conectar: si desaparece la última UI, se libera el puerto tras 2 segundos, cancelables por reconexión. El evento de salida del proceso lanzado por el daemon solicita la liberación inmediatamente y cancela ese temporizador. Los sockets sin registro de UI no participan en este ciclo.
5. Desconexión del hardware: anunciar estado y rechazar TX. No reconectar automáticamente. Corregir conexión y usar Abrir desde la GUI para reabrir. Cerrar COM deja vivos GUI y MCP; cerrar una ventana libera solo su COM. Durante una acción, el cierre impide la reapertura automática y encola la liberación aunque TX esté bloqueado. El servicio de `npm start` continúa disponible. Un hijo cerrado elimina sus recursos; cerrar el padre no cierra sus hijos.
6. EOF de stdin en modo stdio, SIGINT, SIGTERM o `/stop`: esperar las creaciones en curso, detener y limpiar todas las instancias, cerrar sus COM y WebSockets, resolver esperas, terminar las ventanas, borrar archivos temporales y cerrar MCP.

No se promete recuperación ante terminación forzada del SO ni ausencia de pulsos DTR/RTS: algunos drivers los modifican al abrir antes de poder aplicar `set`. Evitar resets en esos dispositivos requiere configuración de driver o mitigación en hardware.

## Fuentes oficiales consultadas

- [SDK MCP v1](https://ts.sdk.modelcontextprotocol.io/server)
- [SerialPort](https://serialport.io/docs/api-serialport/)
- [Configuración Tauri 2](https://v2.tauri.app/reference/config/)
- [API de ventana Tauri](https://v2.tauri.app/reference/javascript/api/namespacewindow/)
- [Prerrequisitos Tauri](https://v2.tauri.app/start/prerequisites/)
- [MCP en Claude Code](https://code.claude.com/docs/en/mcp)

## Entrega a Claude mediante plugin y mod

El plugin local registra open_monitor y obtiene session.id/cwd del host. POST /mod/register genera una clave privada por sesión. /mod/open valida esa clave y vincula la ventana; el ID no se elige por proyecto. Todos estos endpoints requieren además el Bearer del servicio y validan Host/Origin. El clic conserva bindingId para impedir enviar a otra sesión tras cambiar de destinatario.

El mod consulta /mod/poll cada segundo. Cada mensaje se reclama una sola vez; prompt.submit recibe el texto en ese chat. /mod/ack confirma únicamente después de iniciar el turno. Mientras espera, /mod/heartbeat mantiene la conexión. El timeout de entrega es 30 segundos y no reintenta. /mod/disconnect o un lease vencido cancela pendientes e invalida el vínculo. Un acuse tardío o de otra sesión se rechaza. Un cambio de sesión de Claude registra una nueva ruta, sin heredar el monitor.

## MCP HTTP y stdio

index.ts --http conserva un registro de monitores, cada uno con SerialConnection y SerialHub propios; cada transporte MCP tiene su McpServer y selecciona la instancia mediante monitor_id. Escucha en loopback, por defecto en 127.0.0.1:47831, autenticado y con controles Host/Origin. /stop libera todas las instancias y detiene el servicio. Cada GUI usa su WebSocket y token propios. Desconectar un cliente MCP no detiene otros clientes. Sin --http se conserva el transporte stdio convencional.

service.mjs inicia/reutiliza un daemon independiente del stdin de los agentes. .session/http-token persiste por instalación; service.json describe el proceso activo. No forman parte del código fuente versionado. El configurador genera en .session/claude-plugin un marketplace local con rutas reales y token. El instalador usa claude plugin marketplace add y claude plugin install, sin editar el registro interno de plugins. La migración elimina únicamente los componentes antiguos reconocidos de G Monitor.

Las pruebas automatizadas usan perfiles temporales y un host de mod simulado para verificar rutas de entrega y errores. [API de mods](https://code.claude.com/docs/en/plugins/mods/api) y [guía de integraciones](hybrid-test.md).

## Entrega a Antigravity App

El configurador agrega serial-monitor en ~/.gemini/config/mcp_config.json, el hook g-monitor-send en hooks.json y el sidecar g-monitor en sidecars/g-monitor/sidecar.json; lo habilita en config.json. Conserva otros ajustes y guarda respaldos. El hook PreInvocation aporta el conversation_id actual, que serial_open_ui recibe como agent:{type:"antigravity",conversation_id}. No se deduce el destinatario de la conversación más reciente ni de archivos ajenos.

El sidecar registra un puente privado en /mod/antigravity/register, reclama mensajes mediante /poll y confirma con /ack; /heartbeat y /disconnect controlan su ciclo de vida. Todos usan el Bearer del servicio y una clave de ruta. El mensaje incluye el conversationId capturado y el monitorId de origen, por lo que volver a vincular el padre no redirige sus hijos ni los envíos pendientes.

scripts/antigravity-sidecar.mjs ejecuta agentapi send-message para la conversación existente, sin shell ni creación de chats. En Windows resuelve el ejecutable nativo del launcher y rechaza mensajes que excedan el límite de argumentos. También trata como fallo una respuesta JSON con error aunque el proceso termine con código cero. No reenvía tras timeout, pérdida de conexión o acuse incierto; el usuario debe revisar el chat antes de repetir.

Reiniciar Antigravity App carga los hooks y el sidecar. CLI e IDE mantienen acceso MCP sin entrega de la ventana al chat. Las pruebas usan agentapi y ventanas simuladas; la entrega real en App y la exclusividad con hardware siguen requiriendo validación manual. Ver [sidecars](https://antigravity.google/docs/sidecars) y [hooks](https://antigravity.google/docs/hooks).
