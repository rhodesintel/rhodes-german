/**
 * FSI Course 2.0 - SRS Mode with FSRS + NLP-aware spacing
 *
 * Features:
 * - FSRS algorithm for optimal review scheduling
 * - POS pattern grouping to avoid similar structure back-to-back
 * - Commonality-ranked initial ordering
 * - Error-weighted difficulty adjustment
 */

const FSI_SRS = {
  // FSRS Parameters (default, learned from user history)
  params: {
    w: [0.4, 0.6, 2.4, 5.8, 4.93, 0.94, 0.86, 0.01,
        1.49, 0.14, 0.94, 2.18, 0.05, 0.34, 1.26, 0.29, 2.61],
    requestRetention: 0.9,
    maximumInterval: 36500,  // 100 years
    // Anki-style learning steps (in minutes) for Again/failed cards
    learningSteps: [1, 10],  // 1 min, 10 min, then graduate
    relearningSteps: [1, 10],  // Same for lapsed cards
    graduatingInterval: 1,  // Days after completing learning steps
    easyInterval: 4,  // Days for Easy on new card

    // Drill graduation params (pattern variations retire from SRS)
    graduationConsecutive: 5,  // Correct answers in a row to graduate
    graduationMinInterval: 16,  // Minimum interval (days) before graduation
    reactivationLapseThreshold: 2  // Lapses on canonical to trigger sibling reactivation
  },

  // Drill metadata cache (loaded from drills.json)
  drillMeta: {},  // {id: {pattern_group, is_canonical}}

  // Rating enum
  Rating: {
    Again: 1,
    Hard: 2,
    Good: 3,
    Easy: 4
  },

  // Card state enum
  State: {
    New: 0,
    Learning: 1,
    Review: 2,
    Relearning: 3
  },

  // Storage keys
  STORAGE_KEY: 'allonsy_fsi_srs',
  ANALYTICS_KEY: 'allonsy_fsi_analytics',

  // Chrome storage availability check
  _hasChrome: typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local,

  // In-memory state
  cards: {},
  sessionQueue: [],

  // Analytics: tracks every response for pattern analysis
  analytics: {
    userId: null,
    responses: [],  // All logged responses
    promptStartTime: null  // Track when current prompt was shown
  },
  lastPattern: null,
  sessionStats: { reviewed: 0, correct: 0, incorrect: 0 },

  // ============================================
  // INITIALIZATION
  // ============================================

  async init() {
    await this.loadCards();
    this.buildSessionQueue();
    return this;
  },

  async loadCards() {
    return new Promise((resolve) => {
      if (this._hasChrome) {
        chrome.storage.local.get([this.STORAGE_KEY], (result) => {
          this.cards = result[this.STORAGE_KEY] || {};
          resolve();
        });
      } else {
        // Fallback to localStorage
        try {
          const saved = localStorage.getItem(this.STORAGE_KEY);
          this.cards = saved ? JSON.parse(saved) : {};
        } catch (e) {
          this.cards = {};
        }
        resolve();
      }
    });
  },

  async saveCards() {
    return new Promise((resolve, reject) => {
      if (this._hasChrome) {
        chrome.storage.local.set({ [this.STORAGE_KEY]: this.cards }, () => {
          if (chrome.runtime.lastError) {
            console.error('Chrome storage error:', chrome.runtime.lastError.message);
            this._showStorageError('Failed to save progress (Chrome storage)');
            reject(chrome.runtime.lastError);
          } else {
            resolve();
          }
        });
      } else {
        // Fallback to localStorage
        try {
          const data = JSON.stringify(this.cards);
          localStorage.setItem(this.STORAGE_KEY, data);
          resolve();
        } catch (e) {
          console.error('LocalStorage error:', e.message);
          this._showStorageError('Storage full - progress may be lost');
          reject(e);
        }
      }
    }).catch(e => {
      // Don't throw - log and continue so app doesn't break
      console.warn('Storage save failed, continuing:', e.message);
    });
  },

  // Show storage error to user (non-blocking)
  _showStorageError(msg) {
    const indicator = document.getElementById('saveIndicator');
    if (indicator) {
      indicator.innerHTML = '<span style="color:#dc3545;">Storage Error</span>';
      indicator.classList.add('show');
      setTimeout(() => indicator.classList.remove('show'), 5000);
    }
    // Also show a more prominent warning for critical failures
    console.error('STORAGE ERROR:', msg);
  },

  // ============================================
  // CARD CREATION
  // ============================================

  createCard(id, sentenceData) {
    return {
      id: id,
      due: new Date().toISOString(),
      stability: 0,
      difficulty: 0,
      elapsed_days: 0,
      scheduled_days: 0,
      reps: 0,
      lapses: 0,
      state: this.State.New,
      last_review: null,
      learning_step: 0,  // Current step in learningSteps array

      // NLP metadata for smart spacing
      pos_pattern: sentenceData.pos_pattern || '',
      commonality: sentenceData.commonality || 0.5,
      unit: sentenceData.unit || 1,

      // Error tracking
      error_history: [],  // [{type, timestamp}]

      // Graduation fields (drill variations retire from SRS)
      graduated: false,
      graduation_date: null,
      consecutive_correct: 0
    };
  },

  // Initialize cards for a set of sentences
  initializeCards(sentences) {
    // Sort by commonality (most common first for initial learning)
    const sorted = [...sentences].sort((a, b) => b.commonality - a.commonality);

    for (const sentence of sorted) {
      if (!this.cards[sentence.id]) {
        this.cards[sentence.id] = this.createCard(sentence.id, sentence);
      }
    }

    this.saveCards();
  },

  // ============================================
  // FSRS CORE FUNCTIONS
  // ============================================

  // Forgetting curve: R(t, S) = (1 + t/(9*S))^(-1)
  retrievability(elapsedDays, stability) {
    if (stability <= 0) return 0;
    return Math.pow(1 + elapsedDays / (9 * stability), -1);
  },

  // Next interval: I(r, S) = 9 * S * (1/r - 1)
  nextInterval(stability, retention = this.params.requestRetention) {
    if (stability <= 0) return 1;
    return Math.round(9 * stability * (1 / retention - 1));
  },

  // Initial stability based on grade
  initStability(grade) {
    return this.params.w[grade - 1];
  },

  // Initial difficulty based on grade
  initDifficulty(grade) {
    const w = this.params.w;
    return Math.max(1, Math.min(10, w[4] - (grade - 3) * w[5]));
  },

  // Stability after successful review
  nextReviewStability(d, s, r, grade) {
    const w = this.params.w;
    const hardPenalty = grade === this.Rating.Hard ? w[15] : 1;
    const easyBonus = grade === this.Rating.Easy ? w[16] : 1;

    const sinc = Math.exp(w[8]) *
                 (11 - d) *
                 Math.pow(s, -w[9]) *
                 (Math.exp(w[10] * (1 - r)) - 1) *
                 hardPenalty *
                 easyBonus;

    return s * (sinc + 1);
  },

  // Stability after forgetting (lapse)
  nextForgetStability(d, s, r) {
    const w = this.params.w;
    return w[11] *
           Math.pow(d, -w[12]) *
           (Math.pow(s + 1, w[13]) - 1) *
           Math.exp(w[14] * (1 - r));
  },

  // Update difficulty
  nextDifficulty(d, grade) {
    const w = this.params.w;
    const d0 = this.initDifficulty(3);  // Default difficulty
    const newD = w[7] * d0 + (1 - w[7]) * (d - w[6] * (grade - 3));
    return Math.max(1, Math.min(10, newD));
  },

  // ============================================
  // REVIEW PROCESSING
  // ============================================

  processReview(cardId, grade, errorInfo = null) {
    const card = this.cards[cardId];
    if (!card) return null;

    const now = new Date();
    const lastReview = card.last_review ? new Date(card.last_review) : now;
    const elapsedDays = (now - lastReview) / (1000 * 60 * 60 * 24);

    // Track error if present
    if (errorInfo) {
      card.error_history.push({
        type: errorInfo.type,
        timestamp: now.toISOString()
      });
      // Keep last 10 errors only
      if (card.error_history.length > 10) {
        card.error_history.shift();
      }
    }

    let intervalMinutes = 0;
    let intervalDays = 0;

    // Handle Learning/Relearning states (Anki-style short intervals)
    if (card.state === this.State.New || card.state === this.State.Learning || card.state === this.State.Relearning) {
      const steps = card.state === this.State.Relearning ? this.params.relearningSteps : this.params.learningSteps;

      if (grade === this.Rating.Again) {
        // Reset to first step
        card.learning_step = 0;
        card.state = card.state === this.State.New ? this.State.Learning : this.State.Relearning;
        intervalMinutes = steps[0];
      } else if (grade === this.Rating.Easy) {
        // Graduate immediately with easy interval
        card.state = this.State.Review;
        card.learning_step = 0;
        card.stability = this.initStability(grade);
        card.difficulty = this.initDifficulty(grade);
        intervalDays = this.params.easyInterval;
      } else {
        // Good or Hard: advance to next step
        card.learning_step = (card.learning_step || 0) + 1;

        if (card.learning_step >= steps.length) {
          // Graduate to review
          card.state = this.State.Review;
          card.learning_step = 0;
          card.stability = this.initStability(grade);
          card.difficulty = this.initDifficulty(grade);
          intervalDays = grade === this.Rating.Hard ? 1 : this.params.graduatingInterval;
        } else {
          // Next learning step
          card.state = card.state === this.State.New ? this.State.Learning : card.state;
          intervalMinutes = steps[card.learning_step];
        }
      }
    }
    // Handle Review state (FSRS algorithm)
    else {
      const r = this.retrievability(elapsedDays, card.stability);

      if (grade === this.Rating.Again) {
        // Lapse - go to relearning with short steps
        card.stability = this.nextForgetStability(card.difficulty, card.stability, r);
        card.lapses++;
        card.state = this.State.Relearning;
        card.learning_step = 0;
        intervalMinutes = this.params.relearningSteps[0];
      } else {
        // Success - use FSRS
        card.stability = this.nextReviewStability(card.difficulty, card.stability, r, grade);
        card.difficulty = this.nextDifficulty(card.difficulty, grade);
        intervalDays = Math.min(this.nextInterval(card.stability), this.params.maximumInterval);
      }
    }

    // Set next due date
    const dueDate = new Date(now);
    if (intervalMinutes > 0) {
      dueDate.setMinutes(dueDate.getMinutes() + intervalMinutes);
      card.scheduled_days = intervalMinutes / (60 * 24);  // Convert to days for display
    } else {
      dueDate.setDate(dueDate.getDate() + intervalDays);
      card.scheduled_days = intervalDays;
    }

    card.elapsed_days = elapsedDays;
    card.reps++;
    card.last_review = now.toISOString();
    card.due = dueDate.toISOString();

    // Update last pattern for spacing
    this.lastPattern = card.pos_pattern;

    // Update stats
    this.sessionStats.reviewed++;
    if (grade >= this.Rating.Good) {
      this.sessionStats.correct++;
      // Track consecutive correct for graduation
      card.consecutive_correct = (card.consecutive_correct || 0) + 1;
    } else {
      this.sessionStats.incorrect++;
      // Reset streak on incorrect
      card.consecutive_correct = 0;
    }

    // Check for drill graduation (non-canonical variations retire from SRS)
    this._checkGraduation(card, grade);

    // Check for reactivation (canonical lapse triggers sibling return)
    if (grade === this.Rating.Again) {
      this._checkReactivation(cardId);
    }

    // Save
    this.saveCards();

    const interval = intervalMinutes > 0 ? intervalMinutes / (60 * 24) : intervalDays;
    return {
      card: card,
      interval: interval,
      intervalDisplay: intervalMinutes > 0 ? `${intervalMinutes}m` : `${intervalDays}d`,
      nextDue: card.due
    };
  },

  // ============================================
  // QUEUE MANAGEMENT (NLP-aware)
  // ============================================

  getDueCards() {
    const now = new Date();
    const due = [];

    for (const [id, card] of Object.entries(this.cards)) {
      // Skip graduated cards (pattern variations that have retired)
      if (card.graduated) continue;

      const dueDate = new Date(card.due);
      if (dueDate <= now || card.state === this.State.New) {
        due.push(card);
      }
    }

    return due;
  },

  buildSessionQueue(maxCards = 20) {
    const due = this.getDueCards();

    // Sort by: New cards first (by commonality), then review cards by due date
    due.sort((a, b) => {
      // New cards first
      if (a.state === this.State.New && b.state !== this.State.New) return -1;
      if (b.state === this.State.New && a.state !== this.State.New) return 1;

      // Among new cards, sort by commonality (most common first)
      if (a.state === this.State.New && b.state === this.State.New) {
        return b.commonality - a.commonality;
      }

      // Among review cards, sort by due date (oldest first)
      return new Date(a.due) - new Date(b.due);
    });

    this.sessionQueue = due.slice(0, maxCards);
    return this.sessionQueue;
  },

  getNextCard() {
    if (this.sessionQueue.length === 0) {
      this.buildSessionQueue();
    }

    if (this.sessionQueue.length === 0) {
      return null;  // No cards due
    }

    // NLP-aware selection: avoid same POS pattern twice in a row
    if (this.lastPattern) {
      // Find first card with different pattern
      const idx = this.sessionQueue.findIndex(c => c.pos_pattern !== this.lastPattern);
      if (idx > 0) {
        // Move that card to front
        const [card] = this.sessionQueue.splice(idx, 1);
        this.sessionQueue.unshift(card);
      }
    }

    // Pop first card
    return this.sessionQueue.shift();
  },

  // ============================================
  // ERROR-TO-RATING CONVERSION
  // ============================================

  errorToRating(errors) {
    if (!errors || errors.length === 0) return this.Rating.Good;

    const primary = errors[0];
    const errorCount = errors.length;

    // Multiple errors = Again
    if (errorCount >= 3) return this.Rating.Again;

    // Based on error type
    switch (primary.type) {
      case 'spelling':
        // Minor spelling = Hard, accent error = Good
        return primary.subtype === 'accent' ? this.Rating.Hard : this.Rating.Hard;

      case 'grammar':
        // Grammar errors are more serious
        return this.Rating.Again;

      case 'word_order':
        // Word order = important to fix
        return this.Rating.Again;

      case 'confusable':
        // Confusables are tricky but not total failure
        return this.Rating.Hard;

      default:
        return errorCount > 1 ? this.Rating.Again : this.Rating.Hard;
    }
  },

  // ============================================
  // STATISTICS
  // ============================================

  getStats() {
    const cards = Object.values(this.cards);
    const now = new Date();

    const stats = {
      total: cards.length,
      new: 0,
      learning: 0,
      review: 0,
      relearning: 0,
      due_today: 0,
      mastered: 0,  // stability > 21 days

      avg_stability: 0,
      avg_difficulty: 0,
      total_reviews: 0,
      total_lapses: 0,

      session: this.sessionStats
    };

    let totalStability = 0;
    let totalDifficulty = 0;
    let reviewedCount = 0;

    for (const card of cards) {
      // State counts
      switch (card.state) {
        case this.State.New: stats.new++; break;
        case this.State.Learning: stats.learning++; break;
        case this.State.Review: stats.review++; break;
        case this.State.Relearning: stats.relearning++; break;
      }

      // Due today
      if (new Date(card.due) <= now) {
        stats.due_today++;
      }

      // Mastered (stability > 21 days)
      if (card.stability > 21) {
        stats.mastered++;
      }

      // Averages
      if (card.reps > 0) {
        totalStability += card.stability;
        totalDifficulty += card.difficulty;
        reviewedCount++;
      }

      stats.total_reviews += card.reps;
      stats.total_lapses += card.lapses;
    }

    if (reviewedCount > 0) {
      stats.avg_stability = totalStability / reviewedCount;
      stats.avg_difficulty = totalDifficulty / reviewedCount;
    }

    return stats;
  },

  // ============================================
  // PATTERN ANALYSIS
  // ============================================

  // Group cards by POS pattern for analysis
  getPatternGroups() {
    const groups = {};

    for (const card of Object.values(this.cards)) {
      const pattern = card.pos_pattern || 'unknown';
      if (!groups[pattern]) {
        groups[pattern] = [];
      }
      groups[pattern].push(card);
    }

    return groups;
  },

  // Get cards with most errors
  getProblematicCards(limit = 10) {
    const cards = Object.values(this.cards);

    return cards
      .filter(c => c.error_history.length > 0)
      .sort((a, b) => b.error_history.length - a.error_history.length)
      .slice(0, limit);
  },

  // Get error type distribution
  getErrorDistribution() {
    const dist = {};

    for (const card of Object.values(this.cards)) {
      for (const error of card.error_history) {
        dist[error.type] = (dist[error.type] || 0) + 1;
      }
    }

    return dist;
  },

  // ============================================
  // RESET / DEBUG
  // ============================================

  resetCard(cardId) {
    if (this.cards[cardId]) {
      const oldData = this.cards[cardId];
      this.cards[cardId] = this.createCard(cardId, {
        pos_pattern: oldData.pos_pattern,
        commonality: oldData.commonality,
        unit: oldData.unit
      });
      this.saveCards();
    }
  },

  resetAllCards() {
    for (const cardId of Object.keys(this.cards)) {
      this.resetCard(cardId);
    }
  },

  resetSessionStats() {
    this.sessionStats = { reviewed: 0, correct: 0, incorrect: 0 };
  },

  // ============================================
  // DRILL GRADUATION (pattern variations retire from SRS)
  // ============================================

  // Load drill metadata (pattern_group, is_canonical) from drills data
  loadDrillMeta(drillsData) {
    if (!drillsData?.drills) return;
    for (const drill of drillsData.drills) {
      this.drillMeta[drill.id] = {
        pattern_group: drill.pattern_group || null,
        is_canonical: drill.is_canonical !== false  // Default true if not specified
      };
    }
  },

  // Check if card should graduate (called after correct answer)
  // If canonical meets criteria, swap with a sibling (pattern stays, card rotates)
  _checkGraduation(card, grade) {
    if (grade < this.Rating.Good) return;  // Only on correct answers
    if (card.graduated) return;  // Already graduated

    const meta = this.drillMeta[card.id];
    if (!meta) return;  // No metadata loaded

    const consecutive = card.consecutive_correct || 0;
    const interval = card.scheduled_days || 0;

    // Check graduation conditions
    if (consecutive >= this.params.graduationConsecutive &&
        interval >= this.params.graduationMinInterval) {

      const siblings = this._getSiblingCards(meta.pattern_group);
      const graduatedSiblings = siblings.filter(s => s.graduated && s.id !== card.id);
      const activeSiblings = siblings.filter(s => !s.graduated && s.id !== card.id);

      if (meta.is_canonical) {
        // CANONICAL ROTATION: swap with a graduated sibling
        if (graduatedSiblings.length > 0) {
          // Pick random graduated sibling to become new canonical
          const newCanonical = this._shuffle(graduatedSiblings)[0];

          // Swap: old canonical graduates, sibling becomes canonical
          card.graduated = true;
          card.graduation_date = new Date().toISOString();
          this.drillMeta[card.id].is_canonical = false;

          newCanonical.graduated = false;
          newCanonical.consecutive_correct = 0;
          newCanonical.state = this.State.Review;
          newCanonical.due = new Date().toISOString();
          this.drillMeta[newCanonical.id].is_canonical = true;

          console.log(`Canonical swap: ${card.id} → ${newCanonical.id} in ${meta.pattern_group}`);
        }
        // If no graduated siblings, canonical stays (pattern needs representation)
      } else {
        // Non-canonical: normal graduation if siblings remain
        if (activeSiblings.length > 0) {
          card.graduated = true;
          card.graduation_date = new Date().toISOString();
          console.log(`Graduated: ${card.id} from pattern ${meta.pattern_group}`);
        }
      }
    }
  },

  // Check if canonical lapse should reactivate siblings
  _checkReactivation(cardId) {
    const meta = this.drillMeta[cardId];
    if (!meta?.is_canonical) return;  // Only for canonical cards
    if (!meta.pattern_group) return;

    const card = this.cards[cardId];
    if (!card) return;

    // Count recent lapses (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    let recentLapses = 0;
    for (const err of (card.error_history || [])) {
      if (new Date(err.timestamp) > thirtyDaysAgo) {
        recentLapses++;
      }
    }

    if (recentLapses >= this.params.reactivationLapseThreshold) {
      // Reactivate some graduated siblings
      const graduated = this._getGraduatedSiblings(meta.pattern_group);
      const toReactivate = this._shuffle(graduated).slice(0, 3);

      for (const sibling of toReactivate) {
        sibling.graduated = false;
        sibling.state = this.State.Relearning;
        sibling.consecutive_correct = 0;
        sibling.learning_step = 0;
        sibling.due = new Date().toISOString();
        console.log(`Reactivated: ${sibling.id} due to canonical lapse on ${cardId}`);
      }
    }
  },

  // Get all cards in the same pattern group
  _getSiblingCards(patternGroup) {
    if (!patternGroup) return [];
    const siblings = [];
    for (const [id, card] of Object.entries(this.cards)) {
      const meta = this.drillMeta[id];
      if (meta?.pattern_group === patternGroup) {
        siblings.push(card);
      }
    }
    return siblings;
  },

  // Get graduated siblings in a pattern group
  _getGraduatedSiblings(patternGroup) {
    return this._getSiblingCards(patternGroup).filter(c => c.graduated);
  },

  // Fisher-Yates shuffle
  _shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  },

  // Get graduation statistics
  getGraduationStats() {
    const cards = Object.values(this.cards);
    const graduated = cards.filter(c => c.graduated);
    const patterns = new Set();

    for (const [id, meta] of Object.entries(this.drillMeta)) {
      if (meta.pattern_group) patterns.add(meta.pattern_group);
    }

    return {
      total: cards.length,
      graduated: graduated.length,
      active: cards.length - graduated.length,
      patterns: patterns.size,
      percentGraduated: cards.length ? ((graduated.length / cards.length) * 100).toFixed(1) : 0
    };
  },

  // ============================================
  // ANALYTICS - Response Tracking
  // ============================================

  async loadAnalytics() {
    return new Promise((resolve) => {
      if (this._hasChrome) {
        chrome.storage.local.get([this.ANALYTICS_KEY], (result) => {
          const saved = result[this.ANALYTICS_KEY] || {};
          this.analytics.userId = saved.userId || null;
          this.analytics.responses = saved.responses || [];
          resolve();
        });
      } else {
        try {
          const saved = localStorage.getItem(this.ANALYTICS_KEY);
          if (saved) {
            const parsed = JSON.parse(saved);
            this.analytics.userId = parsed.userId || null;
            this.analytics.responses = parsed.responses || [];
          }
        } catch (e) {}
        resolve();
      }
    });
  },

  async saveAnalytics() {
    const data = {
      userId: this.analytics.userId,
      responses: this.analytics.responses,
      lastUpdated: new Date().toISOString()
    };

    return new Promise((resolve) => {
      if (this._hasChrome) {
        chrome.storage.local.set({ [this.ANALYTICS_KEY]: data }, resolve);
      } else {
        try {
          localStorage.setItem(this.ANALYTICS_KEY, JSON.stringify(data));
        } catch (e) {}
        resolve();
      }
    });
  },

  // Call when showing a new prompt to start timing
  startPromptTimer() {
    this.analytics.promptStartTime = Date.now();
  },

  // Log a response with full details for analysis
  logResponse(data) {
    const now = Date.now();
    const responseTime = this.analytics.promptStartTime
      ? now - this.analytics.promptStartTime
      : null;

    const response = {
      // Timing
      timestamp: new Date().toISOString(),
      responseTimeMs: responseTime,

      // Card info
      cardId: data.cardId,
      unit: data.unit,
      drillType: data.drillType,

      // Prompt & answer
      promptEn: data.promptEn,
      expectedFr: data.expectedFr,
      userAnswer: data.userAnswer,

      // Result
      correct: data.correct,
      grade: data.grade,  // Again/Hard/Good/Easy

      // Error details (if incorrect)
      errors: data.errors || [],  // [{type, detail, position}]

      // Context
      mode: data.mode || 'srs',  // 'srs' or 'linear'
      register: data.register || 'formal',  // 'formal' or 'informal'

      // User state
      userId: this.analytics.userId,
      cardState: data.cardState,  // New/Learning/Review/Relearning
      cardReps: data.cardReps,
      cardLapses: data.cardLapses
    };

    this.analytics.responses.push(response);

    // Keep last 10000 responses to prevent storage overflow
    if (this.analytics.responses.length > 10000) {
      this.analytics.responses = this.analytics.responses.slice(-10000);
    }

    this.saveAnalytics();

    // Auto-sync to cloud if configured
    if (typeof FSI_Auth !== 'undefined' && FSI_Auth.isConfigured()) {
      FSI_Auth.saveResponse(response);
    }

    return response;
  },

  // Set user ID (from auth)
  setUserId(userId) {
    this.analytics.userId = userId;
    this.saveAnalytics();
  },

  // Get analytics summary for patterns
  getAnalyticsSummary() {
    const responses = this.analytics.responses;
    if (responses.length === 0) return null;

    // Error type frequency
    const errorTypes = {};
    // Average response time by correctness
    let correctTimes = [];
    let incorrectTimes = [];
    // Errors by unit
    const errorsByUnit = {};
    // Common mistakes (specific cards)
    const mistakesByCard = {};

    for (const r of responses) {
      // Response times
      if (r.responseTimeMs) {
        if (r.correct) {
          correctTimes.push(r.responseTimeMs);
        } else {
          incorrectTimes.push(r.responseTimeMs);
        }
      }

      // Error types
      for (const err of (r.errors || [])) {
        errorTypes[err.type] = (errorTypes[err.type] || 0) + 1;
      }

      // Errors by unit
      if (!r.correct && r.unit) {
        errorsByUnit[r.unit] = (errorsByUnit[r.unit] || 0) + 1;
      }

      // Mistakes by card
      if (!r.correct && r.cardId) {
        if (!mistakesByCard[r.cardId]) {
          mistakesByCard[r.cardId] = { count: 0, errors: [], lastAnswer: '' };
        }
        mistakesByCard[r.cardId].count++;
        mistakesByCard[r.cardId].errors.push(...(r.errors || []));
        mistakesByCard[r.cardId].lastAnswer = r.userAnswer;
      }
    }

    const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

    return {
      totalResponses: responses.length,
      correctCount: responses.filter(r => r.correct).length,
      incorrectCount: responses.filter(r => !r.correct).length,
      accuracy: responses.length ? (responses.filter(r => r.correct).length / responses.length * 100).toFixed(1) : 0,
      avgCorrectTimeMs: Math.round(avg(correctTimes)),
      avgIncorrectTimeMs: Math.round(avg(incorrectTimes)),
      errorTypes,
      errorsByUnit,
      topMistakes: Object.entries(mistakesByCard)
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 20)
        .map(([id, data]) => ({ cardId: id, ...data }))
    };
  },

  // Export analytics as JSON for external analysis
  exportAnalytics() {
    return {
      userId: this.analytics.userId,
      exportedAt: new Date().toISOString(),
      summary: this.getAnalyticsSummary(),
      responses: this.analytics.responses
    };
  },

  // Clear analytics data
  clearAnalytics() {
    this.analytics.responses = [];
    this.saveAnalytics();
  }
};

// Export
if (typeof module !== 'undefined') {
  module.exports = FSI_SRS;
}
