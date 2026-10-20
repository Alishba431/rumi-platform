# Lesson-plan fidelity fixtures

These are calibration fixtures for the lesson-plan fidelity feature. Everything here is entirely fictional and was written from scratch for this repository. No real teachers, pupils, schools, places or recordings were used. Pupil names (Sam, Ayo, Lina, Tomi) are invented placeholders.

- `plan_fractions.md` is a Grade 4 maths plan (adding fractions with the same denominator). It has 12 required moves and 1 optional extension.
- `plan_plants.md` is a Grade 4 science plan (parts of a plant and their jobs). It has 11 required moves and 1 optional extension.
- The `transcript_*.txt` files use the speech-to-text formatter's output format, `[MM:SS] Teacher (EN): ...`, with each lesson compressed into about 4 minutes.

| Case | Plan | Transcript | Expected fidelity |
|------|------|------------|-------------------|
| full | fractions | `transcript_full.txt` | 90-100 (every move executed) |
| half | fractions | `transcript_half.txt` | 55-75 (7 executed, 2 partial, 3 skipped: pair activity, peer check, whole-class check) |
| substituted | fractions | `transcript_substituted.txt` | 85-100 (number line instead of fraction strips, credited as substitutions) |
| plants_vs_fractions | fractions | `transcript_plants.txt` | 0-15, `lesson_mismatch` |
| nostamps | fractions | `transcript_full_nostamps.txt` | null, not assessed (the same words as `full` with no timestamps or speakers) |
| plants_self | plants | `transcript_plants.txt` | 85-100 |

For each case, `ground_truth.json` lists the expected range and the intended verdict for every plan step, together with the timestamp of the evidence. Optional moves that were not attempted are marked `optional` and are excluded from the denominator. The fixtures are a calibration check: you run the real default extractor and grader models over each case and confirm the computed score falls inside the expected range. Exact per-move verdicts are guidance only and are not asserted.
