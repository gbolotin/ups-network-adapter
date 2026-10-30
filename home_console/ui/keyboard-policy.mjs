export const layouts = {
  en: ['1234567890-\'.', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'],
  ru: ['1234567890-\'.', 'йцукенгшщзхъ', 'фывапролджэ', 'ячсмитьбюё'],
};

export function consoleKeyboardScope(pathname, search) {
  return pathname.startsWith('/home-console/') && new URLSearchParams(search).has('kiosk');
}

export function editText(value, start, end, key) {
  start = Math.max(0, Math.min(value.length, start ?? value.length));
  end = Math.max(start, Math.min(value.length, end ?? start));
  if (key === 'Clear') return { value: '', caret: 0 };
  if (key === 'ArrowLeft') return { value, caret: start - (Array.from(value.slice(0, start)).at(-1)?.length || 0) };
  if (key === 'ArrowRight') return { value, caret: end + (Array.from(value.slice(end))[0]?.length || 0) };
  if (key === 'Backspace') {
    if (start === end) start -= Array.from(value.slice(0, start)).at(-1)?.length || 0;
    key = '';
  }
  if (key === 'Space') key = ' ';
  return { value: value.slice(0, start) + key + value.slice(end), caret: start + key.length };
}
