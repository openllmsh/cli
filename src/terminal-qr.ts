/**
 * Dependency-free QR encoder for the terminal (`openllm login` on SSH / with
 * no browser, D4 of `docs/plan/2026-11-02-cli-auth-ux.md`). Byte mode, error
 * correction level L, versions 1–10 (up to 271 bytes) — enough for any
 * authorize URL, small enough to fit a terminal. Compiled into the binary, so
 * no network and no third-party code.
 *
 * Follows ISO/IEC 18004 the way Project Nayuki's reference encoder lays it
 * out: data + Reed–Solomon codewords interleaved, function patterns, zigzag
 * placement, mask, format/version bits. Parity is checked against an
 * independent encoder in `tests/cli/terminal-qr.test.ts`.
 */

export type TQrMatrix = {
  readonly size: number;
  /** `modules[row][col]`, true = dark. */
  readonly modules: ReadonlyArray<ReadonlyArray<boolean>>;
  readonly version: number;
  readonly mask: number;
};

const MAX_VERSION = 10;

/** Level L, indexed by version (index 0 unused). */
const ECC_CODEWORDS_PER_BLOCK = [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18];
const NUM_ERROR_CORRECTION_BLOCKS = [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4];
/** Format-info bits for level L. */
const ECC_FORMAT_BITS_L = 1;

const bitAt = (value: number, i: number): boolean => ((value >>> i) & 1) !== 0;

const numRawDataModules = (ver: number): number => {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
};

const numDataCodewords = (ver: number): number =>
  Math.floor(numRawDataModules(ver) / 8) -
  (ECC_CODEWORDS_PER_BLOCK[ver] ?? 0) * (NUM_ERROR_CORRECTION_BLOCKS[ver] ?? 0);

// ─── Reed–Solomon over GF(2^8), polynomial 0x11D ─────────────────────────

const gfMultiply = (x: number, y: number): number => {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
};

const rsDivisor = (degree: number): number[] => {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < result.length; j += 1) {
      result[j] = gfMultiply(result[j] ?? 0, root);
      if (j + 1 < result.length)
        result[j] = (result[j] ?? 0) ^ (result[j + 1] ?? 0);
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
};

const rsRemainder = (
  data: readonly number[],
  divisor: readonly number[],
): number[] => {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ (result.shift() ?? 0);
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i] = (result[i] ?? 0) ^ gfMultiply(coef, factor);
    });
  }
  return result;
};

// ─── codewords ────────────────────────────────────────────────────────────

const dataCodewords = (bytes: Uint8Array, ver: number): number[] => {
  const bits: number[] = [];
  const append = (value: number, len: number): void => {
    for (let i = len - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  append(0b0100, 4); // byte mode
  append(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) append(b, 8);
  const capacity = numDataCodewords(ver) * 8;
  append(0, Math.min(4, capacity - bits.length));
  append(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) {
    append(pad, 8);
  }
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | (bits[i + j] ?? 0);
    out.push(byte);
  }
  return out;
};

const interleaveWithEcc = (data: readonly number[], ver: number): number[] => {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ver] ?? 1;
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ver] ?? 0;
  const rawCodewords = Math.floor(numRawDataModules(ver) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const divisor = rsDivisor(blockEccLen);
  const blocks: number[][] = [];
  let k = 0;
  for (let i = 0; i < numBlocks; i += 1) {
    const len = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
    const dat = data.slice(k, k + len);
    k += len;
    const ecc = rsRemainder(dat, divisor);
    // Pad short blocks so every block has the same length; skipped below.
    if (i < numShortBlocks) dat.push(0);
    blocks.push([...dat, ...ecc]);
  }
  const result: number[] = [];
  const blockLen = blocks[0]?.length ?? 0;
  for (let i = 0; i < blockLen; i += 1) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) {
        result.push(block[i] ?? 0);
      }
    });
  }
  return result;
};

// ─── matrix ───────────────────────────────────────────────────────────────

const alignmentPositions = (ver: number, size: number): number[] => {
  if (ver === 1) return [];
  const numAlign = Math.floor(ver / 7) + 2;
  const step = Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let i = 0, pos = size - 7; i < numAlign - 1; i += 1, pos -= step) {
    result.splice(1, 0, pos);
  }
  return result;
};

const maskBit = (mask: number, x: number, y: number): boolean => {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
};

type TGrid = { modules: boolean[][]; isFunction: boolean[][] };

const buildBase = (ver: number, size: number): TGrid => {
  const modules = Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(false),
  );
  const isFunction = Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(false),
  );
  const set = (x: number, y: number, dark: boolean): void => {
    const row = modules[y];
    const frow = isFunction[y];
    if (row === undefined || frow === undefined) return;
    row[x] = dark;
    frow[x] = true;
  };
  for (let i = 0; i < size; i += 1) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  const finder = (cx: number, cy: number): void => {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) {
          set(x, y, dist !== 2 && dist !== 4);
        }
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  const align = alignmentPositions(ver, size);
  const last = align.length - 1;
  align.forEach((ay, i) => {
    align.forEach((ax, j) => {
      if (
        (i === 0 && j === 0) ||
        (i === 0 && j === last) ||
        (i === last && j === 0)
      )
        return;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    });
  });
  // Reserve format areas (real bits drawn after masking).
  drawFormatBits({ modules, isFunction }, size, 0);
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i += 1) {
      const dark = bitAt(bits, i);
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }
  return { modules, isFunction };
};

function drawFormatBits(grid: TGrid, size: number, mask: number): void {
  const data = (ECC_FORMAT_BITS_L << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const set = (x: number, y: number, dark: boolean): void => {
    const row = grid.modules[y];
    const frow = grid.isFunction[y];
    if (row === undefined || frow === undefined) return;
    row[x] = dark;
    frow[x] = true;
  };
  for (let i = 0; i <= 5; i += 1) set(8, i, bitAt(bits, i));
  set(8, 7, bitAt(bits, 6));
  set(8, 8, bitAt(bits, 7));
  set(7, 8, bitAt(bits, 8));
  for (let i = 9; i < 15; i += 1) set(14 - i, 8, bitAt(bits, i));
  for (let i = 0; i < 8; i += 1) set(size - 1 - i, 8, bitAt(bits, i));
  for (let i = 8; i < 15; i += 1) set(8, size - 15 + i, bitAt(bits, i));
  set(8, size - 8, true);
}

const placeCodewords = (
  grid: TGrid,
  size: number,
  data: readonly number[],
): void => {
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        const row = grid.modules[y];
        if (
          row !== undefined &&
          grid.isFunction[y]?.[x] !== true &&
          i < data.length * 8
        ) {
          row[x] = bitAt(data[i >>> 3] ?? 0, 7 - (i & 7));
          i += 1;
        }
      }
    }
  }
};

const applyMask = (grid: TGrid, size: number, mask: number): void => {
  for (let y = 0; y < size; y += 1) {
    const row = grid.modules[y];
    if (row === undefined) continue;
    for (let x = 0; x < size; x += 1) {
      if (grid.isFunction[y]?.[x] !== true && maskBit(mask, x, y)) {
        row[x] = !row[x];
      }
    }
  }
};

/**
 * ISO 18004 penalty (rules N1–N4) — picks the most scannable mask. Any mask
 * is a valid code; this only affects readability.
 */
const penalty = (
  modules: readonly (readonly boolean[])[],
  size: number,
): number => {
  let score = 0;
  const at = (x: number, y: number): boolean => modules[y]?.[x] === true;
  const lines = (horizontal: boolean): boolean[][] =>
    Array.from({ length: size }, (_, a) =>
      Array.from({ length: size }, (_, b) =>
        horizontal ? at(b, a) : at(a, b),
      ),
    );
  for (const horizontal of [true, false]) {
    for (const line of lines(horizontal)) {
      let run = 1;
      for (let i = 1; i <= size; i += 1) {
        if (i < size && line[i] === line[i - 1]) {
          run += 1;
        } else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      // N3: 1:1:3:1:1 finder-like with 4 light modules on one side.
      for (let i = 0; i + 7 <= size; i += 1) {
        const core =
          line[i] === true &&
          line[i + 1] === false &&
          line[i + 2] === true &&
          line[i + 3] === true &&
          line[i + 4] === true &&
          line[i + 5] === false &&
          line[i + 6] === true;
        if (!core) continue;
        const lightBefore = [1, 2, 3, 4].every((d) => line[i - d] !== true);
        const lightAfter = [7, 8, 9, 10].every((d) => line[i + d] !== true);
        if (lightBefore || lightAfter) score += 40;
      }
    }
  }
  let dark = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (at(x, y)) dark += 1;
      if (
        x + 1 < size &&
        y + 1 < size &&
        at(x, y) === at(x + 1, y) &&
        at(x, y) === at(x, y + 1) &&
        at(x, y) === at(x + 1, y + 1)
      )
        score += 3;
    }
  }
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  return score + Math.max(0, k) * 10;
};

/**
 * Encode `text` (UTF-8) as a level-L QR. `mask` forces a mask pattern (0–7);
 * otherwise the lowest-penalty one is chosen. Returns null when `text` does
 * not fit version 10.
 */
export const encodeQr = (
  text: string,
  options: { readonly mask?: number } = {},
): TQrMatrix | null => {
  const bytes = new TextEncoder().encode(text);
  let version = 0;
  for (let v = 1; v <= MAX_VERSION; v += 1) {
    const lenBits = v <= 9 ? 8 : 16;
    if (
      4 + lenBits + bytes.length * 8 <= numDataCodewords(v) * 8 &&
      bytes.length < 2 ** lenBits
    ) {
      version = v;
      break;
    }
  }
  if (version === 0) return null;
  const size = version * 4 + 17;
  const codewords = interleaveWithEcc(dataCodewords(bytes, version), version);
  const build = (mask: number): boolean[][] => {
    const grid = buildBase(version, size);
    placeCodewords(grid, size, codewords);
    applyMask(grid, size, mask);
    drawFormatBits(grid, size, mask);
    return grid.modules;
  };
  if (options.mask !== undefined) {
    return { size, modules: build(options.mask), version, mask: options.mask };
  }
  let best = 0;
  let bestModules = build(0);
  let bestScore = penalty(bestModules, size);
  for (let mask = 1; mask < 8; mask += 1) {
    const candidate = build(mask);
    const score = penalty(candidate, size);
    if (score < bestScore) {
      best = mask;
      bestModules = candidate;
      bestScore = score;
    }
  }
  return { size, modules: bestModules, version, mask: best };
};

/** Quiet zone in modules around the rendered code. */
export const QR_QUIET_ZONE = 2;

/**
 * Render with half-block characters, two module rows per text line. LIGHT
 * modules (and the quiet zone) are drawn in the foreground colour, so on the
 * usual dark terminal the code reads dark-on-light; on a light terminal it
 * comes out inverted, which phone cameras also read.
 */
export const renderQrHalfBlocks = (qr: TQrMatrix): string => {
  const span = qr.size + QR_QUIET_ZONE * 2;
  const light = (x: number, y: number): boolean => {
    const mx = x - QR_QUIET_ZONE;
    const my = y - QR_QUIET_ZONE;
    if (mx < 0 || my < 0 || mx >= qr.size || my >= qr.size) return true;
    return qr.modules[my]?.[mx] !== true;
  };
  const lines: string[] = [];
  for (let y = 0; y < span; y += 2) {
    let line = "";
    for (let x = 0; x < span; x += 1) {
      const top = light(x, y);
      const bottom = y + 1 < span ? light(x, y + 1) : false;
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(line);
  }
  return `${lines.join("\n")}\n`;
};
