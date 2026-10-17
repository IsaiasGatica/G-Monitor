type Name = 'terminal'|'robot'|'settings'|'close'|'minus'|'plus'|'refresh'|'trash'|'download'|'copy'|'pause'|'play'|'send'|'search'|'down'|'comment'|'note'|'folder'|'upload';
const paths:Record<Name,string> = {
  terminal:'m5 7 5 5-5 5M13 17h6',
  robot:'M12 3v4M10 3h4M6 7h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2ZM1 12v4M23 12v4M8 11v2M16 11v2M8 17h8',
  folder:'M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z',
  upload:'M12 15V3m-5 5 5-5 5 5M5 16v5h14v-5',
  note:'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6ZM14 3v6h6M8 8h3M8 13h8M8 17h8',
  comment:'M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10ZM7 8h10M7 12h6',
  down:'M12 4v16m-6-6 6 6 6-6',
  settings:'M9.98 4.47L10.61 2.1L13.39 2.1L14.02 4.47L15.9 5.25L18.02 4.01L19.99 5.98L18.75 8.1L19.53 9.98L21.9 10.61L21.9 13.39L19.53 14.02L18.75 15.9L19.99 18.02L18.02 19.99L15.9 18.75L14.02 19.53L13.39 21.9L10.61 21.9L9.98 19.53L8.1 18.75L5.98 19.99L4.01 18.02L5.25 15.9L4.47 14.02L2.1 13.39L2.1 10.61L4.47 9.98L5.25 8.1L4.01 5.98L5.98 4.01L8.1 5.25ZM15.25 12a3.25 3.25 0 1 0-6.5 0 3.25 3.25 0 0 0 6.5 0Z',
  close:'m6 6 12 12M6 18 18 6', minus:'M5 12h14', plus:'M5 12h14M12 5v14', refresh:'M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 2M4 16l2 2a7 7 0 0 0 12-1',
  trash:'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7', download:'M12 3v12m-5-5 5 5 5-5M5 16v5h14v-5',
  copy:'M9 9h12v12H9V9ZM5 15H3V3h12v2', pause:'M8 5v14M16 5v14', play:'m8 5 11 7-11 7V5Z', send:'m3 3 18 9-18 9 3-9-3-9ZM6 12h15', search:'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm5 12 6 6'
};
export function Icon({name}:{name:Name}) {
  return <svg className="icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name]}/></svg>;
}
