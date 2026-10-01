/**
 * How the recogniser has heard some names in real tests: English words it's so sure of that the name
 * spotting can't beat them ("right to" for Raichu), or that sound as close to other names ("carbonite"
 * is as close to Scrafty as to Corviknight). Put back as the name wherever that Pokémon can be meant.
 */
export const HEARD_AS: Record<string, string[]> = {
  Corviknight: ['carbonite', 'curvonite', 'corby night', 'curvy night'],
  Rillaboom: ['really boom', 'relay boom', 'villa boom', 'relabum'],
  Gholdengo: ['gardenia', 'gardeno', 'golden go'],
  Pidgeot: ['idiot', 'pidgeotto'],
  Dragapult: ['dragon ball', 'dragon pult'],
  Milotic: ['celtic'],
  Altaria: ['alitalia'],
  Raichu: ['right to', 'rite to', 'write to', 'right two', 'rite two', 'write two', 'right you', 'rite you', 'write you', 'rich you', 'raito', 'rai to'],
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The phrase with the ways these names have been heard put back as the names ("Right to Protect": "Raichu
 * Protect"). `names`: the Pokémon that can be meant (a battle's, or every one at team preview); a forme
 * ("Raichu-Mega-Y") is heard as its species.
 */
export function namesPutBack(text: string, names: readonly string[]): string {
  let out = text;
  for (const name of names) {
    const heard = HEARD_AS[name] ?? HEARD_AS[name.split('-')[0]];
    if (!heard) continue;
    for (const h of heard) {
      const words = h.split(' ').map(escape).join('[\\s,.-]+');
      out = out.replace(new RegExp(`(^|[^\\p{L}])${words}(?=[^\\p{L}]|$)`, 'giu'), (_, pre: string) => `${pre}${name}`);
    }
  }
  return out;
}

/**
 * "Dragonite switch for Sneasler", "switch Dragonite to Sneasler": put as the reader knows a switch ("Dragonite out,
 * Sneasler in"). `names`: the Pokémon that can be meant.
 */
export function switchPutPlain(text: string, names: readonly string[]): string {
  const alt = [...new Set(names)].sort((a, b) => b.length - a.length).map(n => escape(n).replace(/-/g, '[\\s-]')).join('|');
  if (!alt) return text;
  const verb = '(?:sw\\w*tch(?:e[sd]|ing)?|swap(?:ped|s|ping)?)';
  const link = '(?:\\s+out)?\\s+(?:for|to|into|with)\\s+';
  const name = `(${alt})`;
  const plain = (_: string, pre: string, a: string, b: string) => `${pre}${a} out, ${b} in`;
  return text
    .replace(new RegExp(`(^|[^\\p{L}])${name}[\\s,]+${verb}${link}${name}(?=[^\\p{L}]|$)`, 'giu'), plain)
    .replace(new RegExp(`(^|[^\\p{L}])${verb}\\s+${name}${link}${name}(?=[^\\p{L}]|$)`, 'giu'), plain);
}
