import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectCreationStatus } from '../src/web/creation-status.js';

test('local strip becomes secondary despite repeated Ready checks and invalidates on offline or malformed evidence', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  class Element {
    hidden = false;
    textContent = '';
    children: Element[] = [];
    removed = false;
    setAttribute() {}
    attachShadow() { return new Element(); }
    append(...children: Element[]) { this.children.push(...children); }
    prepend(child: Element) { this.children.unshift(child); }
    remove() { this.removed = true; }
  }
  class Source {
    static current: Source;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    closed = false;
    constructor() { Source.current = this; }
    emit(value: object) { this.onmessage?.({ data: JSON.stringify(value) }); }
    close() { this.closed = true; }
  }
  const elements: { tag: string; element: Element }[] = [];
  const connection = { onLine: true }, window = new EventTarget();
  const replacements = {
    document: { body: new Element(), createElement: (tag: string) => {
      const element = new Element();
      elements.push({ tag, element });
      return element;
    } },
    EventSource: Source, navigator: connection, window,
  };
  const originals = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { configurable: true, value });
  t.after(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const disconnect = connectCreationStatus('/__sql_apps/creation');
  const message = elements.find(item => item.tag === 'span')?.element;
  assert.ok(message);
  const source = Source.current;
  source.emit({ ready: true, usable: true });
  t.mock.timers.tick(3000);
  source.emit({ ready: true, usable: true });
  t.mock.timers.tick(2000);
  assert.equal(message.hidden, true, 'periodic verification must not keep resetting the success treatment');
  source.emit({ ready: true, usable: true });
  assert.equal(message.hidden, true);
  source.emit({ ready: false, usable: true });
  assert.equal(message.hidden, false);
  assert.match(message.textContent, /review pending/);
  source.emit({ ready: true, usable: true });
  connection.onLine = false;
  window.dispatchEvent(new Event('offline'));
  source.emit({ ready: true, usable: true });
  assert.match(message.textContent, /Reconnecting/);
  assert.equal(message.hidden, false);
  connection.onLine = true;
  source.emit({});
  assert.match(message.textContent, /unavailable/);
  disconnect();
  assert.equal(source.closed, true);
  assert.equal(elements.find(item => item.tag === 'aside')?.element.removed, true);
});
