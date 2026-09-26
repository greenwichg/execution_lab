// The misconception catalogue's ids, in a FIXED order.
// Result tokens store the index into this array, so never reorder or remove an
// entry — only append (at most 31 entries after the leading null).
export const TAG_IDS = [
  null,
  // binary addition (GCSE)
  'add_or',                    // 1  treated 1 + 1 as 1 (OR)
  'add_no_carry',              // 2  didn't carry into the next column
  'add_three_ones',            // 3  1 + 1 + 1 written as 0 carry 1
  'add_carry_wrong_col',       // 4  carry written in the wrong column
  'add_ninth_bit',             // 5  kept a 9th bit in an 8-bit result
  'add_overflow_missed',       // 6  missed the overflow
  'add_overflow_false',        // 7  claimed overflow when there was none
  // shifts
  'shift_direction',           // 8  shifted the wrong way
  'shift_amount',              // 9  shifted by the wrong number of places
  'shift_kept_bits',           // 10 kept bits that fall off the end (rotated)
  'shift_fill',                // 11 filled with the wrong bit
  'shift_value_myth',          // 12 assumed ×2ⁿ/÷2ⁿ still holds after bits are lost
  'shift_arith_logical',       // 13 confused arithmetic and logical right shift
  // two's complement
  'twos_sign_magnitude',       // 14 used sign-and-magnitude
  'twos_no_plus1',             // 15 inverted but forgot to add 1
  'twos_msb_positive',         // 16 read the top bit as +128 instead of −128
  'twos_range',                // 17 wrong range (it is −128 to 127)
  // signed arithmetic and flags
  'flags_carry_is_overflow',   // 18 confused carry (CF) with overflow (OF)
  'flags_signed_overflow_missed', // 19 missed signed overflow (e.g. 127 + 1)
  'flags_sub_carry',           // 20 misread CF after subtraction (borrow)
  // C on x86-64 (CS:APP)
  'c_signed_overflow',         // 21 expected signed overflow not to wrap
  'c_usual_conversions',       // 22 missed the conversion to unsigned (-1 < 0U)
  'c_promotion',               // 23 missed integer promotion (char/short → int)
  'c_truncating_division',     // 24 rounded division down instead of toward zero
  'c_shift_negative',          // 25 expected >> on a negative int to be logical
  'c_char_signedness',         // 26 assumed char is unsigned / 200 fits in char
  'c_unsigned_wrap',           // 27 expected unsigned to go negative or stop at 0
  'c_narrowing',               // 28 missed truncation into a smaller type
  'c_jump_signedness',         // 29 confused signed (jl) and unsigned (jb) jumps
  // generic
  'trace_value',               // 30 a variable's value differed (paste mode)
  'other',                     // 31 wrong, but not one of the known patterns
];

export const tagIndex = (id) => Math.max(0, TAG_IDS.indexOf(id ?? null));
export const tagId = (index) => (index > 0 && index < TAG_IDS.length ? TAG_IDS[index] : null);
