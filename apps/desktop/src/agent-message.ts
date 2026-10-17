export const MAX_AGENT_MESSAGE_BYTES = 1024 * 1024;

export function formatAgentMessage(message:string, log:string) {
  const introduction = message.trim();
  return `${introduction ? `Mensaje para agente:\n${introduction}\n\n` : ''}Información del log:\n${log}`;
}

export function agentMessageError(message:string, log:string) {
  if (!message.trim() && !log.trim()) return 'There is no content to send to the agent.';
  if (new TextEncoder().encode(formatAgentMessage(message,log)).length > MAX_AGENT_MESSAGE_BYTES) return 'The message and log exceed 1 MiB. Select a smaller log fragment.';
  return '';
}
