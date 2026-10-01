import {describe, expect, it} from 'vitest';
import {Bpe, type BpeData} from './bpe';

// A small vocabulary: characters, the byte tokens for "é", and merges building "the", "▁the" and "ab".
const tokens = ['<bos>', '<eos>', '<start_of_turn>', '<end_of_turn>', '<0xC3>', '<0xA9>', 't', 'h', 'e', '▁', 'a', 'b', '\n',
  'th', 'the', '▁the', 'ab'];
const id = (t: string) => tokens.indexOf(t);
const data: BpeData = {
  tokens,
  merges: [[id('t'), id('h')], [id('th'), id('e')], [id('▁'), id('the')], [id('a'), id('b')]],
  bos: 0, eos: 1, start: 2, end: 3,
};
const bpe = new Bpe(data);
const said = (ids: number[]) => ids.map(i => tokens[i]);

describe('the language model tokenizer', () => {
  it('merges by rank, spaces as "▁"', () => {
    expect(said(bpe.encode('the the ab'))).toEqual(['the', '▁the', '▁', 'ab']);
  });

  it('reads special tokens as such, and characters it has no token for as their bytes', () => {
    expect(said(bpe.encode('<start_of_turn>the\né<end_of_turn>'))).toEqual(['<start_of_turn>', 'the', '\n', '<0xC3>', '<0xA9>', '<end_of_turn>']);
  });

  it('decodes back, bytes and all', () => {
    expect(bpe.decode(bpe.encode('the the ab é'))).toBe('the the ab é');
  });
});
