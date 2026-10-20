'use strict';
/**
 * How we address a teacher or coach in Urdu (the `ur` language pack) when we do
 * not know their gender — which is always.
 *
 * Teachers and coaches are of every gender and nothing in our data tells us who
 * is on the other end. Guessing wrong is not a grammar slip: a man addressed as
 * «آپ کرتی ہیں», or a woman as «آپ کرتے ہیں», hears a system that was clearly
 * not built with them in mind.
 *
 * This module exists so the rule lives in ONE place: every prompt that has a
 * model speak TO a teacher in Urdu imports it rather than carrying its own
 * hand-copied paragraph. Editing the rule in one place beats discovering a
 * divergent copy.
 */

/**
 * THE URDU ADDRESS RULE — one sentence set, shared by every prompt that has a
 * model speak TO a teacher or a coach in Urdu (today: the class report's
 * "for tomorrow" guidance).
 *
 * An earlier wording offered the "respectful plural" («آپ کرتے ہیں، آپ چاہتے
 * ہیں») as the neutral form. It is the masculine — a woman is «آپ کرتی ہیں» —
 * so a model following it guessed "man" every time. The neutral forms carry no
 * gender at all: the آپ-imperative or subjunctive, the past with نے (the verb
 * agrees with its OBJECT), and an impersonal or obligative form. Every example
 * quoted here is held to the same deterministic second-person check the quiz
 * uses (services/quiz/transcript-quiz-address.js), so the rule and the check
 * cannot disagree about what is neutral.
 */
const URDU_ADDRESS_RULE = 'In Urdu, a verb spoken TO this person (آپ) carries no gender. The so-called respectful plural is the MASCULINE, not a neutral form: '
  + '«آپ کرتے ہیں» is how a man is addressed and «آپ کرتی ہیں» how a woman is — never either. The same holds for '
  + '«آپ چاہتے ہیں» / «آپ چاہتی ہیں», «آپ کر سکتے ہیں» / «آپ کر سکتی ہیں», «آپ کریں گے» / «آپ کریں گی» and «آپ سوچ رہے ہیں» / «آپ سوچ رہی ہیں». '
  + 'Say it instead with the آپ-imperative or subjunctive («بتائیں»، «آپ یہ آزمائیں»، «کس بارے میں بات کریں؟»); '
  + 'the past with نے, whose verb agrees with its object and not with آپ («آپ نے بتایا»، «آپ نے بچوں سے سوال پوچھا»); '
  + 'or an impersonal or obligative form («یہ آزمایا جا سکتا ہے»، «کل یہ کرنا ہوگا»، «کس بارے میں بات کرنی ہے؟»).';

module.exports = { URDU_ADDRESS_RULE };
