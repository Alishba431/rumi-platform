# lp-v9 — the diagram engine

The engine that draws the lesson-quiz figures (`diagrams/`) and the maths and
font helpers it shares (`lib/`). It is first-party code written for this
repository and is licensed under the Apache License 2.0, like the rest of the
repository (see `LICENSE` at the repository root).

Only the lesson quiz uses it (`shared/services/quiz/transcript-quiz-figure.js`
and its neighbours, the question card and the teacher sheet).

## Third-party parts

| Part | Where | Licence |
| --- | --- | --- |
| Inter (Regular, SemiBold, Bold), Copyright 2016 The Inter Project Authors | `fonts/` | SIL Open Font License 1.1, see `fonts/OFL.txt` |
| OpenMoji 15.0.0 pictograms (black variant) | `diagrams/assets/pictograms/` | CC BY-SA 4.0, see `diagrams/assets/pictograms/ATTRIBUTION.md` and `LICENSE.txt` |
| KaTeX | installed from npm (`katex` in `bot/package.json`), not copied here | MIT |

The leaf sketch in `diagrams/assets/leaf_sketch.png` was drawn for this
repository and is covered by the repository's licence.
