import { SphereShape } from './sphere-shape.js';
import { SlabShape } from './slab-shape.js';

/**
 * 形状工厂：project.shape.type → WorldShape 实例。
 * 形状实例是无状态的（SlabShape 的 _uHeightScale 是常量），所以用单例——
 * applyStage 每次 stageEpoch 都会取一次形状，单例让 globe.setShape 的
 * 同形状幂等检查（比 id）恒成立，不会在换地图时重建几何、重编译 shader。
 */
export const SPHERE_SHAPE = new SphereShape();
export const SLAB_SHAPE = new SlabShape();

/** 项目文件里合法的形状类型 */
export const SHAPE_TYPES = ['sphere', 'slab'];

/** project.shape → 形状实例；未知类型一律回落球体（旧项目与坏数据都不炸） */
export function getShapeForProject(project) {
  return project?.shape?.type === 'slab' ? SLAB_SHAPE : SPHERE_SHAPE;
}
