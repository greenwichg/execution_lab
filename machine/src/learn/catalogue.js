// One catalogue of misconceptions: binary (tags.js) + C/x86 (ctags.js),
// indexed by the fixed order in tagids.js.
import { TAG_IDS, tagIndex, tagId } from './tagids.js';
import { BINARY_TAGS } from './tags.js';
import { C_TAGS } from './ctags.js';

const GENERIC = {
  trace_value: {
    label: 'A value went a different way',
    student: 'At this point the machine holds a different value from the one you expected.',
    fix: 'Follow the value through each instruction below.',
    worked: () => ({ title: 'Following a value', steps: [
      { subgoal: 'Find the line', text: 'Start from the first line where your prediction and the machine disagree.' },
      { subgoal: 'Find the instruction', text: 'Look at the instruction that computes the new value.' },
      { subgoal: 'Check the operands', text: 'Check the register values going in, then the result coming out.' },
    ] }),
  },
  other: {
    label: 'Something else',
    student: "Your answer doesn't match a common mistake we know about.",
    fix: 'Compare your answer with the correct one, one step at a time.',
    worked: () => ({ title: 'Checking step by step', steps: [
      { subgoal: 'Compare', text: 'Put your answer next to the correct one.' },
      { subgoal: 'Find the first difference', text: 'Work in the order the machine does and stop at the first difference.' },
      { subgoal: 'Ask why', text: 'Open "Why?" to see the layer that explains it.' },
    ] }),
  },
};

export const TAGS = { ...GENERIC, ...BINARY_TAGS, ...C_TAGS };
export { TAG_IDS, tagIndex, tagId };
export const tagLabel = (id) => (id && TAGS[id] ? TAGS[id].label : '—');
export const tagInfo = (id) => (id && TAGS[id]) || null;

// every id in TAG_IDS must have an entry (checked by tests)
export const missingTags = () => TAG_IDS.filter((id) => id && !TAGS[id]);
