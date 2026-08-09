/** 小体量 ULID（Crockford base32，时间有序）。避免额外依赖。 */

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(now: number = Date.now()): string {
  let t = now;
  const time = new Array<string>(10);
  for (let i = 9; i >= 0; i--) {
    time[i] = ENCODING[t % 32];
    t = Math.floor(t / 32);
  }
  let rand = '';
  for (let i = 0; i < 16; i++) {
    rand += ENCODING[Math.floor(Math.random() * 32)];
  }
  return time.join('') + rand;
}
