# Integraciones y monitores

G Monitor permite trabajar desde Codex Desktop, Claude Code y Antigravity App. El agente puede leer registros y enviar comandos mediante MCP. **Enviar a agente** entrega una selección o el log conservado al chat vinculado a esa ventana, cuando el usuario lo confirma.

## Claude Code desde Claude Desktop

1. Con G Monitor abierto, pulsar el ícono de agentes (robot) y elegir **Claude Code → Configure integration**.
2. Cerrar completamente Claude Desktop y volver a abrirlo.
3. En **Code → Local → + → Plugins → Add plugin**, buscar **g-monitor** del marketplace **g-monitor-local** e instalarlo para el usuario. Aceptar la confirmación de confianza si aparece.
4. Ejecutar `/reload-plugins` en el chat y pedir: **Abrí G Monitor para este proyecto**. Claude usa `open_monitor` del plugin para vincular la conversación existente.
5. Elegir el COM correcto y abrirlo desde el monitor. Para compartir registros, seleccionar texto → clic derecho → **Enviar a agente**.

La CLI no es necesaria para este flujo. El panel indica los requisitos de Claude Code: 2.1.286 o posterior en Desktop, comprobable con `/status`; para la instalación automática mediante CLI, 2.1.287 o posterior. Si la CLI está disponible, el configurador intenta instalar el plugin automáticamente. El diagnóstico y las instrucciones de instalación quedan en el panel.

Sin selección se envía el log conservado. Si Claude está ocupado o vence el plazo de entrega, revisar el chat antes de reenviar: no se reintenta automáticamente. Al cambiar de chat, volver a abrir y vincular la ventana desde la conversación destinataria.

## Codex Desktop

Configurar **Codex Desktop** desde el botón de agentes y reconectar MCP en el mismo chat. Pedir abrir G Monitor para el proyecto. La integración utiliza los identificadores y el canal local de herramientas de esa conversación; no crea un chat nuevo para recibir el log.

## Antigravity App

1. En el botón de agentes, elegir **Antigravity App → Configure integration**.
2. Reiniciar Antigravity App y comprobar que el sidecar **g-monitor** esté habilitado en **Customizations** y que MCP tenga **serial-monitor** disponible.
3. Desde el chat destinatario, pedir abrir G Monitor mediante MCP y vincularlo a esa conversación. El hook aporta el `conversation_id` actual; `serial_open_ui` debe incluir ese vínculo. Abrir el monitor desde un terminal no selecciona un chat.
4. Seleccionar las líneas relevantes y usar **Enviar a agente**. Ante un error o timeout, revisar el chat antes de reenviar. Si Windows rechaza el tamaño del mensaje, elegir un fragmento menor.

La configuración prepara MCP, el hook `g-monitor-send` y el sidecar `g-monitor`, conservando otros ajustes y guardando respaldos. CLI e IDE pueden usar MCP, pero la entrega desde la ventana requiere App. La entrega real en Antigravity App continúa en validación.

## Varias ventanas con el mismo chat

Pulsar **+** en la cabecera, antes del botón de agentes. La nueva ventana hereda una copia del proyecto y del destinatario del padre; empieza con log vacío, puerto cerrado y sin COM seleccionado. Si el padre no tiene agente, el hijo tampoco tendrá destinatario.

Cada ventana conserva su vínculo: cambiar el chat o el proyecto del padre no modifica al hijo. Cerrar el padre no cierra sus hijos. El mismo COM solo puede usarse en una ventana, incluso durante una grabación. Si ya pertenece a otra, aparece **El puerto COMx está ocupado por otro monitor**. El simulador `mock` permite conexiones independientes en paralelo.

MCP ofrece `serial_list_monitors` y `serial_new_monitor`. Para leer, escribir o volver a vincular un hijo, usar su UUID completo en `monitor_id`; sin ese parámetro las herramientas apuntan a la principal. El límite por servicio es 16 monitores.

## Datos locales

Las configuraciones generadas, tokens y claves de sesión son locales al usuario. No incluir `.session`, credenciales ni respaldos de configuración en el repositorio. Detener el servicio elimina las instancias y los vínculos en memoria; para trabajar de nuevo con un agente, abrir el monitor desde su chat.
