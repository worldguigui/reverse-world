/**
 * 浏览器文件辅助：与 DOM 有关、与 UI 框架无关，故不放 ui/ 也不放 core/。
 * （原 ui/dom.js 中的 pickFile / fileToDataUrl 迁到这里，main.js 与 store 动作共用。）
 * loadImage 也放这里：栅格地形与海陆掩膜都要读本地图，谁都不该依赖对方。
 */

/** 把图片地址读成 HTMLImageElement */
export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`图片加载失败：${String(src).slice(0, 64)}…`));
    img.src = src;
  });
}

/** 把图片文件缩放后读成 dataURL（限制尺寸，避免项目文件膨胀） */
export function fileToDataUrl(file, maxSide = 1024) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, maxSide / Math.max(img.width, img.height));
        if (k === 1 && file.size < 800_000) return resolve(reader.result); // 已够小，原样保存
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * k);
        canvas.height = Math.round(img.height * k);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.86));
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
