/**
 * FSI French Course - Error Classification System
 * SIMPLIFIED: Focus on accuracy over cleverness
 */

const FSI_Error = {
  // Normalize text for comparison
  normalize(text) {
    return text
      .toLowerCase()
      .replace(/[-'']/g, "'")  // Normalize apostrophes
      .replace(/[.,!?;:«»""]/g, '')  // Strip punctuation
      .trim()
      .replace(/\s+/g, ' ');
  },

  // Strip accents for fuzzy matching
  stripAccents(text) {
    return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  },

  // Tokenize into words (no punctuation)
  tokenize(text) {
    return this.normalize(text).split(' ').filter(w => w.length > 0);
  },

  // Levenshtein distance
  levenshtein(a, b) {
    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i-1) === a.charAt(j-1)) {
          matrix[i][j] = matrix[i-1][j-1];
        } else {
          matrix[i][j] = Math.min(matrix[i-1][j-1] + 1, matrix[i][j-1] + 1, matrix[i-1][j] + 1);
        }
      }
    }
    return matrix[b.length][a.length];
  },

  // Main classification - SIMPLE AND RELIABLE
  classify(userInput, expected) {
    const userNorm = this.normalize(userInput);
    const expNorm = this.normalize(expected);

    // Exact match
    if (userNorm === expNorm) {
      return { correct: true, errors: [], feedback: '' };
    }

    // Match ignoring accents - FORGIVE by default but show difference
    if (this.stripAccents(userNorm) === this.stripAccents(expNorm)) {
      return {
        correct: true,  // Forgive accent errors
        accentWarning: true,  // Flag for UI to show accent feedback
        errors: [{ type: 'accent', feedback: 'Watch the accents' }],
        feedback: `Accents: ${expected}`
      };
    }

    const userWords = this.tokenize(userInput);
    const expWords = this.tokenize(expected);

    // Build word sets for comparison
    const userSet = new Set(userWords);
    const expSet = new Set(expWords);

    // Find missing and extra words
    const missing = expWords.filter(w => !userSet.has(w));
    const extra = userWords.filter(w => !expSet.has(w));

    const errors = [];

    // Check for spelling errors (extra word is close to a missing word)
    const spellingPairs = [];
    for (const extraWord of [...extra]) {
      for (const missWord of [...missing]) {
        const dist = this.levenshtein(extraWord, missWord);
        if (dist <= 2 && dist > 0) {
          spellingPairs.push({ got: extraWord, expected: missWord, dist });
          // Remove from missing/extra since we identified it
          extra.splice(extra.indexOf(extraWord), 1);
          missing.splice(missing.indexOf(missWord), 1);
          break;
        }
      }
    }

    // Add spelling errors
    for (const pair of spellingPairs) {
      if (this.stripAccents(pair.got) === this.stripAccents(pair.expected)) {
        errors.push({
          type: 'accent',
          got: pair.got,
          expected: pair.expected,
          feedback: `Accent: "${pair.got}" → "${pair.expected}"`
        });
      } else {
        errors.push({
          type: 'spelling',
          got: pair.got,
          expected: pair.expected,
          feedback: `Spelling: "${pair.got}" → "${pair.expected}"`
        });
      }
    }

    // Add missing words (limit to first 3 to avoid noise)
    if (missing.length > 0) {
      const missingList = missing.slice(0, 3).map(w => `"${w}"`).join(', ');
      const moreCount = missing.length > 3 ? ` (+${missing.length - 3} more)` : '';
      errors.push({
        type: 'missing',
        words: missing,
        feedback: `Missing: ${missingList}${moreCount}`
      });
    }

    // Add extra words (limit to first 3)
    if (extra.length > 0) {
      const extraList = extra.slice(0, 3).map(w => `"${w}"`).join(', ');
      const moreCount = extra.length > 3 ? ` (+${extra.length - 3} more)` : '';
      errors.push({
        type: 'extra',
        words: extra,
        feedback: `Extra: ${extraList}${moreCount}`
      });
    }

    // Generate feedback
    let feedback = '';
    if (errors.length > 0) {
      feedback = errors.map(e => e.feedback).join('\n');
    }

    return {
      correct: false,
      errors,
      primaryError: errors[0] || { type: 'error' },
      feedback
    };
  }
};

// Export
if (typeof module !== 'undefined') {
  module.exports = FSI_Error;
}
