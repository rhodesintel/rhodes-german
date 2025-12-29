/**
 * Rhodes German - FSI-Style German Course
 * Main Application Logic
 *
 * Features:
 * - 1,589 drills across 30 units
 * - FSRS spaced repetition
 * - Dual register (Sie/du)
 * - Case color coding
 * - TTS ready (ElevenLabs integration)
 */

// ===========================================
// CONFIGURATION
// ===========================================

const CONFIG = {
  // CDN/Data URLs (for future hosting)
  baseUrl: '',  // Set to GitHub Pages URL when deployed
  version: '1.0.0',

  // TTS Configuration (ElevenLabs ready)
  tts: {
    enabled: false,
    provider: 'elevenlabs',
    voiceId: null,  // Set ElevenLabs voice ID
    apiKey: null,   // Set via environment or user settings
    audioCache: {},
  },

  // German-specific
  caseColors: {
    nominative: '#0066CC',
    accusative: '#CC0000',
    dative: '#009900',
    genitive: '#CC9900'
  }
};

// ===========================================
// AUDIO FEEDBACK
// ===========================================

const AudioFeedback = {
  ctx: null,

  init() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    return this.ctx;
  },

  correct() {
    try {
      const ctx = this.init();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(440, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.15);
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.2);
    } catch (e) {}
  },

  incorrect() {
    try {
      const ctx = this.init();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(330, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(220, ctx.currentTime + 0.2);
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.25);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.25);
    } catch (e) {}
  }
};

// ===========================================
// TTS SYSTEM (ElevenLabs Ready)
// ===========================================

const TTS = {
  // Generate audio for German text using ElevenLabs
  async speak(text, options = {}) {
    if (!CONFIG.tts.enabled || !CONFIG.tts.apiKey) {
      console.log('TTS not configured, skipping:', text);
      return null;
    }

    // Check cache first
    const cacheKey = text.toLowerCase().trim();
    if (CONFIG.tts.audioCache[cacheKey]) {
      return this.playAudio(CONFIG.tts.audioCache[cacheKey]);
    }

    try {
      const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${CONFIG.tts.voiceId}`, {
        method: 'POST',
        headers: {
          'Accept': 'audio/mpeg',
          'Content-Type': 'application/json',
          'xi-api-key': CONFIG.tts.apiKey
        },
        body: JSON.stringify({
          text: text,
          model_id: 'eleven_multilingual_v2',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75
          }
        })
      });

      if (response.ok) {
        const audioBlob = await response.blob();
        const audioUrl = URL.createObjectURL(audioBlob);
        CONFIG.tts.audioCache[cacheKey] = audioUrl;
        return this.playAudio(audioUrl);
      }
    } catch (e) {
      console.error('TTS error:', e);
    }
    return null;
  },

  playAudio(url) {
    return new Promise((resolve) => {
      const audio = new Audio(url);
      audio.onended = resolve;
      audio.onerror = resolve;
      audio.play().catch(resolve);
    });
  },

  // Configure TTS
  configure(apiKey, voiceId) {
    CONFIG.tts.apiKey = apiKey;
    CONFIG.tts.voiceId = voiceId;
    CONFIG.tts.enabled = true;
    localStorage.setItem('rhodes_german_tts', JSON.stringify({ apiKey, voiceId }));
  },

  // Load saved TTS config
  loadConfig() {
    try {
      const saved = localStorage.getItem('rhodes_german_tts');
      if (saved) {
        const { apiKey, voiceId } = JSON.parse(saved);
        this.configure(apiKey, voiceId);
      }
    } catch (e) {}
  }
};

// ===========================================
// STATE
// ===========================================

let drillsData = null;
let currentMode = 'srs';  // 'srs' or 'linear'
let currentUnit = null;
let currentDrillIndex = 0;
let currentDrills = [];
let register = 'formal';  // 'formal' (Sie) or 'informal' (du)
let sessionCorrect = 0;
let sessionTotal = 0;

// Unit titles (German)
const UNIT_TITLES = {
  1: 'Erste Begegnung', 2: 'Im Café', 3: 'Familie und Freunde', 4: 'Berufe und Arbeit',
  5: 'Wiederholung 1', 6: 'Tagesablauf', 7: 'Einkaufen', 8: 'Wohnen',
  9: 'Unterwegs', 10: 'Wiederholung 2', 11: 'Im Restaurant', 12: 'Gesundheit',
  13: 'Freizeit', 14: 'Beschreibungen', 15: 'Wiederholung 3', 16: 'Reisen',
  17: 'Am Flughafen', 18: 'Probleme lösen', 19: 'Telefon und E-Mail',
  20: 'Wiederholung 4', 21: 'Meinungen', 22: 'Nachrichten', 23: 'Zukunft',
  24: 'Vergangenheit', 25: 'Wiederholung 5', 26: 'Indirekte Rede',
  27: 'Kultur und Geschichte', 28: 'Literatur', 29: 'Humor und Redewendungen',
  30: 'Abschluss'
};

// ===========================================
// INITIALIZATION
// ===========================================

document.addEventListener('DOMContentLoaded', async () => {
  TTS.loadConfig();
  await loadDrills();
  await FSI_SRS.init();
  updateStatsDisplay();

  // Enter key submits
  document.getElementById('answer-input').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') checkAnswer();
  });
});

async function loadDrills() {
  showScreen('loading');
  try {
    const response = await fetch('data/drills.json');
    drillsData = await response.json();
    console.log(`Loaded ${drillsData.total_drills} drills`);

    // Initialize SRS cards for all drills
    FSI_SRS.initializeCards(drillsData.drills.map(d => ({
      id: d.id,
      unit: d.unit,
      commonality: 0.5
    })));
    FSI_SRS.loadDrillMeta(drillsData);

    showScreen('landing');
  } catch (e) {
    console.error('Failed to load drills:', e);
    alert('Fehler beim Laden der Drills. Bitte neu laden.');
  }
}

// ===========================================
// SCREEN NAVIGATION
// ===========================================

function showScreen(screenId) {
  ['landing', 'unit-select', 'drill-screen', 'stats-screen', 'loading'].forEach(id => {
    document.getElementById(id).style.display = 'none';
  });
  document.getElementById(screenId).style.display = 'block';
}

function showLanding() {
  showScreen('landing');
  updateStatsDisplay();
}

function showUnitSelect() {
  showScreen('unit-select');
  renderUnitGrid();
}

function showStats() {
  showScreen('stats-screen');
  renderStats();
}

function exitDrill() {
  if (confirm('Sitzung beenden?')) {
    showLanding();
  }
}

// ===========================================
// UNIT SELECTION
// ===========================================

function renderUnitGrid() {
  const grid = document.getElementById('unit-grid');
  grid.innerHTML = '';

  for (let i = 1; i <= 30; i++) {
    const unitDrills = drillsData.drills.filter(d => d.unit === i);
    const card = document.createElement('div');
    card.className = 'unit-card';
    card.innerHTML = `
      <div class="unit-number">${i}</div>
      <div class="unit-title">${UNIT_TITLES[i] || `Einheit ${i}`}</div>
      <div style="font-size:0.7em;opacity:0.6;">${unitDrills.length} Drills</div>
    `;
    card.onclick = () => startLinear(i);
    grid.appendChild(card);
  }
}

// ===========================================
// SRS MODE
// ===========================================

function startSRS() {
  currentMode = 'srs';
  FSI_SRS.buildSessionQueue(20);

  if (FSI_SRS.sessionQueue.length === 0) {
    alert('Keine Karten fällig! Kommen Sie später zurück.');
    return;
  }

  showScreen('drill-screen');
  document.getElementById('drill-unit-title').textContent = 'SRS-Modus';
  sessionCorrect = 0;
  sessionTotal = 0;
  loadNextDrill();
}

// ===========================================
// LINEAR MODE
// ===========================================

function startLinear(unit) {
  currentMode = 'linear';
  currentUnit = unit;
  currentDrillIndex = 0;
  currentDrills = drillsData.drills.filter(d => d.unit === unit);

  if (currentDrills.length === 0) {
    alert('Keine Drills für diese Einheit gefunden.');
    return;
  }

  showScreen('drill-screen');
  document.getElementById('drill-unit-title').textContent = `Einheit ${unit}: ${UNIT_TITLES[unit] || ''}`;
  sessionCorrect = 0;
  sessionTotal = 0;
  loadNextDrill();
}

// ===========================================
// DRILL LOGIC
// ===========================================

let currentDrill = null;

function loadNextDrill() {
  // Get next drill based on mode
  if (currentMode === 'srs') {
    const card = FSI_SRS.getNextCard();
    if (!card) {
      alert('Sitzung abgeschlossen! Gut gemacht!');
      showLanding();
      return;
    }
    currentDrill = drillsData.drills.find(d => d.id === card.id);
  } else {
    if (currentDrillIndex >= currentDrills.length) {
      alert(`Einheit ${currentUnit} abgeschlossen! 🎉`);
      showLanding();
      return;
    }
    currentDrill = currentDrills[currentDrillIndex];
  }

  if (!currentDrill) {
    console.error('No drill found');
    return;
  }

  // Update UI
  const total = currentMode === 'srs' ? 20 : currentDrills.length;
  const current = currentMode === 'srs' ? sessionTotal + 1 : currentDrillIndex + 1;
  document.getElementById('drill-counter').textContent = `${current}/${total}`;
  document.getElementById('progress-fill').style.width = `${(current / total) * 100}%`;

  // Set drill type
  const typeMap = {
    'substitution': 'Ersetzung',
    'transformation': 'Umwandlung',
    'translation': 'Übersetzung',
    'response': 'Antwort',
    'conjugation': 'Konjugation',
    'phrase': 'Ausdruck',
    'dialogue': 'Dialog',
    'vocabulary': 'Vokabeln'
  };
  document.getElementById('drill-type').textContent = typeMap[currentDrill.type] || 'Übung';

  // Set prompt (English)
  document.getElementById('prompt-english').textContent = currentDrill.english || 'Translate to German:';

  // Clear input and feedback
  const input = document.getElementById('answer-input');
  input.value = '';
  input.className = '';
  input.focus();

  document.getElementById('feedback').className = 'feedback';
  document.getElementById('submit-btn').textContent = 'Prüfen';

  // Start SRS timer
  FSI_SRS.startPromptTimer();
}

function checkAnswer() {
  const input = document.getElementById('answer-input');
  const userAnswer = input.value.trim();

  if (!userAnswer) return;

  // Get expected answer based on register
  const expected = register === 'formal'
    ? currentDrill.german_formal
    : currentDrill.german_informal;

  // Normalize for comparison
  const normalize = (s) => s.toLowerCase()
    .replace(/[.,!?;:]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const isCorrect = normalize(userAnswer) === normalize(expected);

  // Show feedback
  const feedback = document.getElementById('feedback');
  const feedbackText = document.getElementById('feedback-text');
  const expectedAnswer = document.getElementById('expected-answer');

  if (isCorrect) {
    AudioFeedback.correct();
    input.className = 'correct';
    feedback.className = 'feedback show correct';
    feedbackText.textContent = '✓ Richtig!';
    expectedAnswer.textContent = '';
    sessionCorrect++;

    // TTS: speak the correct German
    TTS.speak(expected);

    // SRS: process as correct
    if (currentMode === 'srs') {
      FSI_SRS.processReview(currentDrill.id, FSI_SRS.Rating.Good);
    }
  } else {
    AudioFeedback.incorrect();
    input.className = 'incorrect';
    feedback.className = 'feedback show incorrect';
    feedbackText.textContent = '✗ Nicht ganz richtig';
    expectedAnswer.textContent = `Erwartet: ${expected}`;

    // SRS: process as incorrect
    if (currentMode === 'srs') {
      FSI_SRS.processReview(currentDrill.id, FSI_SRS.Rating.Again);
    }
  }

  sessionTotal++;

  // Change button to continue
  document.getElementById('submit-btn').textContent = 'Weiter →';
  document.getElementById('submit-btn').onclick = () => {
    document.getElementById('submit-btn').onclick = checkAnswer;
    if (currentMode === 'linear') currentDrillIndex++;
    loadNextDrill();
  };

  updateStatsDisplay();
}

// ===========================================
// REGISTER TOGGLE
// ===========================================

function setRegister(reg) {
  register = reg;
  document.getElementById('btn-formal').className = reg === 'formal' ? 'register-btn active' : 'register-btn';
  document.getElementById('btn-informal').className = reg === 'informal' ? 'register-btn active' : 'register-btn';
}

// ===========================================
// STATISTICS
// ===========================================

function updateStatsDisplay() {
  const stats = FSI_SRS.getStats();
  document.getElementById('streak-display').textContent = `🔥 ${stats.session.correct}`;
  document.getElementById('due-display').textContent = `📚 ${stats.due_today} fällig`;
}

function renderStats() {
  const stats = FSI_SRS.getStats();

  document.getElementById('stats-total').textContent = stats.total;
  document.getElementById('stats-mastered').textContent = stats.mastered;
  document.getElementById('stats-due').textContent = stats.due_today;

  const accuracy = stats.session.reviewed > 0
    ? Math.round((stats.session.correct / stats.session.reviewed) * 100)
    : 0;
  document.getElementById('stats-accuracy').textContent = `${accuracy}%`;

  document.getElementById('session-reviewed').textContent = stats.session.reviewed;
  document.getElementById('session-correct').textContent = stats.session.correct;
}

function resetProgress() {
  if (confirm('Fortschritt wirklich zurücksetzen? Dies kann nicht rückgängig gemacht werden.')) {
    FSI_SRS.resetAllCards();
    FSI_SRS.resetSessionStats();
    FSI_SRS.clearAnalytics();
    alert('Fortschritt zurückgesetzt.');
    showLanding();
  }
}

// ===========================================
// GERMAN GRAMMAR HELPERS (for error detection)
// ===========================================

const GermanGrammar = {
  // Article patterns for case detection
  articles: {
    der: { case: 'nominative', gender: 'masculine' },
    die: { case: 'nominative/accusative', gender: 'feminine/plural' },
    das: { case: 'nominative/accusative', gender: 'neuter' },
    den: { case: 'accusative', gender: 'masculine' },
    dem: { case: 'dative', gender: 'masculine/neuter' },
    des: { case: 'genitive', gender: 'masculine/neuter' },
    einer: { case: 'genitive/dative', gender: 'feminine' },
    einem: { case: 'dative', gender: 'masculine/neuter' },
    einen: { case: 'accusative', gender: 'masculine' }
  },

  // Common verb conjugation patterns
  verbEndings: {
    present: {
      ich: 'e', du: 'st', 'er/sie/es': 't',
      wir: 'en', ihr: 't', 'sie/Sie': 'en'
    }
  },

  // Detect case from sentence context
  detectCase(sentence) {
    const lower = sentence.toLowerCase();
    for (const [article, info] of Object.entries(this.articles)) {
      if (lower.includes(article + ' ')) {
        return info.case;
      }
    }
    return null;
  }
};

// ===========================================
// UTILITY
// ===========================================

// Escape HTML
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Export for debugging
window.RhodesGerman = {
  CONFIG,
  FSI_SRS,
  TTS,
  drillsData: () => drillsData,
  currentDrill: () => currentDrill
};

console.log('Rhodes German v1.0.0 loaded - Auf geht\'s!');
