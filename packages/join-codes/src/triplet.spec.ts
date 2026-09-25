import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { FIRST_WORDS, generateTriplet, LAST_WORDS, MIDDLE_WORDS, type Rng } from "./triplet.js";

/** A triplet: three runs of lowercase ASCII letters joined by `-`. */
const TRIPLET_SHAPE = /^[a-z]+-[a-z]+-[a-z]+$/;

/**
 * An Rng whose successive values draw, from a list of `length` words, the word
 * at `index` of each `[index, length]` pair in `draws`, in order. Fails the
 * spec when called more times than `draws` has pairs.
 */
function drawing(draws: readonly (readonly [index: number, length: number])[]): Rng {
  let next = 0;
  return () => {
    const draw = draws[next++];
    assert.ok(draw !== undefined, "generateTriplet drew more words than the spec supplied");
    const [index, length] = draw;
    return (index + 0.5) / length;
  };
}

/** Replaces `Math.random` with `rng` until the spec ends. */
function injectRng(rng: Rng): void {
  mock.method(Math, "random", rng);
}

describe("generateTriplet", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it("joins a first, a middle, and a last word, in that order, with hyphens", () => {
    for (let i = 0; i < 200; i++) {
      const triplet = generateTriplet();
      assert.match(triplet, TRIPLET_SHAPE);
      const [first, middle, last] = triplet.split("-");
      assert.ok((FIRST_WORDS as readonly string[]).includes(first));
      assert.ok((MIDDLE_WORDS as readonly string[]).includes(middle));
      assert.ok((LAST_WORDS as readonly string[]).includes(last));
    }
  });

  it("returns the words the random source selects", () => {
    const draws = [
      [3, FIRST_WORDS.length],
      [5, MIDDLE_WORDS.length],
      [7, LAST_WORDS.length],
    ] as const;
    const expected = `${FIRST_WORDS[3]}-${MIDDLE_WORDS[5]}-${LAST_WORDS[7]}`;

    injectRng(drawing(draws));
    assert.equal(generateTriplet(), expected);

    injectRng(drawing(draws));
    assert.equal(generateTriplet(), expected);
  });

  it("draws all three words again when two of them are equal", () => {
    const shared = FIRST_WORDS.findIndex((word) => (MIDDLE_WORDS as readonly string[]).includes(word));
    assert.ok(shared >= 0, "the word lists share no word");
    const sharedInMiddle = (MIDDLE_WORDS as readonly string[]).indexOf(FIRST_WORDS[shared]);

    injectRng(
      drawing([
        [shared, FIRST_WORDS.length],
        [sharedInMiddle, MIDDLE_WORDS.length],
        [0, LAST_WORDS.length],
        [1, FIRST_WORDS.length],
        [2, MIDDLE_WORDS.length],
        [3, LAST_WORDS.length],
      ])
    );
    assert.equal(generateTriplet(), `${FIRST_WORDS[1]}-${MIDDLE_WORDS[2]}-${LAST_WORDS[3]}`);
  });
});
