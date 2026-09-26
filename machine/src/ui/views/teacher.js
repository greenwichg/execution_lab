// For teachers: local classes (dates taught, the starter they get), homework
// and study sets by link, and a way into the class board. No pupil data: a
// class is a name, a level, the dates spec points were taught and the
// whole-class taps from past starters. Everything stays on this device.
import { h, href, shareUrl, copyText, announce, focus } from '../../lib/dom.js';
import { load, save } from '../../lib/store.js';
import { newSeed, mulberry32, mixSeed } from '../../lib/rng.js';
import { encodeSet, decodeSet } from '../../lib/codec.js';
import { LEVELS, TOPIC_NAMES, specById, specsForLevel } from '../../learn/spec.js';
import { newClass, setTaught, buildStarter } from '../../learn/starter.js';
import { dayNumber, dayToDate } from '../../learn/scheduler.js';
import { button, chip, seg, callout, copyBox } from '../parts.js';
import { formatDay } from '../session.js';
import { setNav } from '../nav.js';

// ------------------------------------------------------------------ class storage (shared with starter.js)
export function loadClasses() {
  const list = load('classes', []);
  return Array.isArray(list) ? list.filter((c) => c && typeof c === 'object' && typeof c.id === 'string' && c.id).map(normClass) : [];
}
/** a class from an older build or damaged storage: taps an array, taught a plain object, name a string */
function normClass(c) {
  const taught = c.taught && typeof c.taught === 'object' && !Array.isArray(c.taught) ? c.taught : {};
  return { ...c, name: typeof c.name === 'string' ? c.name : 'My class', taught, taps: Array.isArray(c.taps) ? c.taps.filter((t) => t && typeof t === 'object') : [] };
}
export const saveClasses = (list) => save('classes', list);
export const findClass = (id) => loadClasses().find((c) => c.id === id) || null;
/** replace one class (by id) in storage, keeping the others as they are now */
export function saveClass(cls) {
  const list = loadClasses();
  const at = list.findIndex((c) => c.id === cls.id);
  if (at >= 0) list[at] = cls; else list.push(cls);
  saveClasses(list);
  return cls;
}
const newId = () => `c${newSeed().toString(36)}`;

/** the spec points a class can mark as taught: its level's, plus GCSE for A-level classes */
export function classSpecs(level) {
  const own = specsForLevel(level);
  return level === 'alevel' ? [...specsForLevel('gcse'), ...own] : own.length ? own : specsForLevel('gcse');
}

export const today = () => dayNumber(new Date());
/** the same starter plan all day for a class (preview and projector agree) */
export const starterRng = (cls, day) => mulberry32(mixSeed('starter', cls.id, day));
/**
 * the class as it was when the day began. Taps made during today's starter
 * feed tomorrow's plan; they must not reshuffle today's questions when the
 * teacher reloads the projector or looks at the preview again.
 */
export const startOfDay = (cls, day) => ({ ...cls, taps: (Array.isArray(cls.taps) ? cls.taps : []).filter((t) => t && Number.isInteger(t.day) && t.day < day) });
/** today's five-question plan for a class (preview and projector) */
export const starterPlan = (cls, day) => buildStarter(startOfDay(cls, day), day, starterRng(cls, day));

const SOURCE_TEXT = { missed: 'Missed last time', new: 'New' };
function agoText(days) {
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 61) return `${Math.round(days / 7)} weeks ago`;
  return `${Math.round(days / 30)} months ago`;
}
/** "Missed last time" · "From 3 weeks ago" · "New" */
export function sourceLabel(entry, cls, day) {
  if (entry.source === 'spaced') {
    const taught = cls.taught?.[entry.spec];
    return Number.isInteger(taught) ? `From ${agoText(day - taught)}` : 'Coming back';
  }
  return SOURCE_TEXT[entry.source] || 'New';
}

// ------------------------------------------------------------------ dates
const pad = (n) => String(n).padStart(2, '0');
function dayToInput(day) {
  const d = dayToDate(day);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function inputToDay(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return Number.isFinite(d.getTime()) ? dayNumber(d) : null;
}

// ------------------------------------------------------------------ sets storage
export function loadSets() {
  const list = load('sets', []);
  return Array.isArray(list) ? list.filter((s) => s && typeof s.code === 'string') : [];
}
const MODE_TEXT = { normal: 'Normal', study: 'Study: practice', delayed: 'Study: delayed' };
const levelName = (id) => LEVELS.find((l) => l.id === id)?.name || id;
/** the topics a set can use at a level (only those with a spec point there) */
const topicsFor = (level) => [...new Set(specsForLevel(level).map((s) => s.topic))];
/** a set code from a pasted link or a bare code */
export function codeFromText(text) {
  const t = String(text || '').trim();
  const m = /#\/set\/([0-9A-Za-z-]+)/.exec(t);
  return (m ? m[1] : t).replace(/[^0-9A-Za-z-]/g, '');
}

// ------------------------------------------------------------------ view
export function render(el, ctx) {
  setNav('#/teacher');
  let classes = loadClasses();
  if (!classes.length) {
    classes = [newClass({ id: newId(), name: 'My class', level: 'gcse' })];
    saveClasses(classes);
  }
  let cls = classes.find((c) => c.id === ctx.query.get('class')) || classes[0];

  const classBox = h('section', { class: 'panel stack', 'aria-labelledby': 'tc-classes' });
  const taughtBox = h('section', { class: 'stack', 'aria-labelledby': 'tc-taught' });
  const starterBox = h('section', { class: 'panel raised stack', 'aria-labelledby': 'tc-starter' });
  const setBox = h('section', { class: 'panel stack', 'aria-labelledby': 'tc-set' });
  const listBox = h('section', { class: 'stack', 'aria-labelledby': 'tc-sets' });

  const main = h('main', { class: 'page stack-lg tc', 'data-view': 'teacher' },
    h('div', { class: 'stack-sm' },
      h('h1', null, 'For teachers'),
      h('p', { class: 'lede' }, 'Plan a five-question starter from what your class has been taught, set homework by link, and read the result codes your class sends back.'),
      h('p', { class: 'row small' },
        h('a', { class: 'btn', href: href('/board') }, 'Open the class board'),
        h('span', { class: 'muted' }, 'Nothing here leaves this device. No pupil names, no accounts.'))),
    classBox,
    h('div', { class: 'tc-cols' }, taughtBox, starterBox),
    setBox,
    listBox,
    measureSection());
  el.append(main);

  // ---------------------------------------------------------------- classes
  let drawing = false;
  function drawClasses(focusSel) {
    if (drawing) return;
    drawing = true;
    try { drawClassesNow(focusSel); } finally { drawing = false; }
  }
  function drawClassesNow(focusSel) {
    classes = loadClasses();
    const select = h('select', { id: 'tc-class', 'aria-label': 'Class' },
      classes.map((c) => h('option', { value: c.id, selected: c.id === cls.id }, c.name || 'Unnamed class')));
    select.addEventListener('change', () => { cls = findClass(select.value) || cls; history.replaceState(null, '', href(`/teacher?class=${cls.id}`)); drawAll('#tc-class'); });
    const name = h('input', { type: 'text', id: 'tc-name', value: cls.name, maxlength: '40', autocomplete: 'off' });
    name.addEventListener('change', () => {
      const v = name.value.trim().slice(0, 40) || 'Unnamed class';
      if (drawing || v === cls.name) return;
      cls = saveClass({ ...cls, name: v });
      announce(`Renamed to ${v}.`);
      drawClasses('#tc-name');
      drawStarter();
    });
    const level = h('select', { id: 'tc-level' }, LEVELS.map((l) => h('option', { value: l.id, selected: l.id === cls.level }, l.long)));
    level.addEventListener('change', () => { cls = saveClass({ ...cls, level: level.value }); drawAll('#tc-level'); });
    const confirmBox = h('div', { class: 'tc-confirm' });
    const del = button('Delete this class', { small: true, kind: 'ghost', onClick: () => {
      confirmBox.replaceChildren(h('div', { class: 'callout bad stack-sm', role: 'alertdialog', 'aria-labelledby': 'tc-del-q' },
        h('p', { id: 'tc-del-q', class: 'callout-head' }, `Delete “${cls.name}”?`),
        h('p', null, 'Its taught dates and starter history are removed from this device. Sets you made are kept.'),
        h('div', { class: 'row' },
          button('Delete class', { kind: 'primary', small: true, onClick: () => {
            const gone = cls.name;
            let rest = loadClasses().filter((c) => c.id !== cls.id);
            if (!rest.length) rest = [newClass({ id: newId(), name: 'My class', level: 'gcse' })];
            saveClasses(rest);
            cls = rest[0];
            announce(`Deleted ${gone}.`);
            drawAll('#tc-class');
          } }),
          button('Keep it', { small: true, onClick: () => { confirmBox.replaceChildren(); focus(del); } }))));
      focus(confirmBox.querySelector('button'));
    } });
    const add = button('Add a class', { small: true, onClick: () => {
      const c = newClass({ id: newId(), name: `Class ${loadClasses().length + 1}`, level: cls.level });
      saveClass(c);
      cls = c;
      announce(`Added ${c.name}.`);
      drawAll('#tc-name');
    } });
    classBox.replaceChildren(
      h('div', { class: 'row spread' }, h('h2', { id: 'tc-classes' }, 'Your classes'), add),
      h('div', { class: 'tc-classgrid' },
        h('label', { class: 'field', for: 'tc-class' }, h('span', null, 'Class'), select),
        h('label', { class: 'field', for: 'tc-name' }, h('span', null, 'Name'), name),
        h('label', { class: 'field', for: 'tc-level' }, h('span', null, 'Level'), level)),
      h('div', { class: 'row' }, del, h('span', { class: 'small muted' }, 'A class is only a name, a level and dates. No pupil data.')),
      confirmBox);
    if (focusSel) focus(classBox.querySelector(focusSel));
  }

  // ---------------------------------------------------------------- taught dates
  function drawTaught() {
    const day = today();
    const rows = classSpecs(cls.level).map((s) => {
      const taught = cls.taught?.[s.id];
      const idBase = `tc-t-${s.id.replace(/[^A-Za-z0-9]/g, '')}`;
      const box = h('input', { type: 'checkbox', id: `${idBase}-on`, checked: Number.isInteger(taught), dataset: { spec: s.id } });
      const date = h('input', { type: 'date', id: `${idBase}-date`, value: Number.isInteger(taught) ? dayToInput(taught) : '', 'aria-label': `Taught on (${s.title})`, dataset: { spec: s.id } });
      const apply = (d) => {
        cls = saveClass(setTaught(cls, s.id, d));
        box.checked = d !== null;
        date.value = d !== null ? dayToInput(d) : '';
        drawStarter();
      };
      box.addEventListener('change', () => apply(box.checked ? (inputToDay(date.value) ?? day) : null));
      date.addEventListener('change', () => apply(inputToDay(date.value)));
      return h('tr', null,
        h('td', null, h('label', { class: 'check', for: box.id }, box, h('span', null, h('span', { class: 'tc-spec' }, s.title), h('span', { class: 'small muted tc-board' }, `${s.board} ${s.code}`)))),
        h('td', { class: 'tc-date' }, date));
    });
    taughtBox.replaceChildren(
      h('h2', { id: 'tc-taught' }, 'Taught on'),
      h('p', { class: 'small muted' }, 'Tick what this class has been taught and when. The starter brings each point back 1 to 6 weeks later.'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'table tc-taught' },
        h('thead', null, h('tr', null, h('th', null, 'Spec point'), h('th', null, 'Taught on'))),
        h('tbody', null, rows))));
  }

  // ---------------------------------------------------------------- starter preview
  function drawStarter() {
    const day = today();
    let plan = [];
    try { plan = starterPlan(cls, day); } catch (e) { console.error(e); }
    starterBox.replaceChildren(
      h('div', { class: 'row spread' },
        h('h2', { id: 'tc-starter' }, "Today's starter"),
        h('span', { class: 'small muted' }, `${cls.name} · ${formatDay(day)}`)),
      plan.length
        ? h('ol', { class: 'tc-plan' }, plan.map((e) => h('li', { class: 'tc-plan-line' },
          h('span', { class: ['chip', e.source === 'missed' ? 'tc-src-missed' : e.source === 'spaced' ? 'tc-src-spaced' : 'accent'] }, sourceLabel(e, cls, day)),
          h('span', { class: 'tc-plan-title' }, specById(e.spec)?.title || e.spec),
          h('span', { class: 'small muted tc-plan-note' }, e.note || ''))))
        : h('p', null, 'Tick at least one spec point to plan a starter.'),
      h('div', { class: 'row' },
        h('a', { class: 'btn primary', href: href(`/starter?class=${encodeURIComponent(cls.id)}`) }, 'Project starter'),
        h('span', { class: 'small muted' }, 'Full screen, one question at a time. Keys: Space reveals, 1 · 2 · 3 record how the class did, W explains, → next, Esc leaves.')));
  }

  // ---------------------------------------------------------------- set homework
  function drawSetForm() {
    let level = LEVELS.some((l) => l.id === cls.level) ? cls.level : 'gcse';
    let mode = 'normal';
    let topics = new Set(topicsFor(level));
    const levelSel = h('select', { id: 'tc-set-level' }, LEVELS.map((l) => h('option', { value: l.id, selected: l.id === level }, l.long)));
    const topicsBox = h('fieldset', { class: 'tc-topics' });
    const n = h('input', { type: 'number', id: 'tc-set-n', min: '5', max: '15', value: '10', class: 'num-in' });
    const nameIn = h('input', { type: 'text', id: 'tc-set-name', maxlength: '60', autocomplete: 'off', placeholder: 'e.g. Year 10 homework, week 3' });
    const linkBox = h('div', { class: 'stack-sm' });
    const error = h('div');
    const out = h('div', { class: 'stack' });
    const modeSeg = seg([
      { value: 'normal', label: 'Normal' },
      { value: 'study', label: 'Study: practice' },
      { value: 'delayed', label: 'Study: delayed' },
    ], { label: 'Mode', value: mode, name: 'set-mode', onChange: (v) => { mode = v; drawTopics(); drawLink(); } });

    function drawTopics() {
      if (mode !== 'normal') {
        topicsBox.replaceChildren(h('legend', null, 'Topics'),
          h('p', { class: 'small muted' }, 'Study sets always use binary addition (family A) and shifts (family B), so each learner can be compared with themselves.'));
        return;
      }
      const avail = topicsFor(level);
      topics = new Set([...topics].filter((t) => avail.includes(t)));
      if (!topics.size) topics = new Set(avail);
      topicsBox.replaceChildren(h('legend', null, 'Topics'),
        h('div', { class: 'row' }, avail.map((t) => {
          const box = h('input', { type: 'checkbox', checked: topics.has(t), value: t, name: 'tc-topic' });
          box.addEventListener('change', () => { if (box.checked) topics.add(t); else topics.delete(t); });
          return h('label', { class: 'check' }, box, h('span', null, TOPIC_NAMES[t]));
        })));
    }
    function drawLink() {
      if (mode !== 'delayed') { linkBox.replaceChildren(); return; }
      const studies = loadSets().filter((s) => s.mode === 'study');
      const sel = h('select', { id: 'tc-set-link' },
        h('option', { value: '' }, studies.length ? 'Choose a study set' : 'No study sets made on this device yet'),
        studies.map((s) => h('option', { value: s.code }, `${s.label} (${formatDay(s.day)})`)));
      const paste = h('input', { type: 'text', id: 'tc-set-linkpaste', autocomplete: 'off', spellcheck: 'false', class: 'mono', placeholder: 'or paste the study set’s link' });
      linkBox.replaceChildren(
        h('label', { class: 'field', for: 'tc-set-link' }, h('span', null, 'Which study set does this follow?'), sel),
        h('label', { class: 'field', for: 'tc-set-linkpaste' }, h('span', { class: 'hint' }, 'Made it on another device? Paste its link instead.'), paste),
        h('p', { class: 'small muted' }, 'Set it at least 7 days after the study set. Everyone gets the answer only, on new questions from both families.'));
    }
    levelSel.addEventListener('change', () => { level = levelSel.value; drawTopics(); });

    const form = h('form', { class: 'stack', novalidate: true },
      h('div', { class: 'tc-setgrid' },
        h('label', { class: 'field', for: 'tc-set-level' }, h('span', null, 'Level'), levelSel),
        h('label', { class: 'field', for: 'tc-set-n' }, h('span', null, 'Questions'), n, h('span', { class: 'hint' }, '5 to 15')),
        h('label', { class: 'field', for: 'tc-set-name' }, h('span', null, 'Name (only you see this)'), nameIn)),
      h('div', { class: 'row' }, h('span', { class: 'field-label' }, 'Mode'), modeSeg.el),
      topicsBox, linkBox, error,
      button('Make the link', { kind: 'primary', type: 'submit' }));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      error.replaceChildren();
      const count = Number(n.value);
      if (!Number.isInteger(count) || count < 5 || count > 15) return fail('Choose between 5 and 15 questions.', n);
      const chosen = mode === 'normal' ? topicsFor(level).filter((t) => topics.has(t)) : ['add', 'shift'];
      if (!chosen.length) return fail('Tick at least one topic.', topicsBox.querySelector('input'));
      let link = null;
      let linkCode = null;
      if (mode === 'delayed') {
        const pasted = codeFromText(form.querySelector('#tc-set-linkpaste')?.value);
        const picked = form.querySelector('#tc-set-link')?.value;
        linkCode = pasted || picked;
        if (!linkCode) return fail('Choose the study set this one follows, or paste its link.', form.querySelector('#tc-set-link'));
        let study;
        try { study = decodeSet(linkCode); } catch (err) { return fail(`That study set link doesn't work. ${err.message}`, form.querySelector('#tc-set-linkpaste')); }
        if (study.mode !== 'study') return fail('That link is not a study set. A delayed set must follow a “Study: practice” set.', form.querySelector('#tc-set-linkpaste'));
        link = study.setId;
        linkCode = study.code;
      }
      let code;
      try { code = encodeSet({ level, topics: chosen, n: count, seed: newSeed(), mode, link }); } catch (err) { return fail(err.message, null); }
      const auto = `${levelName(level)} · ${mode === 'normal' ? chosen.map((t) => TOPIC_NAMES[t]).join(', ') : MODE_TEXT[mode]} · ${count} questions`;
      const rec = { code, day: today(), mode, n: count, level, topics: chosen, link, linkCode, label: nameIn.value.trim().slice(0, 60) || auto };
      save('sets', [rec, ...loadSets().filter((s) => s.code !== code)].slice(0, 100));
      showMade(rec);
      drawSets();
      if (mode === 'delayed' || mode === 'study') drawLink();
    });
    function fail(msg, target) { error.replaceChildren(callout('bad', null, msg)); focus(target); }

    function showMade(rec) {
      const link = shareUrl(`/set/${rec.code}`);
      const steps = instructions(rec);
      const copyAll = button('Copy link and instructions', { small: true, onClick: async () => {
        const ok = await copyText(`${link}\n\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`);
        copyAll.textContent = ok ? 'Copied ✓' : 'Select and copy';
        announce(ok ? 'Link and instructions copied' : 'Copy failed — select the text and copy it.');
        setTimeout(() => { copyAll.textContent = 'Copy link and instructions'; }, 2200);
      } });
      out.replaceChildren(h('div', { class: 'callout ok stack-sm tc-made', tabindex: '-1' },
        h('p', { class: 'callout-head' }, `Link ready: ${rec.label}`),
        copyBox(link, { what: 'Set link copied' }),
        h('p', { class: 'small' }, 'Instructions for students:'),
        h('ol', { class: 'tc-steps' }, steps.map((s) => h('li', null, s))),
        h('div', { class: 'row' }, copyAll, h('a', { class: 'btn small', href: href(`/board?set=${rec.code}`) }, 'Open the board for this set'))));
      focus(out.firstChild);
    }

    setBox.replaceChildren(
      h('h2', { id: 'tc-set' }, 'Set homework'),
      h('p', { class: 'small muted' }, 'Everyone who opens the link gets the same questions. At the end each learner gets a short result code to paste into your assignment; the codes carry no names.'),
      form, out);
    drawTopics();
    drawLink();
  }

  // ---------------------------------------------------------------- sets made here
  function drawSets() {
    const sets = loadSets();
    listBox.replaceChildren(
      h('h2', { id: 'tc-sets' }, 'Sets made on this device'),
      sets.length
        ? h('ul', { class: 'tc-setlist' }, sets.map((s) => {
          const linked = s.mode === 'delayed' && s.linkCode ? loadSets().find((x) => x.code === s.linkCode) : null;
          return h('li', { class: 'panel tight stack-sm' },
            h('div', { class: 'row spread' },
              h('strong', null, s.label),
              h('span', { class: 'row small muted' }, chip(MODE_TEXT[s.mode] || s.mode), `Made ${formatDay(s.day)}`)),
            linked ? h('p', { class: 'small muted' }, `Follows: ${linked.label}`) : null,
            copyBox(shareUrl(`/set/${s.code}`), { what: 'Set link copied' }),
            h('div', { class: 'row' },
              h('a', { class: 'btn small', href: href(`/board?set=${s.code}`) }, 'Open the board for this set'),
              button('Remove from this list', { small: true, kind: 'ghost', onClick: () => {
                save('sets', loadSets().filter((x) => x.code !== s.code));
                announce('Removed from the list. The link still works.');
                drawSets();
                focus(listBox.querySelector('h2'));
              } })));
        }))
        : h('p', { class: 'muted' }, 'None yet. Sets you make appear here with their links.'));
  }

  function drawAll(focusSel) {
    drawClasses(focusSel);
    drawTaught();
    drawStarter();
    drawSetForm();
    drawSets();
  }
  drawAll();
}

function instructions(rec) {
  return [
    'Open the link on your own device.',
    `Answer all ${rec.n} questions. Your answers stay on your device.`,
    'At the end, copy your result code and paste it into the assignment.',
  ];
}

function measureSection() {
  return h('section', { class: 'panel stack-sm tc-measure', 'aria-labelledby': 'tc-measure' },
    h('h2', { id: 'tc-measure' }, 'How we measure learning'),
    h('ul', { class: 'stack-sm' },
      h('li', null, h('strong', null, 'Holdout. '), 'About 15% of questions in practice and normal sets show only the correct answer, with no diagnosis or Why. When those come back a week or more later, we compare them with fully explained ones. It tells you whether the explanations help, not just whether learners got faster.'),
      h('li', null, h('strong', null, 'Study sets. '), 'In a “Study: practice” set each learner is randomly put in one of two groups: full feedback on addition and answer-only on shifts, or the other way round. Learners never see or choose their group. A “Study: delayed” set a week later tests both topics with the answer only.'),
      h('li', null, h('strong', null, "The board's reading. "), 'For each learner we take their score on the topic they got full feedback on minus the one they did not, and average across the two groups so an easier topic cannot bias it. The rule was set in advance: an effect size of 0.3 or more says invest in the drill-down; under 0.1 says stop; in between, run it again with another class. Fewer than 10 learners gives numbers but no reading.'),
      h('li', null, h('strong', null, 'Privacy. '), 'Result codes hold only scores, a group and up to three misconception numbers: no names. Nothing leaves this device; the board works on what you paste into it.')));
}
