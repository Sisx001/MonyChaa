'use strict';
// Lightweight mood read on an incoming message, used to steer the reply's tone.
// Heuristic (keywords, caps, punctuation, emoji) — a hint, never a diagnosis.
// Pure function → deterministic and testable.

const SIGNALS = [
  { mood: 'upset', re: /\b(angry|furious|pissed|annoyed|ridiculous|unacceptable|useless|terrible|awful|horrible|hate|wtf|screw|frustrat\w*|fed up|sick of|disgust\w*|outrage\w*)\b|😡|🤬/i,
    hint: 'The sender seems upset. Stay calm, acknowledge their frustration first, don\'t get defensive, and keep it short and sincere.' },
  { mood: 'sad', re: /\b(sad|down|depress\w*|unhappy|miserable|crying|heartbroken|lonely|hopeless|exhausted|burnt? out|devastated|gutted|grieving)\b|:\(|😢|😭|💔/i,
    hint: 'The sender seems down. Be warm, gentle and validating — listen first, don\'t rush to fix or cheerlead.' },
  { mood: 'anxious', re: /\b(worried|worry|nervous|anxious|scared|afraid|stress\w*|panic\w*|overwhelmed|dreading|on edge|freaking out)\b|😰|😨/i,
    hint: 'The sender seems anxious. Be reassuring, clear and steady; break things into simple next steps.' },
  { mood: 'grateful', re: /\b(thank you|thanks|thx|ty|grateful|appreciate|appreciated|means a lot|life ?saver|you'?re the best|much appreciated)\b|🙏/i,
    hint: 'The sender is grateful. Receive it warmly and briefly — a gracious, human acknowledgement, not a formal one.' },
  { mood: 'confused', re: /\b(confused|confusing|don'?t (get|understand)|not sure what|no idea|makes no sense|what do you mean|lost|unclear|huh\??)\b|🤔|😕/i,
    hint: 'The sender seems confused. Slow down, clarify one thing at a time in plain words, and check you\'ve understood their question.' },
  { mood: 'excited', re: /\b(excited|amazing|awesome|incredible|can'?t wait|so happy|yay+|woo+|congrats|congratulations|love (it|this)|stoked|pumped|thrilled)\b|🎉|😍|🥳/i,
    hint: 'The sender is excited. Match their energy and celebrate with them before anything else.' },
];

/** Detect apparent mood. Returns { mood, hint } — hint is '' when neutral. */
function detect(text) {
  const s = String(text || '');
  if (!s.trim()) return { mood: 'neutral', hint: '' };
  // Strong non-verbal signals bias toward upset/excited.
  const letters = s.replace(/[^A-Za-z]/g, '');
  const shouting = letters.length >= 6 && letters === letters.toUpperCase();
  const bangs = (s.match(/!/g) || []).length;

  for (const sig of SIGNALS) {
    if (sig.re.test(s)) return { mood: sig.mood, hint: sig.hint };
  }
  if (shouting && bangs >= 1) {
    return { mood: 'excited', hint: SIGNALS.find(x => x.mood === 'excited').hint };
  }
  return { mood: 'neutral', hint: '' };
}

module.exports = { detect };
