/**
 * 地形 PNG 的原始编解码。
 *
 * 地形图把颜色低 8 位放在 PNG 的 alpha 通道里，而 canvas 的 2D 上下文内部按
 * 预乘 alpha 保存像素：alpha 很小时，RGB 会被乘到 0，或者在解码时被反乘回一个
 * 近似值。颜色数据只要经过 canvas，就不再可逆。因此这里直接读写 PNG 字节：
 * 只处理 8 位、非隔行、RGB / RGBA 的 PNG，压缩交给 fflate 的同步 zlib。
 *
 * 编码时逐行试 5 种 PNG 过滤器（取绝对值和最小的一种），压缩率与常见编码器相当；
 * 解码支持全部 5 种过滤器，所以也能读浏览器或其他工具生成的普通 PNG。
 */
import { unzlibSync, zlibSync } from 'fflate';

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const BYTES_PER_PIXEL = 4;

/** 把 RGBA 像素编码成 PNG dataURL。alpha 只是普通字节，没有透明度含义。 */
export function encodePngRgba(width, height, rgba) {
  if (rgba.length !== width * height * 4) {
    throw new Error('PNG 像素数量与尺寸不一致');
  }
  const stride = width * 4;
  // 每行开头一个过滤器字节；行内容先留空，逐行挑过滤器后填入
  const raw = new Uint8Array(height * (stride + 1));
  let prev = new Uint8Array(stride);
  const scratch = Array.from({ length: 5 }, () => new Uint8Array(stride));

  for (let y = 0; y < height; y++) {
    const src = y * stride;
    const row = rgba.subarray(src, src + stride);
    let best = 0;
    let bestScore = Infinity;
    for (let filter = 0; filter <= 4; filter++) {
      filterRow(filter, row, prev, scratch[filter], BYTES_PER_PIXEL);
      const score = filterScore(scratch[filter]);
      if (score < bestScore) {
        bestScore = score;
        best = filter;
      }
    }
    const o = y * (stride + 1);
    raw[o] = best;
    raw.set(scratch[best], o + 1);
    prev = row;
  }

  const compressed = zlibSync(raw, { level: 6 });
  const ihdr = new Uint8Array(13);
  writeU32(ihdr, 0, width);
  writeU32(ihdr, 4, height);
  ihdr[8] = 8;   // 位深
  ihdr[9] = 6;   // 颜色类型：真彩 + alpha
  ihdr[10] = 0;  // 压缩方法：deflate
  ihdr[11] = 0;  // 过滤方法
  ihdr[12] = 0;  // 非隔行

  const idat = compressed;
  const chunks = [
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', idat),
    makeChunk('IEND', new Uint8Array(0)),
  ];
  let total = PNG_SIGNATURE.length;
  for (const c of chunks) total += c.length;
  const png = new Uint8Array(total);
  png.set(PNG_SIGNATURE, 0);
  let pos = PNG_SIGNATURE.length;
  for (const c of chunks) {
    png.set(c, pos);
    pos += c.length;
  }
  return `data:image/png;base64,${bytesToBase64(png)}`;
}

/**
 * 解码 PNG dataURL 为 RGBA 字节。
 * 只接受 8 位、非隔行的 RGB / RGBA；其他格式直接报错，避免静默读错地形。
 * @returns {{ width: number, height: number, data: Uint8Array }}
 */
export function decodePngRgba(dataUrl) {
  return decodePngBytes(base64ToBytes(dataUrl));
}

/** 解码 PNG 字节流；与 decodePngRgba 共用同一套解析逻辑，便于单独测试。 */
export function decodePngBytes(bytes) {
  if (bytes.length < 8 || PNG_SIGNATURE.some((b, i) => bytes[i] !== b)) {
    throw new Error('不是有效的 PNG 文件');
  }
  let pos = 8;
  let ihdr = null;
  const idat = [];
  while (pos + 8 <= bytes.length) {
    const length = readU32(bytes, pos);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const start = pos + 8;
    const end = start + length;
    if (end + 4 > bytes.length) throw new Error('PNG 数据块不完整');
    if (type === 'IHDR') {
      if (length !== 13) throw new Error('PNG 头长度不正确');
      ihdr = {
        width: readU32(bytes, start),
        height: readU32(bytes, start + 4),
        bitDepth: bytes[start + 8],
        colorType: bytes[start + 9],
        compression: bytes[start + 10],
        filter: bytes[start + 11],
        interlace: bytes[start + 12],
      };
    } else if (type === 'IDAT') {
      idat.push(bytes.subarray(start, end));
    } else if (type === 'IEND') {
      break;
    }
    pos = end + 4; // 跳过 CRC
  }
  if (!ihdr) throw new Error('PNG 缺少 IHDR');
  const { width, height, bitDepth, colorType, compression, interlace } = ihdr;
  if (!width || !height) throw new Error('PNG 尺寸无效');
  if (bitDepth !== 8) throw new Error(`不支持 ${bitDepth} 位深的地形 PNG`);
  if (compression !== 0) throw new Error('不支持该 PNG 压缩方法');
  if (interlace !== 0) throw new Error('不支持隔行 PNG');
  if (colorType !== 2 && colorType !== 6) {
    throw new Error(`不支持颜色类型 ${colorType} 的地形 PNG`);
  }
  if (!idat.length) throw new Error('PNG 缺少图像数据');

  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = unzlibSync(concatBytes(idat));
  if (raw.length < height * (stride + 1)) throw new Error('PNG 图像数据不完整');

  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    const line = raw.subarray(rowStart + 1, rowStart + 1 + stride);
    const prev = y > 0
      ? raw.subarray((y - 1) * (stride + 1) + 1, (y - 1) * (stride + 1) + 1 + stride)
      : new Uint8Array(stride);
    unfilterRow(filter, line, prev, bpp);
    const out = y * width * 4;
    if (bpp === 4) {
      data.set(line, out);
    } else {
      for (let x = 0; x < width; x++) {
        const s = x * 3;
        const d = out + x * 4;
        data[d] = line[s];
        data[d + 1] = line[s + 1];
        data[d + 2] = line[s + 2];
        data[d + 3] = 255;
      }
    }
  }
  return { width, height, data };
}

// ---------------------------------------------------------------- PNG 过滤器

function filterRow(type, row, prev, out, bpp) {
  for (let i = 0; i < row.length; i++) {
    const a = i >= bpp ? row[i - bpp] : 0;
    const b = prev[i];
    const c = i >= bpp ? prev[i - bpp] : 0;
    let predictor = 0;
    if (type === 1) predictor = a;
    else if (type === 2) predictor = b;
    else if (type === 3) predictor = (a + b) >> 1;
    else if (type === 4) predictor = paeth(a, b, c);
    out[i] = (row[i] - predictor) & 0xff;
  }
}

function unfilterRow(type, line, prev, bpp) {
  if (type === 0) return;
  if (type > 4) throw new Error(`PNG 过滤器 ${type} 无效`);
  for (let i = 0; i < line.length; i++) {
    const a = i >= bpp ? line[i - bpp] : 0;
    const b = prev[i];
    const c = i >= bpp ? prev[i - bpp] : 0;
    let predictor = 0;
    if (type === 1) predictor = a;
    else if (type === 2) predictor = b;
    else if (type === 3) predictor = (a + b) >> 1;
    else predictor = paeth(a, b, c);
    line[i] = (line[i] + predictor) & 0xff;
  }
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** 过滤器选择启发式：把字节当有符号数，绝对值和越小通常压得越好 */
function filterScore(bytes) {
  let score = 0;
  for (let i = 0; i < bytes.length; i++) {
    const v = bytes[i];
    score += v < 128 ? v : 256 - v;
  }
  return score;
}

// ---------------------------------------------------------------- 数据块与字节

function makeChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  writeU32(out, 0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  writeU32(out, 8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function writeU32(arr, offset, value) {
  arr[offset] = (value >>> 24) & 0xff;
  arr[offset + 1] = (value >>> 16) & 0xff;
  arr[offset + 2] = (value >>> 8) & 0xff;
  arr[offset + 3] = value & 0xff;
}

function readU32(arr, offset) {
  return ((arr[offset] << 24) | (arr[offset + 1] << 16) | (arr[offset + 2] << 8) | arr[offset + 3]) >>> 0;
}

function concatBytes(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

function base64ToBytes(dataUrl) {
  const comma = dataUrl.indexOf(',');
  if (comma < 0 || !dataUrl.slice(0, comma).includes(';base64')) {
    throw new Error('地形必须保存为 base64 PNG dataURL');
  }
  const bin = atob(dataUrl.slice(comma + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes) {
  let bin = '';
  // 分块拼接，避免 apply 的参数个数超出上限
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
