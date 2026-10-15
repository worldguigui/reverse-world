/**
 * 材质回收桶：让「整层重建」不再触发着色器重编译。
 *
 * three 的 WebGLRenderer 用引用计数管 GL 程序：最后一个用它的材质 dispose 时，
 * 程序会被一起销毁（releaseProgram → program.destroy）。而图层整层重建是常态——
 * 图层重建、工坊提交、改配色都走这条路。旧材质一销毁，下一帧就得把同一份着色器
 * 重新编译链接一遍，实测一次几十到上百毫秒，正好压在切换的那一帧上，
 * 看上去就是「切一下卡一下」。这不是编译慢，是程序被白白回收了。
 *
 * 办法很朴素：退下来的材质不销毁，先进桶里待命；下次重建先从桶里取一个，
 * 换掉颜色/贴图接着用。只要桶里始终有一个材质活着，程序就不会被回收。
 *
 * 桶有上限——它只负责「别让程序断供」，不是无上限缓存：真超出上限的材质照旧销毁，
 * 上限本身大于零，程序就总有主。
 */

/** 默认桶容量：几十个足够撑住常用图层的规模 */
export const SPARE_LIMIT = 32;

/**
 * @param {number} limit 桶容量
 * @param {() => any} create 桶空时怎么造一个新材质（不变的那部分参数写在里面）
 */
export function createMaterialBin(limit, create) {
  const spare = [];
  return {
    /** 取一个材质：优先复用退下来的，桶空才新建 */
    take() {
      return spare.length ? spare.pop() : create();
    },
    /** 把退下来的材质放回桶里（超出容量的才真正销毁） */
    put(mat) {
      if (spare.length < limit) spare.push(mat);
      else mat.dispose();
    },
    /** 彻底清空（重建桶内容时用，比如换了不变参数） */
    dispose() {
      for (const mat of spare) mat.dispose();
      spare.length = 0;
    },
  };
}
