import test from 'node:test';
import assert from 'node:assert/strict';
import { layouts, consoleKeyboardScope, editText } from './ui/keyboard-policy.mjs';

test('keyboard is limited to the dedicated console kiosk URL', () => {
  assert.equal(consoleKeyboardScope('/home-console/music-library', '?kiosk'), true);
  assert.equal(consoleKeyboardScope('/home-console/radio', '?kiosk&other=1'), true);
  assert.equal(consoleKeyboardScope('/home-console/music-library', ''), false);
  assert.equal(consoleKeyboardScope('/dashboard-new/0', '?kiosk'), false);
  assert.equal(consoleKeyboardScope('/home-console-other/music', '?kiosk'), false);
});

test('all English and Russian letters including yo are available', () => {
  assert.ok('abcdefghijklmnopqrstuvwxyz'.split('').every(letter => layouts.en.join('').includes(letter)));
  assert.ok('абвгдеёжзийклмнопрстуфхцчшщъыьэюя'.split('').every(letter => layouts.ru.join('').includes(letter)));
});

test('English and Russian entry preserve the caret and selected-text replacement', () => {
  let value = '';
  for (const key of ['B', 'a', 'c', 'h']) value = editText(value, value.length, value.length, key).value;
  assert.equal(value, 'Bach');
  assert.deepEqual(editText('Кот', 1, 2, 'и'), { value: 'Кит', caret: 2 });
  assert.deepEqual(editText('Аквариум', 8, 8, 'Space'), { value: 'Аквариум ', caret: 9 });
});

test('backspace handles selections and Unicode code points without splitting surrogates', () => {
  assert.deepEqual(editText('Bach', 1, 3, 'Backspace'), { value: 'Bh', caret: 1 });
  assert.deepEqual(editText('a😀', 3, 3, 'Backspace'), { value: 'a', caret: 1 });
  assert.deepEqual(editText('', 0, 0, 'Backspace'), { value: '', caret: 0 });
  assert.deepEqual(editText('test', 2, 2, 'Clear'), { value: '', caret: 0 });
});

test('caret arrows and out-of-range selections remain bounded', () => {
  assert.deepEqual(editText('a😀b', 3, 3, 'ArrowLeft'), { value: 'a😀b', caret: 1 });
  assert.deepEqual(editText('a😀b', 1, 1, 'ArrowRight'), { value: 'a😀b', caret: 3 });
  assert.deepEqual(editText('abc', 50, 100, 'x'), { value: 'abcx', caret: 4 });
});
