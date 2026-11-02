/** 可复现的伪随机数生成器（用于请求里的 seed 参数）。 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function uniform(min, max, rng = Math.random) {
  if (max <= min) return min;
  return min + (max - min) * rng();
}

export function uniformInt(min, max, rng = Math.random) {
  const lo = Math.ceil(min);
  const hi = Math.floor(max);
  if (hi <= lo) return lo;
  return lo + Math.floor(rng() * (hi - lo + 1));
}

export function pickIndex(length, rng = Math.random) {
  return Math.floor(rng() * length) % length;
}

export function chance(probability, rng = Math.random) {
  return rng() < probability;
}
