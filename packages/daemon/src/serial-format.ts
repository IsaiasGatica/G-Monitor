export type SerialFormat = {
  dataBits:5|6|7|8;
  parity:'none'|'even'|'odd';
  stopBits:1|2;
};
export const defaultSerialFormat:SerialFormat = {dataBits:8,parity:'none',stopBits:1};
export function parseSerialFormat(value:Partial<SerialFormat> = {}, fallback:SerialFormat = defaultSerialFormat):SerialFormat {
  const dataBits=value.dataBits ?? fallback.dataBits;
  const parity=value.parity ?? fallback.parity;
  const stopBits=value.stopBits ?? fallback.stopBits;
  if (![5,6,7,8].includes(dataBits) || !['none','even','odd'].includes(parity) || ![1,2].includes(stopBits)) throw new Error('Invalid serial format: use data bits 5–8, parity none/even/odd and stop bits 1/2.');
  return {dataBits,parity,stopBits};
}
export function serialFormatLabel(format:SerialFormat):string {
  const parity = {none:'N',even:'E',odd:'O'}[format.parity];
  return `${format.dataBits}${parity}${format.stopBits}`;
}
