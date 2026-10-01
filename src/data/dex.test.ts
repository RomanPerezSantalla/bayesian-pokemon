import {describe, expect, it} from 'vitest';
import {getGen, spriteUrls} from './dex';

describe('spriteUrls', () => {
  const gen = getGen(0);
  const files = (name: string) => spriteUrls(gen, name).map(u => u.split('/').pop());

  it("names formes the way Showdown does, even where Champions' data chains them differently", () => {
    expect(files('Floette-Mega')[0]).toBe('floette-mega.png');
    expect(files('Floette-Eternal')[0]).toBe('floette-eternal.png');
    expect(files('Aegislash-Shield')).toEqual(['aegislash.png']);
    expect(files('Aegislash-Blade')).toEqual(['aegislash-blade.png']);
    expect(files('Kommo-o')).toEqual(['kommoo.png']);
    expect(files('Incineroar')).toEqual(['incineroar.png']);
  });

  it("falls back to the regular forme's sprite, for a Mega Showdown hasn't drawn yet", () => {
    expect(files('Raichu-Mega-X')).toEqual(['raichu-megax.png', 'raichu.png']);
    expect(files('Malamar-Mega')).toEqual(['malamar-mega.png', 'malamar.png']);
  });
});
