/**
 * 浏览器文件辅助：与 DOM 有关、与 UI 框架无关，故不放 ui/ 也不放 core/。
 * （原 ui/dom.js 中的 pickFile / fileToDataUrl 迁到这里，main.js 与 store 动作共用。）
 * loadImage 也放这里：栅格地形与海陆掩膜都要读本地图，谁都不该依赖对方。
 */
import { IMAGE_UPLOAD } from '../config.js';

/** 把图片地址读成 HTMLImageElement */
export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`图片加载失败：${String(src).slice(0, 64)}…`));
    img.src = src;
  });
}

/**
 * 盒式平均降采样：把源图按 blockSize×blockSize 分块，每块内取平均。
 * 颜色按 alpha 加权：全透明像素不参与配色，否则透明区常见的黑色 RGB
 * 会混进图案边缘，缩小后出现一圈暗边。边缘不足一块时按实际像素数平均。
 */
export function boxFilterDownsample(srcData, blockSize) {
  const { width: sw, height: sh, data: src } = srcData;
  const dw = Math.ceil(sw / blockSize);
  const dh = Math.ceil(sh / blockSize);
  const dstData = new ImageData(dw, dh);
  const dst = dstData.data;

  for (let dy = 0; dy < dh; dy++) {
    for (let dx = 0; dx < dw; dx++) {
      const sx0 = dx * blockSize;
      const sy0 = dy * blockSize;
      const sx1 = Math.min(sx0 + blockSize, sw);
      const sy1 = Math.min(sy0 + blockSize, sh);
      let r = 0, g = 0, b = 0, aSum = 0, count = 0;

      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * sw + sx) * 4;
          const a = src[i + 3];
          r += src[i] * a; g += src[i + 1] * a; b += src[i + 2] * a;
          aSum += a;
          count++;
        }
      }

      const j = (dy * dw + dx) * 4;
      // 全透明块没有有效颜色，写 0 即可；有颜色时再按权重还原
      dst[j] = aSum ? r / aSum : 0;
      dst[j + 1] = aSum ? g / aSum : 0;
      dst[j + 2] = aSum ? b / aSum : 0;
      dst[j + 3] = aSum / count;
    }
  }
  return dstData;
}

/** 原图先交给浏览器缩到这一步再读像素：手机原图动辄几千万像素，整幅读入会占几十 MB */
const SCAN_MAX = 2048;

/**
 * 把图片文件盒式降采样后读成 dataURL。
 * 配图只在小面板里显示，长边压到 maxSide 足够；输出 WebP 以控制体积并保留透明通道。
 * 超过上传上限的源文件在打开读流之前就拒绝。
 */
export function fileToDataUrl(file, maxSide = IMAGE_UPLOAD.maxSide) {
  if (file.size > IMAGE_UPLOAD.maxBytes) {
    const mb = Math.round(IMAGE_UPLOAD.maxBytes / (1024 * 1024));
    return Promise.reject(new Error(`图片不能超过 ${mb} MB`));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const maxDim = Math.max(img.width, img.height);
        const scanK = Math.min(1, SCAN_MAX / maxDim);
        const scanW = Math.max(1, Math.round(img.width * scanK));
        const scanH = Math.max(1, Math.round(img.height * scanK));

        // 先画到扫描画布再读像素；最终尺寸由盒式分块决定，长边约等于 maxSide
        const scan = document.createElement('canvas');
        scan.width = scanW;
        scan.height = scanH;
        const scanCtx = scan.getContext('2d');
        scanCtx.drawImage(img, 0, 0, scanW, scanH);

        const block = Math.max(1, Math.ceil(Math.max(scanW, scanH) / maxSide));
        const out = boxFilterDownsample(scanCtx.getImageData(0, 0, scanW, scanH), block);

        const canvas = document.createElement('canvas');
        canvas.width = out.width;
        canvas.height = out.height;
        // 直接写入平均后的 RGBA：alpha 原样保留，透明边缘不会在缩放时发黑
        canvas.getContext('2d').putImageData(out, 0, 0);
        resolve(canvas.toDataURL(IMAGE_UPLOAD.format, IMAGE_UPLOAD.quality));
      };
      img.onerror = () => reject(new Error('不是可识别的图片'));
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/** 透明的文件选择器，resolve 返回 File（取消则 null） */
export function pickFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (accept) input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}
