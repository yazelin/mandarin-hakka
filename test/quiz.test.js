import test from "node:test";
import assert from "node:assert/strict";

import {
  MASTER_BOX,
  buildQuizPool,
  buildQuizRound,
  currentWrongCandidates,
  isMastered,
  nextLearningProgress,
} from "../quiz.js";

function entry(number, overrides = {}) {
  return {
    headword: `客詞${number}`,
    quiz_answer: `華語釋義第 ${number} 句。`,
    variants: [
      {
        accent: number % 2 ? "四縣" : "海陸",
        pronunciation: `hak${number}`,
        audio: [`https://example.test/official-${number}.mp3`],
        quiz_audio: `../assets/hakka-audio/${number % 2 ? "sixian" : "hailu"}/${number}.mp3`,
        ...overrides,
      },
    ],
  };
}

test("quiz pool requires a clear answer and same-origin learning audio hook", () => {
  const pool = buildQuizPool({ entries: [entry(1), entry(2), entry(3, { quiz_audio: "" })] });
  assert.equal(pool.length, 2);
  assert.equal(pool[0].id.startsWith("hakka:"), true);
  assert.equal(pool.some((candidate) => candidate.audio.includes("official")), false);
});

test("quiz pool filters by accent and keeps one candidate per answer", () => {
  const duplicate = entry(3);
  duplicate.quiz_answer = entry(1).quiz_answer;
  const pool = buildQuizPool({ entries: [entry(1), entry(2), duplicate] }, { accent: "四縣" });
  assert.equal(pool.length, 1);
  assert.equal(pool[0].accent, "四縣");
});

test("ten-question round is randomizable, non-repeating, and four-choice", () => {
  const pool = buildQuizPool({ entries: Array.from({ length: 14 }, (_, index) => entry(index + 1)) });
  const round = buildQuizRound(pool, 10, () => 0.37);
  assert.equal(round.length, 10);
  assert.equal(new Set(round.map(({ id }) => id)).size, 10);
  for (const question of round) {
    assert.equal(question.options.length, 4);
    assert.equal(new Set(question.options).size, 4);
    assert.equal(question.options[question.correctIndex], question.correctAnswer);
  }
});

test("learning progress records wrong answers and reaches mastery", () => {
  const candidate = buildQuizPool({ entries: [entry(1)] })[0];
  const wrong = nextLearningProgress({}, false, "2026-07-14T00:00:00Z");
  assert.deepEqual(currentWrongCandidates([candidate], { [candidate.id]: wrong }), [candidate]);
  const learned = nextLearningProgress(nextLearningProgress(wrong, true), true);
  assert.equal(learned.box, MASTER_BOX);
  assert.equal(isMastered(learned), true);
  assert.deepEqual(currentWrongCandidates([candidate], { [candidate.id]: learned }), []);
});
