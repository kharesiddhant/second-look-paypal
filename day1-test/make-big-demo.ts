// Generates the 500-line demo: a creator platform paying 500 creators for October, with six months of history.
// Run: npx tsx day1-test/make-big-demo.ts   (deterministic; rewrites the big-* files and the answer key)
import { writeFileSync } from 'node:fs';

let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];

const FIRST = ['Ava', 'Ben', 'Chloe', 'Dev', 'Elena', 'Femi', 'Grace', 'Hiro', 'Isla', 'Jonas', 'Kavya', 'Leo', 'Maya',
  'Nikhil', 'Olga', 'Pablo', 'Quinn', 'Rosa', 'Sami', 'Tara', 'Umar', 'Vera', 'Wen', 'Ximena', 'Yusuf'];
const LAST = ['Adler', 'Banerjee', 'Costa', 'Dubois', 'Eriksen', 'Fischer', 'Garcia', 'Hughes', 'Ibrahim', 'Jensen',
  'Kowalski', 'Lindqvist', 'Moreau', 'Nakamura', 'Okafor', 'Petrov', 'Quiroga', 'Rossi', 'Silva', 'Tanaka'];
const MONTHS = ['04', '05', '06', '07', '08', '09'];
const DAYS: Record<string, string> = { '04': '30', '05': '29', '06': '30', '07': '31', '08': '31', '09': '30' };

const creators = FIRST.flatMap(f => LAST.map(l => ({ name: `${f} ${l}`, email: `${f}.${l}@creators.example.com`.toLowerCase() })))
  .map((c, i) => ({
    ...c,
    id: `CR-${String(i + 1).padStart(4, '0')}`,
    currency: rand() < 0.1 ? 'EUR' : 'USD',
    rate: (Math.round((120 + rand() * 360) / 10) * 10).toFixed(2),
  }));

// Planted mistakes, spread over different 50-line chunks. Line numbers are 1-based positions.
const plant: Record<number, string> = {
  7: 'email', 63: 'amount', 118: 'duplicate', 174: 'currency', 229: 'email', 281: 'amount',
  333: 'new_over_limit', 388: 'duplicate', 402: 'missing_invoice', 447: 'amount', 470: 'email', 495: 'currency',
};
// The currency mistakes need EUR creators, and the new recipient must have no history.
for (const n of [174, 495]) creators[n - 1].currency = 'EUR';
creators[332].rate = '750.00';

const history = ['date,name,email,amount,currency,invoice'];
const invoices: string[] = [];
const payout = ['line,name,email,amount,currency,invoice,note'];
const key: string[] = ['# Big demo answer key', '', '| Line | Creator | Planted mistake | Expected |', '|---|---|---|---|'];

creators.forEach((c, i) => {
  const n = i + 1;
  const kind = plant[n];
  if (kind !== 'new_over_limit') {
    for (const m of MONTHS) {
      const amount = (Number(c.rate) + (rand() < 0.15 ? pick([-20, 20, 40]) : 0)).toFixed(2);
      history.push(`2026-${m}-${DAYS[m]},${c.name},${c.email},${amount},${c.currency},${c.id}-${m}`);
    }
  }
  if (kind !== 'missing_invoice') {
    invoices.push(`=== ${c.id}-10 ===\nFrom: ${c.name} · Pay to PayPal: ${c.email}\nOctober content · Total ${c.rate} ${c.currency} · Due 2026-10-31`);
  }
  let email = c.email, amount = c.rate, currency = c.currency, invoice = `${c.id}-10`;
  if (kind === 'email') email = c.email.replace('@creators.example.com', '.payouts@creators-pay.example.com');
  if (kind === 'amount') amount = (Number(c.rate) * 10).toFixed(2);
  if (kind === 'duplicate') invoice = `${c.id}-09`;
  if (kind === 'currency') currency = 'USD';
  payout.push(`${n},${c.name},${email},${amount},${currency},${invoice},October content`);
  if (kind) {
    // Owner's rules: a missing invoice alone and a currency mismatch alone are review.
    const expected = ['new_over_limit', 'missing_invoice', 'currency'].includes(kind) ? 'review' : 'block';
    key.push(`| ${n} | ${c.name} | ${kind.replace(/_/g, ' ')} | ${expected} |`);
  }
});

// A "new payment details" email for the first changed-email line, like Jane's in the small demo.
const scam = creators[6];
invoices.push(`--- Forwarded email, received 2026-10-18 ---\nFrom: ${scam.name} <${scam.name.split(' ')[0].toLowerCase()}.studio@gmail-mail.co>\nSubject: Updated payout details\nHi! Please send my October payout to my new account: ${scam.email.replace('@creators.example.com', '.payouts@creators-pay.example.com')}. Thanks`);

key.push('', 'Every other line is clean and should come back ok.');
writeFileSync('day1-test/big-history.csv', history.join('\n') + '\n');
writeFileSync('day1-test/big-invoices.txt', invoices.join('\n\n') + '\n');
writeFileSync('day1-test/big-payout.csv', payout.join('\n') + '\n');
writeFileSync('day1-test/big-answer-key.md', key.join('\n') + '\n');
console.log(`creators ${creators.length}, history rows ${history.length - 1}, invoices ${invoices.length - 1}, planted ${Object.keys(plant).length}`);
