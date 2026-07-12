'use strict';
// Lightweight language detection for an incoming message. Uses Unicode script
// ranges for non-Latin scripts and common-word heuristics for major Latin-script
// languages. It's a hint (for logs, analytics and reply steering), not a
// linguistic guarantee. Pure function → deterministic and testable.

const SCRIPTS = [
  { code: 'ru', name: 'Russian', re: /[Ѐ-ӿ]/ },
  { code: 'ar', name: 'Arabic', re: /[؀-ۿ]/ },
  { code: 'he', name: 'Hebrew', re: /[֐-׿]/ },
  { code: 'el', name: 'Greek', re: /[Ͱ-Ͽ]/ },
  { code: 'hi', name: 'Hindi', re: /[ऀ-ॿ]/ },
  { code: 'th', name: 'Thai', re: /[฀-๿]/ },
  { code: 'ja', name: 'Japanese', re: /[぀-ヿ]/ },   // kana is decisive for JA
  { code: 'ko', name: 'Korean', re: /[가-힯]/ },
  { code: 'zh', name: 'Chinese', re: /[一-鿿]/ },    // Han without kana → ZH
];

// Frequent function words per Latin-script language (lowercased, word-boundary).
const LATIN = {
  es: { name: 'Spanish', words: ['que', 'de', 'no', 'la', 'el', 'y', 'es', 'por', 'como', 'para', 'con', 'una', 'gracias', 'hola', 'pero', 'muy'] },
  fr: { name: 'French', words: ['le', 'la', 'les', 'de', 'et', 'est', 'pas', 'vous', 'bonjour', 'merci', 'je', 'un', 'une', 'pour', 'avec', 'oui'] },
  de: { name: 'German', words: ['und', 'der', 'die', 'das', 'ist', 'nicht', 'ich', 'du', 'danke', 'hallo', 'ein', 'eine', 'mit', 'für', 'aber', 'ja'] },
  pt: { name: 'Portuguese', words: ['que', 'de', 'não', 'para', 'com', 'uma', 'obrigado', 'olá', 'você', 'está', 'muito', 'bom', 'sim', 'por'] },
  it: { name: 'Italian', words: ['che', 'di', 'non', 'per', 'con', 'una', 'grazie', 'ciao', 'sono', 'più', 'anche', 'bene', 'sì', 'come'] },
  en: { name: 'English', words: ['the', 'and', 'you', 'to', 'is', 'are', 'for', 'with', 'thanks', 'hello', 'hi', 'please', 'what', 'this', 'that', 'not'] },
};

/** Detect the message language. Returns { code, name }. */
function detect(text) {
  const s = String(text || '');
  if (!s.trim()) return { code: 'und', name: 'Unknown' };

  // Non-Latin scripts are decided by character ranges (kana beats Han for JA).
  for (const sc of SCRIPTS) {
    if (sc.re.test(s)) return { code: sc.code, name: sc.name };
  }

  // Latin scripts: score by matching function words.
  const tokens = s.toLowerCase().match(/[a-zà-ÿ']+/g) || [];
  if (!tokens.length) return { code: 'und', name: 'Unknown' };
  const set = new Set(tokens);
  let best = null, bestScore = 0;
  for (const [code, { name, words }] of Object.entries(LATIN)) {
    let score = 0;
    for (const w of words) if (set.has(w)) score++;
    if (score > bestScore) { bestScore = score; best = { code, name }; }
  }
  if (bestScore === 0) return { code: 'und', name: 'Unknown' };
  return best;
}

module.exports = { detect };
