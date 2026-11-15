// Normaliza telefone brasileiro com DDD para E.164 (+55DDNNNNNNNNN).
// Retorna null quando a entrada não é um telefone brasileiro válido.
const DDD_VALIDOS = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 24, 27, 28, 31, 32, 33, 34, 35, 37, 38,
  41, 42, 43, 44, 45, 46, 47, 48, 49, 51, 53, 54, 55, 61, 62, 63, 64, 65, 66, 67, 68, 69,
  71, 73, 74, 75, 77, 79, 81, 82, 83, 84, 85, 86, 87, 88, 89, 91, 92, 93, 94, 95, 96, 97, 98, 99,
]);

export function normalizePhoneBR(input) {
  if (typeof input !== 'string' || input.length > 40) return null;
  if (!/^[\d\s()+.-]+$/.test(input)) return null;
  let digits = input.replace(/\D/g, '');
  if (input.trim().startsWith('+')) {
    if (!digits.startsWith('55')) return null;
    digits = digits.slice(2);
  } else if (digits.length >= 12 && digits.startsWith('55')) {
    digits = digits.slice(2);
  } else if (digits.startsWith('0')) {
    digits = digits.replace(/^0+/, '');
  }
  if (digits.length !== 10 && digits.length !== 11) return null;
  if (!DDD_VALIDOS.has(Number(digits.slice(0, 2)))) return null;
  const local = digits.slice(2);
  if (local.length === 9 && local[0] !== '9') return null;
  if (local.length === 8 && !/^[2-5]/.test(local)) return null;
  return `+55${digits}`;
}
