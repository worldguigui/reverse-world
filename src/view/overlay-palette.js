/**
 * 球面叠加层的语义配色。
 * 颜色只表达状态，不按每条内容随机分配：普通路线与区域共用低饱和灰金，
 * 选中的那条统一用界面的铜橙；地形本身仍保留真实地球的自然色彩。
 */
export const OVERLAY_BASE = '#b5a17b';   // 普通路线、区域填充
export const OVERLAY_BORDER = '#a98b60'; // 区域边界
export const OVERLAY_ACTIVE = '#c56b3e'; // 选中或正在编辑
