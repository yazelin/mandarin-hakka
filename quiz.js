// Pure quiz and learning-progress logic. Keep this module free of DOM and storage access.

export const QUIZ_OPTION_COUNT = 4;
export const MASTER_BOX = 3;

function normalizeValue(value) {
  return value == null ? "" : String(value).normalize("NFKC").replace(/\s+/g, " ").trim();
}

function compareText(left, right) {
  return left === right ? 0 : left < right ? -1 : 1;
}

function encodeIdPart(value) {
  return encodeURIComponent(normalizeValue(value)).replaceAll("%", "_");
}

function audioUrls(variant) {
  const values = Array.isArray(variant?.quiz_audio)
    ? variant.quiz_audio
    : variant?.quiz_audio
      ? [variant.quiz_audio]
      : [];
  return [...new Set(values.map(normalizeValue).filter(Boolean))];
}

/**
 * Build audio-first candidates. Each Mandarin answer occurs once in the pool and
 * audio URLs that point at more than one answer are excluded as ambiguous.
 */
export function buildQuizPool(input = {}, options = {}) {
  const entries = Array.isArray(input) ? input : Array.isArray(input?.entries) ? input.entries : [];
  const selectedAccent = normalizeValue(options.accent);
  const rows = [];
  const answersByAudio = new Map();

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const headword = normalizeValue(entry.headword);
    if (!headword) continue;
    for (const variant of Array.isArray(entry.variants) ? entry.variants : []) {
      const accent = normalizeValue(variant?.accent);
      if (selectedAccent && accent !== selectedAccent) continue;
      const answer = normalizeValue(variant?.quiz_answer || entry.quiz_answer);
      const pronunciation = normalizeValue(variant?.pronunciation);
      if (!answer || !pronunciation) continue;
      for (const audio of audioUrls(variant)) {
        const row = { answer, headword, pronunciation, accent, audio };
        rows.push(row);
        const answers = answersByAudio.get(audio) || new Set();
        answers.add(answer);
        answersByAudio.set(audio, answers);
      }
    }
  }

  const candidateByAnswer = new Map();
  for (const row of rows) {
    if (answersByAudio.get(row.audio)?.size !== 1) continue;
    if (candidateByAnswer.has(row.answer)) continue;
    const id = `hakka:${[row.audio, row.headword, row.accent].map(encodeIdPart).join(":")}`;
    candidateByAnswer.set(row.answer, {
      id,
      answer: row.answer,
      mandarin: row.answer,
      audio: row.audio,
      headword: row.headword,
      hanji: row.headword,
      pronunciation: row.pronunciation,
      romanization: row.pronunciation,
      accent: row.accent,
      accents: row.accent ? [row.accent] : [],
    });
  }
  return [...candidateByAnswer.values()].sort((left, right) => compareText(left.id, right.id));
}

function randomIndex(length, rng) {
  const value = Number(rng());
  const normalized = Number.isFinite(value) ? Math.min(Math.max(value, 0), 0.999999999) : 0;
  return Math.floor(normalized * length);
}

function shuffled(values, rng) {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const picked = randomIndex(index + 1, rng);
    [copy[index], copy[picked]] = [copy[picked], copy[index]];
  }
  return copy;
}

function answerLength(answer) {
  return [...answer].length;
}

function distractorsFor(question, answers, rng) {
  const wantedLength = answerLength(question.answer);
  return shuffled(
    answers
      .filter((answer) => answer !== question.answer)
      .sort(
        (left, right) =>
          Math.abs(answerLength(left) - wantedLength) - Math.abs(answerLength(right) - wantedLength) ||
          compareText(left, right),
      ),
    rng,
  ).slice(0, QUIZ_OPTION_COUNT - 1);
}

/** Draw an exact-size round with unique questions and four unique choices each. */
export function buildQuizRound(pool, count = 10, rng = Math.random) {
  if (!Array.isArray(pool)) throw new TypeError("pool must be an array");
  if (!Number.isInteger(count) || count < 0) throw new RangeError("count must be a non-negative integer");
  if (typeof rng !== "function") throw new TypeError("rng must be a function");
  if (count === 0) return [];

  const candidatesByAnswer = new Map();
  for (const candidate of pool) {
    const answer = normalizeValue(candidate?.answer || candidate?.mandarin);
    if (answer && !candidatesByAnswer.has(answer)) candidatesByAnswer.set(answer, candidate);
  }
  const answers = [...candidatesByAnswer.keys()].sort(compareText);
  if (answers.length < QUIZ_OPTION_COUNT) {
    throw new RangeError(`quiz needs at least ${QUIZ_OPTION_COUNT} distinct answers`);
  }
  if (answers.length < count) {
    throw new RangeError(`quiz has only ${answers.length} distinct answers for ${count} questions`);
  }

  return shuffled(answers, rng)
    .slice(0, count)
    .map((answer) => {
      const source = candidatesByAnswer.get(answer);
      const options = shuffled([answer, ...distractorsFor({ ...source, answer }, answers, rng)], rng);
      return { ...source, answer, mandarin: answer, correctAnswer: answer, options, correctIndex: options.indexOf(answer) };
    });
}

function nonNegativeInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function learningBox(value) {
  return Math.max(1, Math.min(MASTER_BOX, nonNegativeInteger(value, 1)));
}

export function nextLearningProgress(current = {}, wasCorrect, answeredAt) {
  if (typeof wasCorrect !== "boolean") throw new TypeError("wasCorrect must be a boolean");
  const previous = current && typeof current === "object" ? current : {};
  const box = learningBox(previous.box);
  const next = {
    ...previous,
    box: wasCorrect ? Math.min(MASTER_BOX, box + 1) : 1,
    attempts: nonNegativeInteger(previous.attempts) + 1,
    correct: nonNegativeInteger(previous.correct) + (wasCorrect ? 1 : 0),
    wrong: nonNegativeInteger(previous.wrong) + (wasCorrect ? 0 : 1),
    streak: wasCorrect ? nonNegativeInteger(previous.streak) + 1 : 0,
  };
  if (answeredAt !== undefined) next.lastAnsweredAt = answeredAt;
  return next;
}

export function isMastered(progressOrBox) {
  const value = progressOrBox && typeof progressOrBox === "object" ? progressOrBox.box : progressOrBox;
  return learningBox(value) >= MASTER_BOX;
}

export function currentWrongCandidates(pool = [], progressById = {}) {
  if (!Array.isArray(pool)) return [];
  const progressFor =
    progressById instanceof Map
      ? (id) => progressById.get(id)
      : (id) => (progressById && typeof progressById === "object" ? progressById[id] : undefined);
  return pool.filter((candidate) => {
    const progress = progressFor(candidate?.id);
    return nonNegativeInteger(progress?.wrong) > 0 && !isMastered(progress);
  });
}
