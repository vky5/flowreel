// How wide each printable ASCII character is, in hundredths of the font size, for DejaVu Sans regular and bold.
// DejaVu is wider than most interface fonts, so a label sized from it fits whichever font the viewer has.
// Used when there is no browser to measure text, such as the command-line tool.

const FIRST = 32; // the space character
const REGULAR = [32,40,46,84,64,95,78,27,39,39,50,84,32,36,32,34,64,64,64,64,64,64,64,64,64,64,34,34,84,84,84,53,100,68,69,70,77,63,58,77,75,30,30,66,56,86,75,79,60,79,69,63,61,73,68,99,68,61,68,39,34,39,84,50,50,61,63,55,63,62,35,63,63,28,28,58,28,97,63,61,63,63,41,52,39,63,59,82,59,59,52,64,34,64,84];
const BOLD = [35,46,52,84,70,100,87,31,46,46,52,84,38,42,38,37,70,70,70,70,70,70,70,70,70,70,40,40,84,84,84,58,100,77,76,73,83,68,68,82,84,37,37,77,64,100,84,85,73,85,77,72,68,81,77,110,77,72,73,46,37,46,84,50,50,67,72,59,72,68,44,72,71,34,34,66,34,104,71,69,72,72,49,60,48,71,65,92,64,65,58,71,37,71,84];
const OTHER = [60, 66]; // anything outside the table: an average width

export function tableWidth(text: string, size: number, weight: number): number {
  const bold = weight >= 600;
  const half = weight === 500; // halfway between regular and bold
  let total = 0;
  for (const ch of text) {
    const i = ch.codePointAt(0)! - FIRST;
    const inTable = i >= 0 && i < REGULAR.length;
    const r = inTable ? REGULAR[i] : OTHER[0];
    const b = inTable ? BOLD[i] : OTHER[1];
    total += bold ? b : half ? (r + b) / 2 : r;
  }
  return (total * size) / 100;
}
