// Specification points the product covers, in teaching order.
// `make` says how to generate a practice item for the spec point
// (see items/index.js → itemForSpec). CS:APP points draw from the card deck.
export const SPECS = [
  {
    id: 'J277-1.2.4-add', board: 'OCR GCSE (J277)', code: '1.2.4', level: 'gcse', topic: 'add',
    title: 'Binary addition and overflow',
    blurb: 'Add two binary integers of up to 8 bits and explain overflow.',
    also: 'AQA GCSE (8525): binary addition',
    make: { type: 'add', opts: { w: 8, ask: 'full' } },
  },
  {
    id: 'J277-1.2.4-shift', board: 'OCR GCSE (J277)', code: '1.2.4', level: 'gcse', topic: 'shift',
    title: 'Binary shifts',
    blurb: 'Shift left and right, and say what happens to the value when bits fall off.',
    also: 'AQA GCSE (8525): binary shifts',
    make: { type: 'shift', opts: { w: 8, kind: 'logical' } },
  },
  {
    id: 'H446-1.4.1-twos', board: 'OCR A-level (H446)', code: '1.4.1', level: 'alevel', topic: 'twos',
    title: "Two's complement",
    blurb: "Represent negative integers in two's complement, and know the range.",
    also: "AQA A-level (7517): two's complement",
    make: { type: 'twos', opts: { w: 8 } },
  },
  {
    id: 'H446-1.4.1-arith', board: 'OCR A-level (H446)', code: '1.4.1', level: 'alevel', topic: 'sadd',
    title: 'Signed addition, subtraction and overflow',
    blurb: "Add and subtract two's complement integers and spot signed overflow.",
    also: 'AQA A-level (7517): binary arithmetic',
    make: { type: 'sadd', opts: { w: 8, askFlags: ['OF'] } },
  },
  {
    id: 'H446-1.4.1-shift', board: 'OCR A-level (H446)', code: '1.4.1', level: 'alevel', topic: 'shift',
    title: 'Logical and arithmetic shifts',
    blurb: 'Shift signed and unsigned values; know which bit fills the gap.',
    also: 'AQA A-level (7517): bitwise shifts',
    make: { type: 'shift', opts: { w: 8, kind: 'mixed' } },
  },
  {
    id: 'H446-1.4.3-adders', board: 'OCR A-level (H446)', code: '1.4.3', level: 'alevel', topic: 'fa',
    title: 'Half and full adders',
    blurb: 'Trace the gates of a full adder for given inputs.',
    also: 'AQA A-level (7517): half and full adders',
    make: { type: 'fa', opts: {} },
  },
  {
    id: 'CSAPP-2.2', board: 'CS:APP', code: '2.2', level: 'csapp', topic: 'c',
    title: 'Integer representations in C',
    blurb: 'Signed vs unsigned, conversions, sign extension and truncation.',
    also: '',
    make: { type: 'card', opts: { section: '2.2' } },
  },
  {
    id: 'CSAPP-2.3', board: 'CS:APP', code: '2.3', level: 'csapp', topic: 'c',
    title: 'Integer arithmetic in C',
    blurb: 'Unsigned and two\'s complement addition, negation, multiplication, division.',
    also: '',
    make: { type: 'card', opts: { section: '2.3' } },
  },
  {
    id: 'CSAPP-3.5', board: 'CS:APP', code: '3.5', level: 'csapp', topic: 'c',
    title: 'Arithmetic and logical instructions',
    blurb: 'add, sub, imul, idiv, sar and shr on x86-64.',
    also: '',
    make: { type: 'card', opts: { section: '3.5' } },
  },
  {
    id: 'CSAPP-3.6', board: 'CS:APP', code: '3.6', level: 'csapp', topic: 'sadd',
    title: 'Condition codes and jumps',
    blurb: 'CF, ZF, SF and OF after an operation; jl vs jb.',
    also: '',
    make: { type: 'sadd', opts: { w: 8, askFlags: ['CF', 'ZF', 'SF', 'OF'] } },
  },
];

export const LEVELS = [
  { id: 'gcse', name: 'GCSE', long: 'GCSE binary arithmetic' },
  { id: 'alevel', name: 'A-level', long: "A-level: two's complement, shifts and adders" },
  { id: 'csapp', name: 'CS:APP', long: 'C on x86-64 (CS:APP chapters 2–3)' },
];

export const TOPICS = ['add', 'shift', 'twos', 'sadd', 'fa', 'c'];
export const TOPIC_NAMES = { add: 'Binary addition', shift: 'Shifts', twos: "Two's complement", sadd: 'Signed arithmetic and flags', fa: 'Full adders', c: 'C on x86-64' };

export const specById = (id) => SPECS.find((s) => s.id === id) || null;
export const specsForLevel = (level) => SPECS.filter((s) => s.level === level);
export const specsForTopic = (topic) => SPECS.filter((s) => s.topic === topic);
export const specLabel = (s) => (s.board === 'CS:APP' ? `CS:APP ${s.code} · ${s.title}` : `${s.board} ${s.code} · ${s.title}`);
