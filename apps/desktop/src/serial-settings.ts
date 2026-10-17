import {useEffect,useState} from 'react';
import {defaultSerialFormat,parseSerialFormat,type SerialFormat} from '../../../packages/daemon/src/serial-format';
const key='serial-monitor.serial-format';
function load():SerialFormat {
  try {return parseSerialFormat(JSON.parse(localStorage.getItem(key) ?? '{}'));}
  catch {return {...defaultSerialFormat};}
}
export function useSerialSettings() {
  const [format,setFormat]=useState(load);
  useEffect(()=>{try{localStorage.setItem(key,JSON.stringify(format));}catch{/* Keep session settings without storage. */}},[format]);
  return [format,setFormat] as const;
}
