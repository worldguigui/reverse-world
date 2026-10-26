/**
 * 渲染分层编号。主循环把一帧拆成三趟画，靠这三个层号把「画什么」分开：
 *
 *   1. LAYER_SCENE   —— 球体、大气、星空、光照，正常写颜色与深度
 *   2. LAYER_MASK    —— 过球心、正对相机的平面，只写深度不写颜色
 *   3. LAYER_CONTENT —— 事件 / 路线 / 区域，对第二趟留下的深度做测试
 *
 * 于是内容不会被鼓起来的山挡住，转到球背面时又会被平面挡住；
 * 近半球的内容可以待在半径 1 以内，贴到海平面以下的凹陷上。
 * 三处必须一致：globe 建掩膜平面、三个内容层给对象打标、main.js 按层渲染。
 */

export const LAYER_SCENE = 0;   // 默认层
export const LAYER_MASK = 1;    // 深度掩膜平面
export const LAYER_CONTENT = 2; // 事件 / 路线 / 区域
