/* ============================================================
 * noise.js — 可播种随机数 / 2D Simplex 噪声 / fbm / 山脊噪声
 * 宗门模拟器 demo3 · 山河图
 * ============================================================ */
(function (global) {
  'use strict';

  /* mulberry32: 轻量可播种 PRNG, 返回 [0,1) */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* 字符串 → 32 位种子 (FNV-1a) */
  function hashSeed(str) {
    let h = 2166136261 >>> 0;
    str = String(str);
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  /* ---------- 2D Simplex 噪声 (Gustavson 公版实现, 可播种) ---------- */
  var GRAD3 = new Float32Array([
    1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
    1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
    0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1
  ]);
  var F2 = 0.5 * (Math.sqrt(3) - 1);
  var G2 = (3 - Math.sqrt(3)) / 6;

  function SimplexNoise(rand) {
    rand = rand || Math.random;
    var p = new Uint8Array(256);
    for (var i = 0; i < 256; i++) p[i] = i;
    for (var j = 255; j > 0; j--) {
      var k = (rand() * (j + 1)) | 0;
      var t = p[j]; p[j] = p[k]; p[k] = t;
    }
    this.perm = new Uint8Array(512);
    this.permMod12 = new Uint8Array(512);
    for (var n = 0; n < 512; n++) {
      this.perm[n] = p[n & 255];
      this.permMod12[n] = this.perm[n] % 12;
    }
  }

  SimplexNoise.prototype.noise2D = function (xin, yin) {
    var perm = this.perm, permMod12 = this.permMod12;
    var n0 = 0, n1 = 0, n2 = 0;
    var s = (xin + yin) * F2;
    var i = Math.floor(xin + s), j = Math.floor(yin + s);
    var t = (i + j) * G2;
    var x0 = xin - (i - t), y0 = yin - (j - t);
    var i1, j1;
    if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }
    var x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
    var x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    var ii = i & 255, jj = j & 255;
    var t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 >= 0) {
      var gi0 = permMod12[ii + perm[jj]] * 3;
      t0 *= t0;
      n0 = t0 * t0 * (GRAD3[gi0] * x0 + GRAD3[gi0 + 1] * y0);
    }
    var t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 >= 0) {
      var gi1 = permMod12[ii + i1 + perm[jj + j1]] * 3;
      t1 *= t1;
      n1 = t1 * t1 * (GRAD3[gi1] * x1 + GRAD3[gi1 + 1] * y1);
    }
    var t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 >= 0) {
      var gi2 = permMod12[ii + 1 + perm[jj + 1]] * 3;
      t2 *= t2;
      n2 = t2 * t2 * (GRAD3[gi2] * x2 + GRAD3[gi2 + 1] * y2);
    }
    return 70 * (n0 + n1 + n2); /* ≈ [-1,1] */
  };

  /* 分形布朗运动: 多倍频叠加, ≈[-1,1] */
  function fbm(noise, x, y, octaves, lacunarity, gain) {
    octaves = octaves || 4; lacunarity = lacunarity || 2.0; gain = gain || 0.5;
    var amp = 1, freq = 1, sum = 0, norm = 0;
    for (var i = 0; i < octaves; i++) {
      sum += amp * noise.noise2D(x * freq, y * freq);
      norm += amp; amp *= gain; freq *= lacunarity;
    }
    return sum / norm;
  }

  /* 山脊噪声: 1-|n| 平方后叠加, [0,1], 用于造山脉走向 */
  function ridged(noise, x, y, octaves, lacunarity, gain) {
    octaves = octaves || 4; lacunarity = lacunarity || 2.05; gain = gain || 0.5;
    var amp = 0.55, freq = 1, sum = 0, norm = 0;
    for (var i = 0; i < octaves; i++) {
      var n = 1 - Math.abs(noise.noise2D(x * freq, y * freq));
      sum += amp * n * n;
      norm += amp; amp *= gain; freq *= lacunarity;
    }
    return sum / norm;
  }

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function smoothstep(a, b, x) {
    var t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  }
  function lerp(a, b, t) { return a + (b - a) * t; }

  global.NoiseLib = {
    mulberry32: mulberry32,
    hashSeed: hashSeed,
    SimplexNoise: SimplexNoise,
    fbm: fbm,
    ridged: ridged,
    clamp: clamp,
    smoothstep: smoothstep,
    lerp: lerp
  };
})(window);
