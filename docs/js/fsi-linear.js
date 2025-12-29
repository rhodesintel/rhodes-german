/**
 * FSI Course 2.1 - Linear Mode
 * Progress through units sequentially: dialogue → vocabulary → grammar → drills
 */

// Storage abstraction - works with chrome.storage OR localStorage
const _hasChrome = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;

function _storageGet(key) {
  return new Promise((resolve) => {
    if (_hasChrome) {
      chrome.storage.local.get([key], (result) => resolve(result[key] || null));
    } else {
      try {
        const val = localStorage.getItem(key);
        resolve(val ? JSON.parse(val) : null);
      } catch (e) {
        resolve(null);
      }
    }
  });
}

function _storageSet(key, value) {
  return new Promise((resolve, reject) => {
    if (_hasChrome) {
      chrome.storage.local.set({ [key]: value }, () => {
        if (chrome.runtime.lastError) {
          console.error('Chrome storage error:', chrome.runtime.lastError.message);
          reject(chrome.runtime.lastError);
        } else {
          resolve();
        }
      });
    } else {
      try {
        localStorage.setItem(key, JSON.stringify(value));
        resolve();
      } catch (e) {
        console.error('LocalStorage error:', e.message);
        // Show user-visible error for storage quota issues
        const indicator = document.getElementById('saveIndicator');
        if (indicator) {
          indicator.innerHTML = '<span style="color:#dc3545;">Storage full</span>';
          indicator.classList.add('show');
          setTimeout(() => indicator.classList.remove('show'), 5000);
        }
        reject(e);
      }
    }
  }).catch(e => {
    // Don't throw - log and continue
    console.warn('Storage set failed:', e.message);
  });
}

// Fisher-Yates shuffle - uniform distribution
function _shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const FSI_Linear = {
  // Storage key - separate from main Storage to avoid structure conflicts
  // FSI_Linear tracks linear progression state, Storage tracks SRS cards
  STORAGE_KEY: 'allonsy_fsi_linear',

  // Section order within each unit
  SECTIONS: [
    'dialogue',
    'vocabulary',
    'grammar',
    'lexical_drills',
    'substitution_drills',
    'transformation_drills',
    'response_drills',
    'review'
  ],

  // State
  state: {
    current_unit: 1,
    current_section: 'dialogue',
    current_item: 0,
    completed: {},  // {unit_section_item: true}
    scores: {},     // {unit: {correct, total}}
    started_at: null,
    last_activity: null
  },

  // Course data reference
  courseData: null,

  // ============================================
  // INITIALIZATION
  // ============================================

  async init(courseData) {
    this.courseData = courseData;
    await this.loadState();
    return this;
  },

  async loadState() {
    const saved = await _storageGet(this.STORAGE_KEY);
    if (saved) {
      this.state = { ...this.state, ...saved };
    }
    if (!this.state.started_at) {
      this.state.started_at = new Date().toISOString();
    }
  },

  async saveState() {
    this.state.last_activity = new Date().toISOString();
    await _storageSet(this.STORAGE_KEY, this.state);
  },

  // ============================================
  // NAVIGATION
  // ============================================

  getCurrentUnit() {
    return this.courseData?.units?.[this.state.current_unit - 1] || null;
  },

  getCurrentSection() {
    return this.state.current_section;
  },

  getCurrentSectionData() {
    const unit = this.getCurrentUnit();
    if (!unit) return null;

    const section = this.state.current_section;

    switch (section) {
      case 'dialogue':
        return unit.dialogues?.original || [];
      case 'vocabulary':
        return unit.vocabulary || [];
      case 'grammar':
        return unit.grammar_points || [];
      case 'lexical_drills':
        return unit.drills?.lexical || [];
      case 'substitution_drills':
        return unit.drills?.substitution || [];
      case 'transformation_drills':
        return unit.drills?.transformation || [];
      case 'response_drills':
        return unit.drills?.response || [];
      case 'review':
        return this.buildReviewItems(unit);
      default:
        return [];
    }
  },

  getCurrentItem() {
    const data = this.getCurrentSectionData();
    return data?.[this.state.current_item] || null;
  },

  getItemKey(unit, section, item) {
    return `${unit}_${section}_${item}`;
  },

  isCompleted(unit, section, item) {
    return !!this.state.completed[this.getItemKey(unit, section, item)];
  },

  // ============================================
  // PROGRESSION
  // ============================================

  markComplete(correct = true) {
    const key = this.getItemKey(
      this.state.current_unit,
      this.state.current_section,
      this.state.current_item
    );

    this.state.completed[key] = true;

    // Update scores
    const unitKey = `unit${this.state.current_unit}`;
    if (!this.state.scores[unitKey]) {
      this.state.scores[unitKey] = { correct: 0, total: 0 };
    }
    this.state.scores[unitKey].total++;
    if (correct) {
      this.state.scores[unitKey].correct++;
    }

    this.saveState();
  },

  nextItem() {
    const sectionData = this.getCurrentSectionData();

    // More items in current section?
    if (this.state.current_item < sectionData.length - 1) {
      this.state.current_item++;
      this.saveState();
      return { type: 'item', item: this.getCurrentItem() };
    }

    // Move to next section
    return this.nextSection();
  },

  nextSection() {
    const sectionIdx = this.SECTIONS.indexOf(this.state.current_section);

    // More sections in current unit?
    if (sectionIdx < this.SECTIONS.length - 1) {
      this.state.current_section = this.SECTIONS[sectionIdx + 1];
      this.state.current_item = 0;
      this.saveState();
      return { type: 'section', section: this.state.current_section };
    }

    // Move to next unit
    return this.nextUnit();
  },

  nextUnit() {
    const totalUnits = this.courseData?.units?.length || 24;

    if (this.state.current_unit < totalUnits) {
      this.state.current_unit++;
      this.state.current_section = this.SECTIONS[0];
      this.state.current_item = 0;
      this.saveState();
      return { type: 'unit', unit: this.state.current_unit };
    }

    // Course complete!
    return { type: 'complete' };
  },

  // Jump to specific location
  goTo(unit, section = 'dialogue', item = 0) {
    this.state.current_unit = unit;
    this.state.current_section = section;
    this.state.current_item = item;
    this.saveState();
  },

  // ============================================
  // REVIEW ITEMS (mixed from unit)
  // ============================================

  buildReviewItems(unit) {
    const items = [];

    // Sample unique dialogues using Fisher-Yates shuffle
    const dialogues = unit.dialogues?.original || [];
    const shuffledDialogues = _shuffle(dialogues);
    for (let i = 0; i < Math.min(3, shuffledDialogues.length); i++) {
      items.push({
        type: 'dialogue',
        ...shuffledDialogues[i]
      });
    }

    // Sample one from each drill type (shuffled for randomness)
    for (const drillType of ['lexical', 'substitution', 'transformation']) {
      const drills = unit.drills?.[drillType] || [];
      if (drills.length > 0) {
        const shuffled = _shuffle(drills);
        items.push({
          type: drillType,
          ...shuffled[0]
        });
      }
    }

    return items;
  },

  // ============================================
  // PROGRESS TRACKING
  // ============================================

  getUnitProgress(unitNum) {
    let completed = 0;
    let total = 0;

    for (const section of this.SECTIONS) {
      // Count items in this section
      const unit = this.courseData?.units?.[unitNum - 1];
      if (!unit) continue;

      let sectionData;
      switch (section) {
        case 'dialogue': sectionData = unit.dialogues?.original || []; break;
        case 'vocabulary': sectionData = unit.vocabulary || []; break;
        case 'grammar': sectionData = unit.grammar_points || []; break;
        case 'lexical_drills': sectionData = unit.drills?.lexical || []; break;
        case 'substitution_drills': sectionData = unit.drills?.substitution || []; break;
        case 'transformation_drills': sectionData = unit.drills?.transformation || []; break;
        case 'response_drills': sectionData = unit.drills?.response || []; break;
        case 'review': sectionData = [1, 2, 3, 4, 5]; break;  // Fixed 5 review items
        default: sectionData = [];
      }

      for (let i = 0; i < sectionData.length; i++) {
        total++;
        if (this.isCompleted(unitNum, section, i)) {
          completed++;
        }
      }
    }

    return {
      completed,
      total,
      percentage: total > 0 ? Math.round((completed / total) * 100) : 0
    };
  },

  getOverallProgress() {
    const totalUnits = this.courseData?.units?.length || 24;
    let totalCompleted = 0;
    let totalItems = 0;

    for (let i = 1; i <= totalUnits; i++) {
      const progress = this.getUnitProgress(i);
      totalCompleted += progress.completed;
      totalItems += progress.total;
    }

    return {
      completed: totalCompleted,
      total: totalItems,
      percentage: totalItems > 0 ? Math.round((totalCompleted / totalItems) * 100) : 0,
      units_completed: Object.keys(this.state.scores).filter(k =>
        this.getUnitProgress(parseInt(k.replace('unit', ''))).percentage === 100
      ).length
    };
  },

  getScores() {
    return this.state.scores;
  },

  // ============================================
  // MODE SWITCHING
  // ============================================

  // Get sentences suitable for SRS mode (completed in linear)
  getCompletedSentences() {
    const sentences = [];

    for (const [key, completed] of Object.entries(this.state.completed)) {
      if (!completed) continue;

      const [unit, section, item] = key.split('_');
      const unitNum = parseInt(unit);
      const itemNum = parseInt(item);

      const unitData = this.courseData?.units?.[unitNum - 1];
      if (!unitData) continue;

      let sectionData;
      switch (section) {
        case 'dialogue': sectionData = unitData.dialogues?.original || []; break;
        case 'lexical_drills': sectionData = unitData.drills?.lexical || []; break;
        case 'substitution_drills': sectionData = unitData.drills?.substitution || []; break;
        default: continue;  // Skip non-sentence sections
      }

      const itemData = sectionData[itemNum];
      if (itemData?.french) {
        sentences.push({
          id: key,
          french: itemData.french,
          english: itemData.english,
          unit: unitNum,
          section: section,
          pos_pattern: itemData.pos_pattern || '',
          commonality: itemData.commonality || 0.5
        });
      }
    }

    return sentences;
  },

  // ============================================
  // RESET
  // ============================================

  resetUnit(unitNum) {
    const prefix = `${unitNum}_`;
    for (const key of Object.keys(this.state.completed)) {
      if (key.startsWith(prefix)) {
        delete this.state.completed[key];
      }
    }
    delete this.state.scores[`unit${unitNum}`];
    this.saveState();
  },

  resetAll() {
    this.state = {
      current_unit: 1,
      current_section: 'dialogue',
      current_item: 0,
      completed: {},
      scores: {},
      started_at: new Date().toISOString(),
      last_activity: null
    };
    this.saveState();
  }
};

// Export
if (typeof module !== 'undefined') {
  module.exports = FSI_Linear;
}
