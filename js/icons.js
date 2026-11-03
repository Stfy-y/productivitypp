const p = (d, extra = '') =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${d}</svg>`;

export const ICONS = {
  today: p('<rect x="3" y="4" width="18" height="17" rx="3"/><path d="M8 2v4M16 2v4M3 10h18"/><circle cx="12" cy="15.5" r="2" fill="currentColor"/>'),
  week: p('<rect x="3" y="4" width="18" height="17" rx="3"/><path d="M8 2v4M16 2v4M3 10h18M7 14h2M11 14h2M15 14h2M7 17.5h2M11 17.5h2"/>'),
  inbox: p('<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z"/>'),
  done: p('<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>'),
  calendar: p('<rect x="3" y="4" width="18" height="17" rx="3"/><path d="M8 2v4M16 2v4M3 10h18"/>'),
  matrix: p('<rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2"/>'),
  habits: p('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1" fill="currentColor"/>'),
  settings: p('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  plus: p('<path d="M12 5v14M5 12h14"/>'),
  check: p('<path d="m5 12.5 4.5 4.5L19 7"/>', 'stroke-width="3"'),
  left: p('<path d="m15 18-6-6 6-6"/>'),
  right: p('<path d="m9 18 6-6-6-6"/>'),
  close: p('<path d="M18 6 6 18M6 6l12 12"/>'),
  bell: p('<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>'),
  repeat: p('<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>'),
  trash: p('<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>'),
  flame: p('<path d="M12 22c4 0 7-2.7 7-7 0-4-3-6-4-10-2 2-3 4-3 6-1-1-2-2-2-4-2 2-5 5-5 8 0 4.3 3 7 7 7z"/>'),
  cloud: p('<path d="M17.5 19a4.5 4.5 0 1 0-1.4-8.8A6 6 0 0 0 4.5 13 3 3 0 0 0 6 19z"/>'),
  sun: p('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  back: p('<path d="M19 12H5M12 19l-7-7 7-7"/>'),
  edit: p('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
  archive: p('<rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4"/>'),
  download: p('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>'),
};
export const icon = (name) => ICONS[name] || '';
